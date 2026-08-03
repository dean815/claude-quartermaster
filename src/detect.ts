/**
 * Detectors.
 *
 * Each is a pure function over an `AuditContext`. They report what is measurable and
 * stay quiet otherwise -- a detector that cannot tell "absent" from "unused" returns
 * nothing rather than guessing, because a wrong finding costs more trust than a
 * missing one earns.
 */
import type { Workspace, ProjectRecord, McpServerSpec } from './surfaces/types.ts';
import type { TranscriptMeasurement, ServerCost, ServerKind } from './cost/transcript.ts';
import { normalizeServerName } from './cost/transcript.ts';
import type { PluginCostIndex } from './cost/plugins.ts';
import type { PluginInventory } from './inventory.ts';
import { resolvePlugin, allPluginIds } from './resolve.ts';
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
  const urls = urlIndex(ctx.ws);

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
          ? `Matched on the launch URL these share (${[...distinct][0]}), which is exact.`
          : 'Matched on the namespace spelling, which is inferred -- no two of these ' +
            'carry a launch URL this tool can read, so nothing confirms it.'),
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
      ],
      fix: removable
        ? `claude mcp remove ${removable} — the command /mcp itself prints when it hides a ` +
          'duplicate. A claude.ai connector plus a plugin is legitimate when chat needs the ' +
          'connector, so disable the plugin rather than removing the connector.'
        : 'Keep one path per surface. None of these is a user-scope server, so ' +
          '`claude mcp remove` does not reach them -- disable the duplicate plugin in ' +
          'Claude Code, or the connector in claude.ai.',
    } satisfies Finding;
  });

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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
function urlIndex(ws: Workspace): Map<string, string> {
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

  const out = new Map<string, string>();
  for (const [ns, set] of seen) if (set.size === 1) out.set(ns, [...set][0]!);
  return out;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

/** `claude_ai_Linear`, `linear-server`, `plugin_productivity_linear` -> `linear`. */
function serviceOf(namespace: string): string {
  return namespace
    .replace(/^claude_ai_/, '')
    .replace(/^plugin_[^_]+_/, '')
    .replace(/-(trading|server|mcp)$/, '')
    .toLowerCase();
}

/**
 * A project restating a value it would inherit anyway. Does nothing today, and stops
 * tracking the global default the moment that default changes.
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
        restated.push(`${id} = ${cell.value} (also ${cell.value} at ${cell.chain[0]!.scope})`);
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
 * A bare tool name in a deny rule removes the tool from the system prompt and
 * invalidates the prompt cache. A scoped rule like `Bash(rm *)` does not.
 */
export function bareDenyRules(ctx: AuditContext): Finding[] {
  const out: Finding[] = [];

  /**
   * An `mcp__<server>__<tool>` rule already names exactly one tool -- MCP tools have
   * no `Tool(pattern)` form to scope down to, so there is nothing to fix. Flagging
   * them told the user to "scope" the rules that stop Claude placing trades.
   */
  const isFullyQualifiedMcpTool = (rule: string) => rule.startsWith('mcp__');

  const check = (path: string, deny: string[] | undefined, project?: string) => {
    const bare = (deny ?? []).filter(
      (r) => !r.includes('(') && r.trim() !== '' && !isFullyQualifiedMcpTool(r),
    );
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

export const DETECTORS = [
  duplicateAccessPaths,
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
