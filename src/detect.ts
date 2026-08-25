/**
 * Detectors.
 *
 * Each is a pure function over an `AuditContext`. They report what is measurable and
 * stay quiet otherwise -- a detector that cannot tell "absent" from "unused" returns
 * nothing rather than guessing, because a wrong finding costs more trust than a
 * missing one earns.
 */
import type {
  Workspace,
  ProjectRecord,
  McpServerSpec,
  SettingsError,
  SettingsFile,
  SettingsValidity,
} from './surfaces/types.ts';
import type { TranscriptMeasurement, ServerCost, ServerKind } from './cost/transcript.ts';
import { classifyServer, normalizeServerName } from './cost/transcript.ts';
import type { PluginCostIndex } from './cost/plugins.ts';
import type { PluginInventory } from './inventory.ts';
import type { McpEntry } from './mcp.ts';
import { buildMcpCatalog, pluginServerKey, serviceOf } from './mcp.ts';
import { resolveMcpServer, resolvePlugin, allPluginIds } from './resolve.ts';
import { RULE_ARRAYS } from './surfaces/read.ts';
import { pluginUsage, isDemonstrablyUnused } from './usage.ts';

export type Severity = 'high' | 'medium' | 'low' | 'info';

/**
 * Which signal identified two namespaces as one thing.
 *
 * `url` is exact -- two launch specs naming the same endpoint are the same access path
 * whatever they are called. `name` is inferred: `serviceOf` strips a prefix and a short
 * suffix list, which is a claim about spelling, not about the service.
 */
export type MatchBasis = 'url' | 'name';

export interface Finding {
  detector: string;
  /**
   * Stable identity for drift comparison, when one detector emits several findings
   * that are not distinguished by project. Without it, all eleven duplicate-path
   * findings shared the identity `duplicate-access-paths *`, and swapping one service
   * for another read as no change at all.
   */
  key?: string;
  /**
   * Which signal the finding rests on, for detectors that have more than one. Absent
   * where the question does not arise. A separate field rather than a nudge to
   * `severity`: severity is what it costs, basis is how well we know, and folding one
   * into the other is how a guess starts reading like a measurement.
   */
  basis?: MatchBasis;
  severity: Severity;
  title: string;
  detail: string;
  /** Absent means the finding is workspace-wide. */
  project?: string;
  /** Concrete, checkable specifics. Never prose. */
  evidence: string[];
  fix?: string;
}

export interface AuditContext {
  ws: Workspace;
  measurements: TranscriptMeasurement[];
  /** Priced on demand -- a detector that never asks for a price never pays for one. */
  pluginCosts: PluginCostIndex;
  /**
   * The single project this run is about, or null/absent for the whole workspace.
   *
   * A detector whose answer is workspace-wide by construction has nothing to say in a
   * scoped run -- the report drops such findings -- so it can decline to compute one.
   * Only the detectors whose work is expensive bother to look.
   */
  scope?: string | null;
  /** Keyed by plugin id. Empty when nothing on disk could be read. */
  inventories: Map<string, PluginInventory>;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function rank(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ---------------------------------------------------------------------------

/**
 * One service reachable through several namespaces at once.
 *
 * Same-session is the whole point. Across sessions, a connector removed in March and
 * a plugin added in June look identical to two live duplicates -- which is how an
 * earlier pass concluded Robinhood was duplicated when it never was.
 *
 * **Not made redundant by the first-party `/mcp` panel (DEA-142).** See CLAUDE.md: the
 * panel matches a connector against a user server *by URL* and hides the loser, which
 * is both narrower and stronger than this. Narrower because it does not compare two
 * plugins against each other, and every plugin-vs-plugin pair below survives it.
 * Stronger because a URL match is exact. So this reads what actually loaded, and says
 * on each finding which of the two signals fired.
 *
 * A connector the panel hid produces nothing here, and by construction rather than by
 * a rule: a hidden namespace publishes no tool names, so it never enters a transcript
 * and there is no second path to find. `test/detect.test.ts` pins that, because a
 * property nothing asserts is an accident waiting to be refactored away.
 */
export function duplicateAccessPaths(ctx: AuditContext): Finding[] {
  type Ns = { tools: number; chars: number; kind: ServerKind };
  const perService = new Map<string, { sessions: number; namespaces: Map<string, Ns> }>();
  const urls = urlIndex(ctx);
  const manual = manualNamespaces(ctx);

  for (const m of ctx.measurements) {
    const byService = new Map<string, ServerCost[]>();
    for (const s of m.servers) {
      if (s.kind === 'builtin') continue;
      const key = serviceOf(s.server);
      byService.set(key, [...(byService.get(key) ?? []), s]);
    }
    for (const [svc, list] of byService) {
      if (list.length < 2) continue;
      const acc = perService.get(svc) ?? { sessions: 0, namespaces: new Map<string, Ns>() };
      acc.sessions += 1;
      for (const l of list) {
        const prev = acc.namespaces.get(l.server) ?? { tools: 0, chars: 0, kind: l.kind };
        acc.namespaces.set(l.server, {
          tools: Math.max(prev.tools, l.tools),
          chars: Math.max(prev.chars, l.chars),
          kind: l.kind,
        });
      }
      perService.set(svc, acc);
    }
  }

  const findings = [...perService.entries()].map(([service, a]) => {
    const entries = [...a.namespaces.entries()].sort((x, y) => y[1].chars - x[1].chars);
    // The cost of duplication is what the redundant paths add, not the whole service.
    const redundantChars = entries.slice(1).reduce((n, [, v]) => n + v.chars, 0);

    // A server publishing exactly two tools is an unauthenticated stub, not a real
    // tool surface. Two stubs duplicating each other cost almost nothing.
    const stubs = entries.filter(([, v]) => v.tools <= 2).length;
    const allStubs = stubs === entries.length;

    const severity: Severity = redundantChars >= 1000 ? 'high' : redundantChars >= 200 ? 'medium' : 'low';

    /**
     * The URL signal, used in one direction only.
     *
     * Two specs naming one endpoint prove one access path, so a match upgrades the
     * claim from inferred to exact. A *mismatch* proves nothing in the other direction:
     * `amplitude` and `amplitude-eu` are one service behind two endpoints, so differing
     * URLs would suppress a real finding. It is reported and never acted on.
     */
    const known = entries
      .map(([ns]) => urls.get(ns))
      .filter((u): u is string => typeof u === 'string');
    const distinct = new Set(known);
    const basis: MatchBasis = known.length >= 2 && distinct.size === 1 ? 'url' : 'name';

    /**
     * Which of these paths arbitrates, and what that makes the others (QM-8).
     *
     * Claude Code deduplicates by launch signature and a **manually-configured** server
     * -- user scope, Local scope, or a project's own `.mcp.json` -- is the only thing on
     * the winning side of that comparison. Everything else here is a plugin or a
     * connector, which lose to it and cannot arbitrate between themselves.
     */
    const arbiters = entries.map(([ns]) => ns).filter((ns) => manual.has(ns));
    const suppressed = entries
      .filter(([ns, v]) => !manual.has(ns) && (v.kind === 'plugin' || v.kind === 'connector'))
      .map(([ns]) => ns);

    // `claude mcp remove` reaches user-scope servers and nothing else, so borrow the
    // first-party wording only where the first-party command applies.
    const removable = entries.find(([, v]) => v.kind === 'direct')?.[0];

    return {
      detector: 'duplicate-access-paths',
      key: `duplicate-access-paths ${service}`,
      basis,
      severity,
      title:
        `${service} is reachable ${entries.length} ways at once` +
        (redundantChars ? ` (+${num(redundantChars)} chars)` : ''),
      detail:
        `Live simultaneously in ${a.sessions} session${a.sessions === 1 ? '' : 's'}. ` +
        (allStubs
          ? 'All of these are unauthenticated stubs publishing a placeholder tool pair, ' +
            'so the cost is small -- but the duplication is real and will grow if they connect. '
          : 'Each publishes its own tool names into the same context. ') +
        (basis === 'url'
          ? `Matched on the launch URL these share (${[...distinct][0]}), which is exact. `
          : 'Matched on the namespace spelling, which is inferred -- no two of these ' +
            'carry a launch URL this tool can read, so nothing confirms it. ') +
        arbitration(arbiters, suppressed),
      evidence: [
        ...entries.map(
          ([ns, v]) =>
            `${ns} — ${v.tools} tools, ${num(v.chars)} chars` +
            (v.tools <= 2 ? ' (unauthenticated stub)' : '') +
            (urls.get(ns) ? ` — ${urls.get(ns)}` : ''),
        ),
        ...(distinct.size > 1
          ? [`launch URLs disagree (${[...distinct].join(' vs ')}) — the name match may have merged two services`]
          : []),
        ...(arbiters.length === 1 && suppressed.length
          ? [`${arbiters[0]} is manually-configured, so it suppresses: ${suppressed.join(', ')}`]
          : []),
      ],
      /**
       * What each action would do, never which to take (QM-8, fact-only).
       *
       * **The arbiter branch used to advise the opposite of what it should.** It printed
       * `claude mcp remove <the user-scope server>` for the one service here that has a
       * manually-configured path -- which is the path *suppressing* the other two. Removing
       * it un-suppresses them, so the advice increased what loads while reading as a
       * cleanup. Observed live on the neighbouring service: `robinhood-trading` is denied
       * for this project and `claude.ai Robinhood` is `✔ Connected` at the identical URL.
       */
      fix:
        arbiters.length === 1 && suppressed.length
          ? `${arbiters[0]} is what keeps the other ${plural(suppressed.length, 'path', `${suppressed.length} paths`)} ` +
            `suppressed. Removing or denying it (\`claude mcp remove ${arbiters[0]}\`) brings ` +
            `${andList(suppressed)} back, which increases what loads rather than ` +
            'reducing it. To drop a path instead, disable the duplicate plugin in Claude ' +
            'Code, or the connector in claude.ai.'
          : arbiters.length > 1
            ? `${arbiters.join(' and ')} are both manually-configured. The three manual ` +
              'scopes collide by name and the highest wins, so this is precedence rather ' +
              'than suppression, and both specs stay in the file.'
            : 'None of these is manually-configured, so nothing arbitrates between them. ' +
              'Disable the duplicate plugin in Claude Code, or the connector in claude.ai; ' +
              'a manually-configured server at the same URL would suppress both.',
    } satisfies Finding;
  });

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/**
 * The sentence that says which path decides, appended to every duplicate finding (QM-8).
 *
 * **Where nothing arbitrates, the honest answer has two branches and this refuses to pick
 * one.** The interactive TUI keeps `plugin:*` in the manually-configured map, so the plugin
 * beats the connector; a non-interactive run strips them and a separate pass leaves the
 * connector. Both were established in one research session on 2.1.232 -- the headless half
 * watched happening 3/3, the interactive half source-derived and corroborated by
 * `claude mcp list`. Naming a single winner would be wrong for whichever way the reader
 * launches Claude Code, and a reader on the other branch would act on it.
 */
function arbitration(arbiters: readonly string[], suppressed: readonly string[]): string {
  if (arbiters.length === 1 && suppressed.length) {
    // The whole clause is inflected, not just the noun. Inflecting the noun and leaving
    // the tail fixed is DEA-148's defect verbatim -- it produced "the other path as
    // duplicates of it" here before a one-suppressed fixture existed to say so.
    return (
      `${arbiters[0]} is manually-configured, so Claude Code suppresses ` +
      plural(
        suppressed.length,
        'the other path as a duplicate of it.',
        `the ${suppressed.length} other paths as duplicates of it.`,
      )
    );
  }
  if (arbiters.length > 1) {
    return (
      `${arbiters.length} of these are manually-configured, which collide by name rather ` +
      'than being deduplicated — the highest scope wins.'
    );
  }
  return (
    'None of these is manually-configured, so nothing arbitrates: which one loads depends ' +
    'on how Claude Code was started. An interactive session keeps the plugin; a ' +
    'non-interactive one (-p, piped output, the Agent SDK, Claude Code Desktop) keeps the ' +
    'connector.'
  );
}

/**
 * Namespaces backed by a **manually-configured** launch spec -- user scope, QM-53's Local
 * scope, or a project's own `.mcp.json`.
 *
 * Read from the catalog rather than from `ServerKind`, which the transcript reader derives
 * from the namespace *spelling*: `direct` there means "not prefixed `plugin_` or
 * `claude_ai_`", which a Local-scope server satisfies and so does anything else unprefixed.
 * This asks the config which specs exist, and the two agree on today's data only because
 * every manual server here is also user-scope.
 *
 * **Only the manual set is taken from config; the *paths* still come from transcripts.**
 * Folding config-declared paths into the finding was tried and rejected: this detector's
 * whole premise is same-session co-occurrence, because a connector removed in March and a
 * plugin added in June look identical to two live duplicates in configuration. Measured
 * while deciding it -- a config-side count reported `robinhood` as reachable two ways,
 * and `claude mcp list` shows only one of those two paths is live, the other being denied.
 * That is the exact false positive this detector's header records having already removed.
 */
function manualNamespaces(ctx: AuditContext): Set<string> {
  const out = new Set<string>();
  for (const e of buildMcpCatalog(ctx.ws, ctx.inventories).entries) {
    if (e.userScope || e.localIn.length > 0 || e.declaredIn.length > 0) {
      out.add(normalizeServerName(e.name));
    }
  }
  return out;
}

/**
 * `namespace -> launch URL`, from the two places this tool already reads a launch spec.
 *
 * Normalising forward -- config key to tool namespace -- is exact, and it is the
 * direction `mcp.ts` sanctions; reversing it is the guess it refuses. A namespace two
 * sources give different URLs for is dropped rather than picked between: nothing says
 * which spec the session loaded, and a wrong exact claim is worse than no claim.
 *
 * Two whole populations are absent by construction. A claude.ai connector is declared
 * in claude.ai, and `claudeAiMcpEverConnected` carries names only. A plugin's own
 * `.mcp.json` sits under its install path, which nothing here reads -- deliberately
 * not added, because acquiring a new source is not what DEA-142 asked for. That is the
 * day this degrades, and it degrades to exactly today's behaviour: every finding falls
 * back to the name match, where all eleven of them already are.
 */
function urlIndex(ctx: AuditContext): Map<string, string> {
  const ws = ctx.ws;
  const seen = new Map<string, Set<string>>();
  const add = (key: string, spec: McpServerSpec) => {
    if (!spec.url) return;
    const ns = normalizeServerName(key);
    const set = seen.get(ns) ?? new Set<string>();
    set.add(spec.url);
    seen.set(ns, set);
  };

  for (const [key, spec] of Object.entries(ws.claudeJson.mcpServers)) add(key, spec);
  for (const p of ws.projects) {
    if (!p.mcpJson) continue;
    for (const [key, spec] of Object.entries(p.mcpJson.mcpServers)) add(key, spec);
  }
  // QM-53's Local scope, and QM-54's plugin builds. Both were absent when the doc above
  // was written and both are now read, which is what makes `basis: url` reachable for a
  // plugin at all -- every finding on this machine rested on the name match before.
  for (const p of ws.projects) {
    for (const [key, spec] of Object.entries(p.entry?.mcpServers ?? {})) add(key, spec);
  }
  for (const inv of ctx.inventories.values()) {
    for (const [name, spec] of Object.entries(inv.mcpServerSpecs)) {
      add(pluginServerKey(inv.id, name, inv.manifestName), spec);
    }
  }

  const out = new Map<string, string>();
  for (const [ns, set] of seen) if (set.size === 1) out.set(ns, [...set][0]!);
  return out;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}


/**
 * A project restating a value it would inherit anyway. Does nothing today, and stops
 * tracking the global default the moment that default changes.
 *
 * **`round-trip` is deliberately not reported here (QM-43).** Both origins resolve to the
 * value the project would have inherited, and until that issue one comparison produced
 * both -- so this detector advised deleting entries that were the entire reason their cell
 * resolved as it did. The discriminator now lives in `resolveCell`, where the grid reads
 * it too, rather than as a second definition of "restated" kept in step by hand.
 */
export function restatedEntries(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  const ids = allPluginIds(ctx.ws, ctx.inventories);

  for (const project of ctx.ws.projects) {
    if (!project.alive) continue;
    const restated: string[] = [];
    for (const id of ids) {
      const cell = resolvePlugin(ctx.ws, project, id);
      if (cell.origin === 'restated') {
        // The *link's* value and scope, not the winner's twice over. They agree on every
        // cell this fires on today, because a `restated` chain is one where every
        // project-scope link carries the winner -- but `chain[0]` is the lowest-precedence
        // link and nothing makes it the user file, so printing `cell.value` against its
        // scope is a claim this line has no standing to make.
        const also = cell.chain[0]!;
        restated.push(`${id} = ${cell.value} (also ${also.value} at ${also.scope})`);
      }
    }
    if (!restated.length) continue;
    out.push({
      detector: 'restated-entries',
      severity: 'low',
      title: `${restated.length} plugin entr${restated.length === 1 ? 'y' : 'ies'} restate the inherited value`,
      detail:
        'These change nothing. If the global default flips, the project silently keeps ' +
        'the old value without anyone deciding to.',
      project: project.path,
      evidence: restated.slice(0, 10),
    });
  }
  return out;
}

/** Config for directories that no longer exist. */
export function orphanedProjectConfig(ctx: AuditContext): Finding[] {
  const dead = ctx.ws.projects.filter((p) => !p.alive && hasRealConfig(p));
  if (!dead.length) return [];

  const total = ctx.ws.projects.length;
  return [
    {
      detector: 'orphaned-project-config',
      severity: 'medium',
      title: `${dead.length} of ${total} project entries point at directories that are gone`,
      detail:
        'Each still carries a deny-list or tool grant that can never apply again. They ' +
        'inflate the file every session writes to.',
      evidence: dead
        .slice(0, 10)
        .map((p) => `${p.path} (${(p.entry?.disabledMcpServers ?? []).length} disabled servers)`),
      fix: 'claude project purge <path>',
    },
  ];
}

function hasRealConfig(p: ProjectRecord): boolean {
  const e = p.entry;
  if (!e) return false;
  return Boolean(
    e.disabledMcpServers?.length ||
      e.enabledMcpServers?.length ||
      e.allowedTools?.length ||
      e.enabledMcpjsonServers?.length ||
      e.disabledMcpjsonServers?.length,
  );
}

/** A global default most projects immediately override points the wrong way. */
export function invertedDefaults(ctx: AuditContext): Finding[] {
  const configured = ctx.ws.projects.filter(
    (p) => p.alive && (p.settings?.enabledPlugins || p.localSettings?.enabledPlugins),
  );

  // Below four samples this is astrology. Two projects out of three disagreeing with a
  // global default is not evidence the default is wrong, and saying so confidently is
  // exactly the kind of finding that costs the audit its credibility.
  const MIN_SAMPLES = 4;
  if (configured.length < MIN_SAMPLES) return [];

  const out: Finding[] = [];
  for (const id of allPluginIds(ctx.ws, ctx.inventories)) {
    const cells = configured.map((p) => resolvePlugin(ctx.ws, p, id));
    const overrides = cells.filter((c) => c.origin === 'overridden');
    if (overrides.length / configured.length < 0.6) continue;

    const inherited = resolvePlugin(ctx.ws, configured[0]!, id);
    out.push({
      detector: 'inverted-defaults',
      severity: 'medium',
      title: `${id} is overridden in ${overrides.length} of ${configured.length} configured projects`,
      detail:
        'When most projects that express an opinion disagree with the global default, ' +
        'the default is backwards. Flipping it removes the overrides.',
      evidence: [
        `global value: ${inherited.chain.find((l) => l.scope === 'user')?.value ?? 'unset'}`,
        `overridden in: ${overrides.length}/${configured.length} projects that configure plugins`,
      ],
    });
  }
  return out;
}

/**
 * Always-on cost against demonstrated use.
 *
 * Only fires for plugins with no hooks, because `pluginUsage.usageCount` counts hook
 * firings -- see `usage.ts`. For a hook-providing plugin, zero means nothing.
 *
 * The order of the tests is load-bearing rather than stylistic. A price is a
 * subprocess; enablement is already in memory. Asking the cheap question first is what
 * keeps an audit from pricing plugins it is about to discard -- the same set either
 * way, just without paying for the ones that could never have qualified.
 */
export function costWithoutUse(ctx: AuditContext): Finding[] {
  // Workspace-wide by construction: it ranks plugins against every live project, so a
  // scoped run drops the finding on the floor. Computing it anyway would spend ~0.6s
  // per plugin on an answer the report never prints.
  if (ctx.scope) return [];

  const unused: Array<{ id: string; tokens: number; components: string; projects: number }> = [];
  const live = ctx.ws.projects.filter((p) => p.alive);

  for (const id of allPluginIds(ctx.ws, ctx.inventories)) {
    // A disabled plugin costs nothing, so "unused and expensive" does not apply to it.
    // Without this the report lists globally-disabled plugins as if they were a bill.
    const enabledIn = live.filter((p) => resolvePlugin(ctx.ws, p, id).value).length;
    if (enabledIn === 0) continue;

    const cost = ctx.pluginCosts.get(id);
    if (!cost || !Number.isFinite(cost.alwaysOnTokens) || cost.alwaysOnTokens <= 0) continue;

    const hooks = cost.counts['Hooks'] ?? null;
    const reading = pluginUsage(ctx.ws, id, hooks);
    if (!isDemonstrablyUnused(reading)) continue;

    unused.push({
      id,
      tokens: cost.alwaysOnTokens,
      projects: enabledIn,
      components:
        Object.entries(cost.counts)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ') || 'none',
    });
  }

  if (!unused.length) return [];
  unused.sort((a, b) => b.tokens - a.tokens);

  // One ranked finding rather than one per plugin: the decision is "which of these do
  // I keep", and that is a comparison, not twenty separate verdicts.
  const total = unused.reduce((n, u) => n + u.tokens, 0);
  return [
    {
      detector: 'cost-without-use',
      severity: total >= 1000 ? 'high' : 'medium',
      title:
        unused.length === 1
          ? `1 enabled plugin costs ~${num(total)} tok per session and has never been invoked`
          : `${unused.length} enabled plugins cost ~${num(total)} tok per session and have never been invoked`,
      detail:
        'Each is enabled in at least one live project and provides no hooks, so its usage ' +
        'counter is a true invocation count and zero means zero. Ranked by what disabling ' +
        'would save.',
      evidence: unused.map(
        (u) => `~${num(u.tokens)} tok  ${u.id}  (${u.components}; on in ${u.projects} project${u.projects === 1 ? '' : 's'})`,
      ),
      fix: 'Disable globally and enable per project where wanted.',
    },
  ];
}

/** The skill listing is large and nothing scopes it. */
export function unscopedSkills(ctx: AuditContext): Finding[] {
  const anyOverride = [ctx.ws.userSettings, ...ctx.ws.projects.flatMap((p) => [p.settings, p.localSettings])]
    .some((f) => f?.skillOverrides && Object.keys(f.skillOverrides).length > 0);
  if (anyOverride) return [];

  const listings = ctx.measurements
    .map((m) => m.blocks.find((b) => b.kind === 'skill_listing'))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  if (!listings.length) return [];

  const peak = listings.reduce((a, b) => (a.chars > b.chars ? a : b));
  return [
    {
      detector: 'unscoped-skills',
      severity: peak.chars > 20_000 ? 'high' : 'medium',
      title: `The skill listing reaches ${peak.chars.toLocaleString()} chars and no project scopes it`,
      detail:
        '`skillOverrides` gives four states per skill -- on, name-only, ' +
        'user-invocable-only, off -- and is set nowhere in this workspace. Every skill ' +
        'is fully listed in every project.',
      evidence: [
        `peak listing: ${peak.chars.toLocaleString()} chars across ${peak.items} skills`,
        `sessions measured: ${listings.length}`,
        'skillOverrides keys found: 0',
      ],
      fix: 'Press Space in the /skills menu to cycle a skill\'s state; it writes to .claude/settings.local.json.',
    },
  ];
}

/** `@path` imports load at launch, so they never defer anything. */
export function importsDoNotDefer(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  for (const p of ctx.ws.projects) {
    const md = p.claudeMd;
    if (!md?.imports.length) continue;
    out.push({
      detector: 'imports-do-not-defer',
      severity: 'low',
      title: `CLAUDE.md imports ${md.imports.length} file${md.imports.length === 1 ? '' : 's'}`,
      detail:
        'Imports help organisation but not context: imported files load at launch, so ' +
        'splitting a file saves nothing. Path-scoped rules in .claude/rules/ are the ' +
        'mechanism that actually defers loading.',
      project: p.path,
      evidence: md.imports.slice(0, 8).map((i) => `@${i}`),
    });
  }
  return out;
}

/** Path-scoped rules are the sanctioned way to defer, and adoption is zero. */
export function noPathScopedRules(ctx: AuditContext): Finding[] {
  const anyRules =
    ctx.ws.userRules.length > 0 || ctx.ws.projects.some((p) => p.rules.length > 0);
  if (anyRules) return [];

  const big = ctx.ws.projects.filter((p) => p.alive && (p.claudeMd?.lines ?? 0) > 200);
  if (!big.length) return [];

  return [
    {
      detector: 'no-path-scoped-rules',
      severity: 'medium',
      title:
        big.length === 1
          ? 'A CLAUDE.md exceeds 200 lines and no .claude/rules/ exists anywhere'
          : `${big.length} CLAUDE.md files exceed 200 lines and no .claude/rules/ exists anywhere`,
      detail:
        'A rule with `paths:` frontmatter loads only when Claude touches a matching ' +
        'file. It is the only sanctioned way to cut always-on instruction cost.',
      evidence: big.slice(0, 8).map((p) => `${p.path} (${p.claudeMd!.lines} lines)`),
    },
  ];
}

/**
 * Does this deny rule remove a tool definition from the system prompt?
 *
 * A bare name does, and that invalidates the prompt cache. A scoped rule like
 * `Bash(rm *)` does not. An `mcp__<server>__<tool>` rule already names exactly one tool
 * -- MCP tools have no `Tool(pattern)` form to scope down to, so there is nothing to
 * fix. Flagging them told the user to "scope" the rules that stop Claude placing trades.
 *
 * Exported because `effect.ts` asks the same question of a *staged* rule that this asks
 * of a written one, and two copies of the predicate drift the moment either is edited
 * -- the reasoning that keeps the Blocking/Gap/Polish rubric in one place.
 *
 * `rule` really is a string, and that is `readSettings`'s promise rather than this
 * function's guess (DEA-150). JSON let a number into `permissions.deny` and killed both
 * callers here with `rule.includes is not a function`; the narrowing went into the reader
 * so this predicate stayed one predicate. Do not re-check the type here -- a second guard
 * would move the invariant to two places and hide which one owns it.
 */
export function isBareDenyRule(rule: string): boolean {
  return !rule.includes('(') && rule.trim() !== '' && !rule.startsWith('mcp__');
}

/**
 * A bare tool name in a deny rule removes the tool from the system prompt and
 * invalidates the prompt cache. A scoped rule like `Bash(rm *)` does not.
 */
export function bareDenyRules(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];

  const check = (path: string, deny: string[] | undefined, project?: string) => {
    const bare = (deny ?? []).filter(isBareDenyRule);
    if (!bare.length) return;
    out.push({
      detector: 'bare-deny-rules',
      severity: 'medium',
      title: `${bare.length} deny rule${bare.length === 1 ? '' : 's'} name a tool without scoping it`,
      detail:
        'A bare name removes the tool definition from the system prompt, which ' +
        'invalidates the prompt cache. Scoping the rule keeps the cache intact.',
      ...(project ? { project } : {}),
      evidence: bare.map((r) => `"${r}" in ${path}`),
      fix: 'Scope the rule, e.g. "Bash" -> "Bash(rm *)".',
    });
  };

  check(ctx.ws.userSettings?.path ?? '~/.claude/settings.json', ctx.ws.userSettings?.permissions?.deny);
  for (const p of ctx.ws.projects) {
    if (p.settings) check(p.settings.path, p.settings.permissions?.deny, p.path);
    if (p.localSettings) check(p.localSettings.path, p.localSettings.permissions?.deny, p.path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// discarded-settings (DEA-148)
// ---------------------------------------------------------------------------

/**
 * Every settings file the workspace holds, once each, with the project it speaks for.
 *
 * The dedup is the `~` trap in its third layer. `~` is a registered project whose
 * `.claude/settings.json` *is* `~/.claude/settings.json`, so an undeduplicated walk
 * yields that file twice -- which `contributingFiles` needed for `restated` and
 * `effectReportFor` needed for its deny-rule tally, and which here would report one
 * voided file as two and count its entries twice. User scope is pushed first so the
 * shared file is attributed to the scope it actually is.
 *
 * Shared by the detector and the run's tally rather than copied into each, for the
 * reason `isBareDenyRule` is shared with `effect.ts`: two walks over the same files
 * disagree the moment either is edited, and the disagreement would be between the
 * findings and the line saying how many files they were drawn from.
 */
export function settingsFiles(ws: Workspace): Array<{ file: SettingsFile; project?: string }> {
  const out: Array<{ file: SettingsFile; project?: string }> = [];
  const seen = new Set<string>();

  const push = (file: SettingsFile | null, project?: string) => {
    if (!file || seen.has(file.path)) return;
    seen.add(file.path);
    out.push({ file, ...(project ? { project } : {}) });
  };

  push(ws.userSettings);
  for (const p of ws.projects) {
    push(p.settings, p.path);
    push(p.localSettings, p.path);
  }
  return out;
}

/**
 * How many settings files are in each state, for the run to report.
 *
 * **Not a finding, and deliberately not routed through one** -- the same call DEA-140's
 * `initialised` field made. It has no severity and says nothing about the configuration;
 * it says what this run looked at. And it has to be said, because validity costs one
 * `claude doctor` spawn per project and lives behind `--full`: on a default run every
 * file is `not-checked`, this detector emits nothing, and nothing emitted must not read
 * as nothing wrong.
 */
export function settingsValidityTally(ws: Workspace): Record<SettingsValidity, number> {
  const tally: Record<SettingsValidity, number> = {
    accepted: 0,
    'field-dropped': 0,
    discarded: 0,
    'not-checked': 0,
  };
  for (const { file } of settingsFiles(ws)) tally[file.validity] += 1;
  return tally;
}

/**
 * Files `claude doctor` reported on and the classifier could not place (DEA-151).
 *
 * `not-checked` covers two situations that look identical in a tally and are not: nothing
 * was measured, and something was measured that means nothing to us. Only the second
 * carries schema errors, and only the second is *news* -- it is a first-party message
 * that has never been seen here, which is the event that has to reach a human, because
 * the classifier's chosen failure direction is to lose a detection rather than fabricate
 * one and losing it silently would make that choice unaccountable.
 *
 * Not a finding, for `settingsValidityTally`'s reason: it has no severity and it describes
 * what this run could interpret, not what the configuration is. Empty on every machine
 * whose `doctor` output this release already understands -- which today is all of them.
 */
export function unclassifiedSettings(ws: Workspace): SettingsFile[] {
  return settingsFiles(ws)
    .map(({ file }) => file)
    .filter((f) => f.validity === 'not-checked' && f.schemaErrors.length > 0);
}

/**
 * The decisions a settings file carries that this audit models, by key.
 *
 * Four keys and not five: `permissions` is a decision too, but it is counted in rules
 * rather than entries and `effect.ts` owns what a rule costs. Mixing the two into one
 * number would make the headline figure -- the thing that makes the severity legible --
 * a sum of units.
 */
function decisionsIn(file: SettingsFile): Array<{ key: string; entries: number }> {
  const counts = [
    { key: 'enabledPlugins', entries: Object.keys(file.enabledPlugins ?? {}).length },
    { key: 'skillOverrides', entries: Object.keys(file.skillOverrides ?? {}).length },
    { key: 'enabledMcpjsonServers', entries: (file.enabledMcpjsonServers ?? []).length },
    { key: 'disabledMcpjsonServers', entries: (file.disabledMcpjsonServers ?? []).length },
  ];
  return counts.filter((c) => c.entries > 0);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** `a`, `a and b`, `a, b and c` -- so a three-item list does not read with two "and"s. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * A settings file Claude Code refuses, and everything in it that is consequently dead.
 *
 * True by definition and invisible without a tool, which is the bar this audit sets: the
 * first-party validator reported the file, and an error carrying no `This field was
 * ignored.` note means the file is dropped whole. The project then silently runs whatever
 * the remaining scopes say -- for a project file, the global set -- while every line in
 * it reads as decisive to anyone opening it.
 *
 * **`field-dropped` is not reported here, and that is a decision rather than an
 * oversight.** Such a file keeps every key but the one that failed, so it is live config;
 * calling it discarded would report working overrides as void, which is the cry-wolf
 * direction DEA-123 and DEA-147 both exist to prevent. What it costs is a different
 * finding with a different unit -- the entries under the dropped key, not the file -- and
 * the sharp case is a dropped `permissions` block, whose deny rules are not in force
 * while `effect.ts` still classifies them `reload`. That case is its own issue, filed
 * separately; a reader who finds an ignored `permissions` block and no finding here is
 * looking at a scope boundary, not a miss. `test/discarded-settings.test.ts` fails if
 * this detector ever starts reporting one.
 *
 * `not-checked` produces nothing either, for the opposite reason: nothing was measured.
 * The run says how many files it did not look at, as a property of the run rather than
 * as a finding -- see `settingsValidityTally`.
 */
export function discardedSettings(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];

  for (const { file, project } of settingsFiles(ctx.ws)) {
    if (file.validity !== 'discarded') continue;

    const decisions = decisionsIn(file);
    const entries = decisions.reduce((n, d) => n + d.entries, 0);
    const name = file.path.split('/').at(-1)!;

    out.push({
      detector: 'discarded-settings',
      key: `discarded-settings ${file.path}`,
      severity: 'high',
      title:
        `Claude Code discards ${name}` +
        (entries
          ? `, so ${entries} ${plural(entries, 'entry', 'entries')} in it never ` +
            `${plural(entries, 'applies', 'apply')}`
          : ' entirely'),
      detail:
        'The first-party validator reports this file against Claude Code\'s schema, and ' +
        'the error carries no note saying only the field was ignored -- so the file is ' +
        'dropped whole, not one key. Everything it decides falls back to the scopes ' +
        'below it, which for a project file is the global set, and nothing in the file ' +
        'says so.',
      ...(project ? { project } : {}),
      evidence: [
        file.path,
        // Verbatim, both halves. The key is what the user has to go and fix, and a
        // paraphrase of a schema message is a second opinion about a schema we do not own.
        ...file.schemaErrors.flatMap((e) => [`${e.key}: ${e.message}`, ...e.notes.map((n) => `  ${n}`)]),
        ...decisions.map((d) => `${d.key}: ${d.entries} ${plural(d.entries, 'entry', 'entries')} not in effect`),
      ],
      fix:
        'claude doctor — run it in that directory. It is the check that reported this, ' +
        'it names the key, and where it has one it prints its own suggested fix (quoted above).',
    });
  }

  return out;
}

/**
 * What one partial acceptance cost, in the unit that error is measured in (DEA-149).
 *
 * Three units, because Claude Code has three ways of keeping a file and dropping part of
 * it, and they are not one thing counted differently. `field` is the whole key: it is
 * gone, and there is no number, because `hooks: 42` had no entries to lose -- the value
 * that failed the schema *is* the thing that went. `elements` is `n` values out of an
 * array whose survivors are still in force, so the number is the finding.
 *
 * `entry` is one named entry of a record -- `hooks.PreToolUse`,
 * `extraKnownMarketplaces.<id>` -- and it carries **no number, because none was measured**
 * (DEA-152). That is not `field`'s reason, and collapsing the two would lose the
 * difference: a field drop has no number *by construction*, an entry drop has one nobody
 * has taken. Nothing here establishes what a dropped hook event or a dropped marketplace
 * decides, so the finding names the key and stops -- `Claude Code ignores hooks.PreToolUse
 * in settings.json` is true and complete without a figure, and a figure whose unit nobody
 * measured is worse than none.
 *
 * Folding any two of them into one figure leaves only the file to count, which prices a
 * dropped `hooks` at whatever unrelated plugins the file happens to enable. That is the
 * generalisation DEA-147 had to correct, arriving one layer down.
 */
type DropCost =
  | { unit: 'field' }
  | { unit: 'entry' }
  | { unit: 'elements'; removed: number; kept: number };

/**
 * The cost of one error against a file Claude Code kept.
 *
 * `null` for anything else -- a `file` error belongs to `discardedSettings`, and an
 * `unknown` one belongs to nobody, which is `unclassifiedSettings`' whole subject.
 *
 * The unit comes from the *message family* and the number from the *file*, and it has to
 * be that way round: `doctor` prints one entry per array however many elements it removed,
 * and the reader is the only layer that still sees the elements at all (`ruleStrings`
 * removes them). So this is a join, not a reading -- first-party says an array lost
 * something, `droppedRuleElements` says how much.
 */
function dropCost(file: SettingsFile, error: SettingsError): DropCost | null {
  if (error.costs === 'field') return { unit: 'field' };
  if (error.costs === 'entry') return { unit: 'entry' };
  if (error.costs !== 'elements') return null;

  // The survivors, by the same dotted key. `RULE_ARRAYS` is imported rather than
  // respelled: the reader is what makes "everything left in this array is a string" true,
  // and a second list of which arrays those are would be a second thing to keep in step.
  const array = RULE_ARRAYS.find((k) => error.key === `permissions.${k}`);
  return {
    unit: 'elements',
    removed: file.droppedRuleElements[error.key] ?? 0,
    kept: array ? (file.permissions?.[array] ?? []).length : 0,
  };
}

/**
 * A field Claude Code read, rejected, and dropped, in a file it otherwise applies.
 *
 * True by definition and invisible without a tool, which is the bar: the first-party
 * validator reported the key, and the message says the file survived. Nothing else says
 * so. The file reads as decisive to anyone opening it, `claude doctor` mentions it once at
 * startup-adjacent moments nobody is watching, and the dropped key goes on looking like
 * configuration.
 *
 * **Its own detector, not a branch of `discardedSettings` (DEA-148).** That one reports a
 * file that is gone; this one reports live config with a hole in it, and the two cannot
 * share a cost unit, a severity or a sentence. `test/discarded-settings.test.ts` goes red
 * if a `field-dropped` file ever appears there, and `test/dropped-field.test.ts` goes red
 * if a `discarded` one appears here. The seam is asserted from both sides.
 *
 * **Flat severity, with the key in the evidence, and the evidence settles it (DEA-149).**
 * The issue offered a small per-key ranking -- `permissions` high because a deny rule is a
 * security control, everything else medium -- or flat severity. Measured across thirteen
 * malformed shapes on 2.1.222 and again on 2.1.224, `permissions` never drops as a *field*:
 * every malformed shape of it refuses the file whole, and the one partial acceptance it has
 * removes non-string elements whose survivors stay in force. So the whole-field drop has
 * exactly one reachable key, `hooks`, and nothing security-relevant is droppable at all. A
 * ranking over a set of size one is a rubric invented to look principled, which is the
 * thing this repo delegates rather than writes.
 *
 * DEA-152 added two keys to that set -- `hooks.<Event>` and `extraKnownMarketplaces.<id>`,
 * both entry drops -- and the conclusion is unchanged for the reason that produced it
 * rather than by inheritance: neither is a security control, and `permissions` still
 * refuses the file whole in every shape measured, so there is still nothing here to rank
 * *by*. A ranking would be reporting how alarming this repo finds a key.
 *
 * **The two silences are not the same silence.** This says nothing when no field was
 * dropped, and it says nothing when a dropped field's message matched neither family --
 * `costOf` returns `unknown`, `validityOf` returns `not-checked`, and the file never
 * reaches here. Only the second is a failure, and it is `unclassifiedSettings` that reports
 * it, in the run's text and its JSON. A second recogniser here would be a second thing to
 * keep in step with first-party prose that has already moved twice.
 */
export function droppedSettingsField(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];

  for (const { file, project } of settingsFiles(ctx.ws)) {
    if (file.validity !== 'field-dropped') continue;
    const name = file.path.split('/').at(-1)!;

    for (const error of file.schemaErrors) {
      const cost = dropCost(file, error);
      if (!cost) continue;

      out.push({
        detector: 'dropped-settings-field',
        key: `dropped-settings-field ${file.path} ${error.key}`,
        severity: 'medium',
        // `field` and `entry` share a sentence, and the key is what tells them apart --
        // `hooks` against `hooks.PreToolUse`. Both say the same true thing about the file
        // and neither carries a figure, so a second phrasing would only be a second
        // sentence to keep true. Where they differ is what was *lost*, and that is the
        // evidence line below.
        title:
          cost.unit === 'elements'
            ? `Claude Code removes ${cost.removed} ${plural(cost.removed, 'value', 'values')} ` +
              `from ${error.key} in ${name}, ` +
              (cost.kept
                ? `leaving ${cost.kept} ${plural(cost.kept, 'rule', 'rules')} in force`
                : 'leaving none in force')
            : `Claude Code ignores ${error.key} in ${name}, and applies the rest of the file`,
        detail:
          'The first-party validator reports this key, and says the file survived it -- so ' +
          'everything else in the file applies and this one part does not. Nothing at the ' +
          'point of use says so: the key is still written down, and the only place it is ' +
          'reported is the command that was asked here.',
        ...(project ? { project } : {}),
        evidence: [
          file.path,
          // Verbatim, both halves, for `discardedSettings`' reason: a paraphrase of a
          // schema message is a second opinion about a schema this repo does not own.
          `${error.key}: ${error.message}`,
          ...error.notes.map((n) => `  ${n}`),
          cost.unit === 'field'
            ? `${error.key}: the whole field is not in effect`
            : cost.unit === 'entry'
              ? // The unit that carries no number, saying so rather than omitting it
                // quietly. What a dropped hook event or marketplace decides is unmeasured
                // (DEA-152), and a reader who cannot see that a figure was withheld cannot
                // tell it apart from one that was zero.
                `${error.key}: this entry is not in effect, and what it cost is not measured`
              : `${error.key}: ${cost.removed} of ${cost.removed + cost.kept} ` +
                `${plural(cost.removed + cost.kept, 'value', 'values')} removed, ` +
                `${cost.kept} still in force`,
        ],
        fix:
          'claude doctor — run it in that directory. It is the check that reported this, ' +
          'and it names the key and what it rejected.',
      });
    }
  }

  return out;
}

/** Auto-memory over the load limit is silently truncated. */
export function oversizedMemory(ctx: AuditContext): Finding[] {
  return ctx.ws.projects
    .filter((p) => p.memory && (p.memory.overLineLimit || p.memory.overByteLimit))
    .map((p) => ({
      detector: 'oversized-memory',
      severity: 'medium' as Severity,
      title: 'MEMORY.md exceeds what loads at session start',
      detail:
        'Only the first 200 lines or 25KB load, whichever comes first. Everything past ' +
        'that is on disk but never read.',
      project: p.path,
      evidence: [
        `${p.memory!.lines} lines (limit 200)`,
        `${(p.memory!.bytes / 1024).toFixed(1)}KB (limit 25KB)`,
        p.memory!.path,
      ],
    }));
}

/**
 * A source enumerating components that are not installed.
 *
 * This is a fact, not a judgement: the source names a component, and no file of that
 * name exists anywhere under the plugin's `installPath`. Whether the source or the
 * install is the stale one is not decided here -- only that they describe different
 * things, which means any count derived from the source is a count of something else.
 *
 * Deliberately one-directional; `inventory.ts` explains why the reverse is not
 * measurable. And a plugin no source covers is never folded into the agreeing set --
 * `not compared` and `agrees` are the two answers most easily confused, and collapsing
 * them turns nine unexamined plugins into nine clean ones.
 */
export function inventoryMismatch(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];
  let agree = 0;
  let disagree = 0;
  let uncomparable = 0;

  for (const inv of [...ctx.inventories.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!inv.installed || !inv.enumerated.length) {
      uncomparable++;
      continue;
    }

    const installed = new Set(inv.installed);
    let mismatched = false;

    for (const src of inv.enumerated) {
      const missing = src.names.filter((n) => !installed.has(n));
      if (!missing.length) continue;
      mismatched = true;

      // Same version string either side of a republish is the mechanism that hides
      // this: nothing about the version number says the builds differ, so only the
      // sha does.
      const sameVersion = Boolean(src.version && inv.version && src.version === inv.version);
      const shasDiffer = Boolean(src.sha && inv.sha && src.sha !== inv.sha);

      out.push({
        detector: 'inventory-mismatch',
        key: `inventory-mismatch ${inv.id} ${src.source}`,
        severity: 'low',
        title:
          `${src.source} lists ${missing.length} component${missing.length === 1 ? '' : 's'} ` +
          `for ${inv.id} that ${missing.length === 1 ? 'is' : 'are'} not installed`,
        detail:
          `It enumerates ${src.names.length} component${src.names.length === 1 ? '' : 's'}; ` +
          `${src.names.length - missing.length} of those exist under the install path. ` +
          (shasDiffer && sameVersion
            ? 'Both builds call themselves the same version, so nothing but the commit ' +
              'sha distinguishes them and no update prompt fires. '
            : '') +
          'Any token figure taken from this source is a figure for a build that is not ' +
          'the one loading.',
        evidence: [
          `not installed: ${missing.slice(0, 8).join(', ')}` +
            (missing.length > 8 ? `, …and ${missing.length - 8} more` : ''),
          `installed components found: ${inv.installed.length}`,
          `installed build: ${inv.version ?? 'unknown version'} ${inv.sha ? `(${inv.sha.slice(0, 8)})` : '(no sha recorded)'}`,
          `source describes: ${src.version ?? 'unknown version'} ${src.sha ? `(${src.sha.slice(0, 8)})` : '(no sha recorded)'}` +
            (src.fetchedAt ? `, fetched ${src.fetchedAt.slice(0, 10)}` : ''),
          inv.installPath ?? 'install path unknown',
        ],
        fix: `claude plugin update ${inv.id.split('@')[0]} — then re-check, or treat \`claude plugin details\` as the only current source.`,
      });
    }

    if (mismatched) disagree++;
    else agree++;
  }

  // Silence when every plugin could be compared: the mismatch findings then already say
  // everything, and a coverage note nobody needs is noise. When some could not be, the
  // report has to say so or it reads as full coverage it does not have.
  if (uncomparable > 0) {
    const total = agree + disagree + uncomparable;
    out.push({
      detector: 'inventory-mismatch',
      key: 'inventory-mismatch coverage',
      severity: 'info',
      title: `${uncomparable} of ${total} installed plugins could not be checked against any enumerating source`,
      detail:
        'No source enumerates these, so nothing about them was verified. That is not the ' +
        'same as agreeing, and they are excluded from both counts above.',
      evidence: [
        `agree: ${agree}`,
        `disagree: ${disagree}`,
        `could not compare: ${uncomparable}`,
        ...[...ctx.inventories.values()]
          .filter((i) => !i.installed || !i.enumerated.length)
          .map((i) => i.id)
          .sort()
          .slice(0, 8)
          .map((id) => `  ${id}`),
      ],
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// never-observed-server (DEA-130)
// ---------------------------------------------------------------------------

/**
 * Why an absence proves nothing.
 *
 * Each of these is a way a server can be missing from every session and still not be
 * unused, and each has to read as "could not tell" rather than as a zero. That is the
 * `pluginUsage.usageCount` rule from CLAUDE.md -- an absent signal is not a zero --
 * applied to a set of sessions instead of to a counter.
 *
 * - `no-sessions`        nothing was measured where this server could have loaded.
 * - `no-tool-name-block` sessions were measured and none carried a tool-name block, so
 *                        nothing about any server was observable in them. Note that
 *                        `measureTranscript` drops a zero-char block, which collapses
 *                        "no block" and "an empty block" into this one answer -- the
 *                        conservative direction, and the reason it is not split.
 * - `inexact-join`       the config key does not join onto a transcript namespace
 *                        reliably. See `joinIsExact`.
 * - `age-unproven`       nothing shows the server existed before the sessions did, so
 *                        its absence may be chronology. Covers both halves: a server
 *                        datably newer than every observable session, and one nothing
 *                        can date at all.
 */
export type UnobservedReason =
  | 'no-sessions'
  | 'no-tool-name-block'
  | 'inexact-join'
  | 'age-unproven';

export interface ServerObservation {
  /** The config key, in the form a deny-list entry would use. */
  name: string;
  kind: ServerKind;
  /**
   * Sessions the verdict rests on: reachable, carrying a tool-name block, and no older
   * than the configuration. Zero whenever the verdict is `cannot-tell`, because the
   * sample is exactly what is missing then.
   */
  sessions: number;
  verdict: 'appeared' | 'never-appeared' | 'cannot-tell';
  /** Null unless `verdict` is `cannot-tell`. */
  reason: UnobservedReason | null;
  /** Reachable sessions dropped for carrying no tool-name block. */
  unobservable: number;
  /** When the configuration can be dated, in epoch ms. Null when nothing dates it. */
  configuredAt: number | null;
  /**
   * Projects whose `.mcp.json` declares it, carried through from the catalog rather than
   * recomputed. Asking "does this project's `.mcp.json` name it" a second time is a
   * second copy of a predicate `buildMcpCatalog` already owns.
   */
  declaredIn: string[];
}

/**
 * Does a config key join onto the namespace a transcript records, or is the join a guess?
 *
 * The whole verdict rests here, so it is measured rather than asserted. `view/model.ts`
 * says the join "is exact for two of the four server kinds"; checked against this
 * machine, it is exact for one.
 *
 * - `direct`    **exact.** The key in `~/.claude.json` -> `mcpServers`, or in a project's
 *               `.mcp.json`, *is* the namespace. All 8 direct keys here (`linkedin`,
 *               `robinhood-trading`, `raindrop`, `linear-server`, `n8n`, `logic-pro`,
 *               `deepgram-docs`, `greptile`) are plain identifiers that `normalizeServerName`
 *               leaves untouched, and the 7 that ever loaded published under exactly that
 *               spelling. The day it fails: a direct key carrying `:`, ` ` or `.` relies
 *               on the forward map, which is verified for status-list names and for no
 *               direct key, because this machine has none.
 * - `connector` **a guess.** `claude.ai Linear` publishes as `claude_ai_Linear` *or* as a
 *               bare UUID carrying no name at all -- 31 of the namespaces observed here
 *               are UUIDs, and nothing on disk maps one back to a connector name.
 * - `plugin`    **still a guess, and no longer for the reason it was.** It used to be
 *               `plugin:<marketplace id>:<server>` against a namespace Claude Code builds
 *               from the plugin's *manifest* name, which cost this detector precisely the
 *               server it would otherwise have accused: `notion@claude-plugins-official`
 *               says `"name": "Notion"` and publishes `plugin_Notion_notion`. DEA-145
 *               reads the manifest, so the spelling is now right where a manifest can be
 *               read -- 40 of the 42 plugins here -- and `McpEntry.keyBasis` says which
 *               rows those are.
 * - `builtin`   unreachable. `(built-in)` is the pseudo-namespace `transcript.ts` gives a
 *               deferred tool that is not an MCP tool at all, and no config key produces
 *               it.
 *
 * Used in one direction only -- the asymmetry `duplicateAccessPaths` applies to its URL
 * signal, for the same reason. A guessed name that *matches* still settles an appearance:
 * a hit is evidence the server was there. A guessed name that misses is not evidence it
 * was absent, so it can never support an accusation.
 *
 * **`plugin` was deliberately not promoted with the key (DEA-145), and the reason is
 * measured.** Two independent guards keep a plugin-provided server out of an accusation:
 * this join, and `configuredAt`, which for a plugin-provided key finds neither a user
 * scope nor a project `.mcp.json` to date it by, returns `null`, and so lands on
 * `age-unproven`. Promoting the join alone therefore moves rows from one way of saying
 * "could not tell" to another, and leaves one guard where there were two -- so the next
 * unrelated change to dating turns an absence into an accusation with nothing left to
 * stop it. Measured after the key was fixed: all 6 plugin rows on that machine read
 * `appeared`, and no observation of any kind reads `cannot-tell`, so promotion is
 * unobservable there as well as unsafe. It needs `installedAt` from
 * `installed_plugins.json` first. And the predicate would have to change shape:
 * exactness is now per *entry* rather than per kind, since a plugin whose manifest could
 * not be read is still the old guess, and `keyBasis` is the field that already knows.
 */
function joinIsExact(kind: ServerKind): boolean {
  return kind === 'direct';
}

/**
 * Every namespace one session can be said to have seen.
 *
 * Not just published tool names. An unauthenticated server has no tool list to publish
 * (`transcript.ts`), and one still connecting has not published yet -- both are named in
 * the startup record all the same. Counting only tool names would accuse every server
 * that asked the user to log in, which is 31 of them here.
 */
function namespacesSeen(m: TranscriptMeasurement): Set<string> {
  const out = new Set<string>();
  for (const s of m.servers) out.add(s.server);
  for (const s of m.needsAuth) out.add(normalizeServerName(s));
  for (const s of m.pending) out.add(normalizeServerName(s));
  return out;
}

/**
 * Live projects a session could have loaded this server in.
 *
 * The three provisioning routes reach different sets, and folding them into one would
 * make the sample count a fiction: a user-scope launch spec reaches every project, a
 * project's `.mcp.json` reaches only that project, and a plugin's server reaches wherever
 * `resolvePlugin` says the plugin is on. `greptile` is declared by one project out of 27,
 * and "absent from 479 sessions" would be a sentence about the other 26.
 */
function reachableProjects(ctx: AuditContext, entry: McpEntry): Set<string> {
  const provisioned = ctx.ws.projects.filter(
    (p) =>
      p.alive &&
      (entry.userScope ||
        entry.declaredIn.includes(p.path) ||
        (entry.fromPlugin !== null && resolvePlugin(ctx.ws, p, entry.fromPlugin).value)),
  );

  // An empty chain means no file decided, which `mcp.ts` is explicit is *not* a decision
  // to disable -- `resolveMcpServer` returning `false`/`inherited` says nobody scoped
  // this, not that it cannot load. Only a link that resolved false is a denial.
  return new Set(
    provisioned
      .filter((p) => {
        const cell = resolveMcpServer(ctx.ws, p, entry.name);
        return cell.chain.length === 0 || cell.value;
      })
      .map((p) => p.path),
  );
}

/** The earliest time anything can show this server was configured. See `McpJsonFile`. */
function configuredAt(ctx: AuditContext, entry: McpEntry): number | null {
  if (entry.userScope) return null;
  const times = ctx.ws.projects
    .filter((p) => entry.declaredIn.includes(p.path))
    .map((p) => p.mcpJson?.modifiedAt)
    .filter((t): t is number => typeof t === 'number');
  return times.length ? Math.min(...times) : null;
}

/**
 * Whether each configured server has ever been seen, or whether we cannot tell.
 *
 * The order of the tests is the claim. The sample is established first, because a
 * question asked of no evidence has no answer; then an appearance, which settles the
 * matter for any kind; then the join, which can only block an accusation; then
 * chronology, which narrows the sample to the sessions that ran after the server
 * existed and reports `age-unproven` when none did.
 *
 * Exported so the gate can assert the verdict rather than the prose. A test that reads
 * only the findings cannot distinguish the four ways of saying nothing.
 */
export function observeMcpServers(ctx: AuditContext): ServerObservation[] {
  const catalog = buildMcpCatalog(ctx.ws, ctx.inventories);
  const out: ServerObservation[] = [];

  for (const entry of catalog.entries) {
    // `available` is the only presence saying something on disk provides it now.
    // `ever-connected` is historical by its own key name and `scoped-only` means no
    // source says what the thing is; neither is "configured and enabled".
    if (entry.presence !== 'available') continue;

    const reachable = reachableProjects(ctx, entry);
    // Denied wherever it could have loaded. Not enabled, so not this finding -- and not
    // a coverage gap either, because nothing was expected of it.
    if (!reachable.size) continue;

    const ns = normalizeServerName(entry.name);
    const kind = classifyServer(ns);
    const at = configuredAt(ctx, entry);

    const sample = ctx.measurements.filter((m) => m.project !== null && reachable.has(m.project));
    const observable = sample.filter((m) => m.blocks.some((b) => b.kind === 'deferred_tools'));
    const base = {
      name: entry.name,
      kind,
      configuredAt: at,
      declaredIn: entry.declaredIn,
      unobservable: sample.length - observable.length,
    };
    const cannotTell = (reason: UnobservedReason): ServerObservation => ({
      ...base,
      sessions: 0,
      verdict: 'cannot-tell',
      reason,
    });

    if (!sample.length) out.push(cannotTell('no-sessions'));
    else if (!observable.length) out.push(cannotTell('no-tool-name-block'));
    else if (observable.some((m) => namespacesSeen(m).has(ns)))
      out.push({ ...base, sessions: observable.length, verdict: 'appeared', reason: null });
    else if (!joinIsExact(kind)) out.push(cannotTell('inexact-join'));
    else {
      const after = at === null ? [] : observable.filter((m) => m.modifiedAt >= at);
      if (!after.length) out.push(cannotTell('age-unproven'));
      else out.push({ ...base, sessions: after.length, verdict: 'never-appeared', reason: null });
    }
  }
  return out;
}

/** How each reason reads in the coverage note. */
const UNOBSERVED_REASONS: Record<UnobservedReason, string> = {
  'no-sessions': 'no measured session could have loaded it',
  'no-tool-name-block': 'the sessions that could carried no tool-name block',
  'inexact-join': 'its config key does not join onto a transcript namespace reliably',
  'age-unproven': 'nothing shows it was configured before the sessions ran',
};

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A server that is configured, enabled, and has never once been there.
 *
 * The same shape of claim as a tracked credential file: true by definition rather than
 * by judgement. Every session that could have loaded it recorded which servers were
 * present, and it was in none of them.
 *
 * The coverage note is not optional politeness. Most configured servers land in
 * `cannot-tell` on a real machine, and a report that printed only the accusations would
 * read as full coverage it does not have -- the mistake `inventoryMismatch` makes the
 * same repair for.
 */
export function neverObservedServers(ctx: AuditContext): Finding[] {
  const observations = observeMcpServers(ctx);
  const out: Finding[] = [];

  const mcpJsonOf = new Map(ctx.ws.projects.flatMap((p) => (p.mcpJson ? [[p.path, p.mcpJson.path]] : [])));

  for (const o of observations.filter((x) => x.verdict === 'never-appeared')) {
    const declared = o.declaredIn.map((path) => mcpJsonOf.get(path)).filter((p): p is string => Boolean(p));
    out.push({
      detector: 'never-observed-server',
      key: `never-observed-server ${o.name}`,
      severity: 'low',
      title: `${o.name} is configured and has never appeared in ${o.sessions} session${o.sessions === 1 ? '' : 's'}`,
      detail:
        'Something on disk provides it and no project denies it, so every one of those ' +
        'sessions could have loaded it. None recorded it -- not as a published tool ' +
        'name, not as a server awaiting authentication, not as one still connecting.',
      evidence: [
        `kind: ${o.kind} — the config key is the tool namespace verbatim, so the join is exact`,
        `sessions that could have shown it: ${o.sessions}`,
        ...(o.unobservable
          ? [`sessions excluded for carrying no tool-name block: ${o.unobservable}`]
          : []),
        ...(o.configuredAt === null ? [] : [`configured no later than ${day(o.configuredAt)}`]),
        ...declared.map((p) => `declared in ${p}`),
      ],
      fix: declared.length
        ? `Approve it in /mcp if it is wanted, or delete the entry from ${declared[0]!}. ` +
          '`claude mcp remove` is documented against user scope and does not reach a ' +
          'project-declared server.'
        : `claude mcp remove ${o.name}`,
    });
  }

  const unknown = observations.filter((o) => o.verdict === 'cannot-tell');
  if (unknown.length) {
    const byReason = new Map<UnobservedReason, number>();
    for (const o of unknown) byReason.set(o.reason!, (byReason.get(o.reason!) ?? 0) + 1);

    out.push({
      detector: 'never-observed-server',
      key: 'never-observed-server coverage',
      severity: 'info',
      title: `${unknown.length} of ${observations.length} configured MCP servers could not be checked against the sessions`,
      detail:
        'Absence of a signal is not a zero. Each of these is missing from every session ' +
        'measured for it, and for each there is a reason that absence says nothing -- so ' +
        'none of them is being called unused.',
      evidence: [
        ...[...byReason.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${n} because ${UNOBSERVED_REASONS[reason]}`),
        ...unknown
          .slice(0, 8)
          .map((o) => `  ${o.name} (${o.kind}) — ${o.reason}`),
      ],
    });
  }

  return out;
}

export const DETECTORS = [
  discardedSettings,
  droppedSettingsField,
  duplicateAccessPaths,
  neverObservedServers,
  costWithoutUse,
  unscopedSkills,
  orphanedProjectConfig,
  invertedDefaults,
  noPathScopedRules,
  bareDenyRules,
  oversizedMemory,
  restatedEntries,
  importsDoNotDefer,
  inventoryMismatch,
] as const;

export function runAll(ctx: AuditContext): Finding[] {
  return rank(DETECTORS.flatMap((d) => d(ctx)));
}
