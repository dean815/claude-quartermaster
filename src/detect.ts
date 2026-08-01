/**
 * Detectors.
 *
 * Each is a pure function over an `AuditContext`. They report what is measurable and
 * stay quiet otherwise -- a detector that cannot tell "absent" from "unused" returns
 * nothing rather than guessing, because a wrong finding costs more trust than a
 * missing one earns.
 */
import type { Workspace, ProjectRecord } from './surfaces/types.ts';
import type { TranscriptMeasurement } from './cost/transcript.ts';
import type { PluginCost } from './cost/plugins.ts';
import { resolvePlugin, allPluginIds } from './resolve.ts';
import { pluginUsage, isDemonstrablyUnused } from './usage.ts';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  detector: string;
  /**
   * Stable identity for drift comparison, when one detector emits several findings
   * that are not distinguished by project. Without it, all eleven duplicate-path
   * findings shared the identity `duplicate-access-paths *`, and swapping one service
   * for another read as no change at all.
   */
  key?: string;
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
  pluginCosts: Map<string, PluginCost | null>;
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
 */
export function duplicateAccessPaths(ctx: AuditContext): Finding[] {
  type Ns = { tools: number; chars: number };
  const perService = new Map<string, { sessions: number; namespaces: Map<string, Ns> }>();

  for (const m of ctx.measurements) {
    const byService = new Map<string, Array<{ server: string; tools: number; chars: number }>>();
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
        const prev = acc.namespaces.get(l.server) ?? { tools: 0, chars: 0 };
        acc.namespaces.set(l.server, {
          tools: Math.max(prev.tools, l.tools),
          chars: Math.max(prev.chars, l.chars),
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

    return {
      detector: 'duplicate-access-paths',
      key: `duplicate-access-paths ${service}`,
      severity,
      title:
        `${service} is reachable ${entries.length} ways at once` +
        (redundantChars ? ` (+${num(redundantChars)} chars)` : ''),
      detail:
        `Live simultaneously in ${a.sessions} session${a.sessions === 1 ? '' : 's'}. ` +
        (allStubs
          ? 'All of these are unauthenticated stubs publishing a placeholder tool pair, ' +
            'so the cost is small -- but the duplication is real and will grow if they connect.'
          : 'Each publishes its own tool names into the same context.'),
      evidence: entries.map(
        ([ns, v]) => `${ns} — ${v.tools} tools, ${num(v.chars)} chars${v.tools <= 2 ? ' (unauthenticated stub)' : ''}`,
      ),
      fix:
        'Keep one path per surface. A claude.ai connector plus a plugin is legitimate ' +
        'when chat needs the connector -- disable the plugin in Claude Code rather than ' +
        'removing the connector.',
    } satisfies Finding;
  });

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
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
  const ids = allPluginIds(ctx.ws);

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
  for (const id of allPluginIds(ctx.ws)) {
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
 */
export function costWithoutUse(ctx: AuditContext): Finding[] {
  const unused: Array<{ id: string; tokens: number; components: string; projects: number }> = [];
  const live = ctx.ws.projects.filter((p) => p.alive);

  for (const [id, cost] of ctx.pluginCosts) {
    if (!cost || !Number.isFinite(cost.alwaysOnTokens) || cost.alwaysOnTokens <= 0) continue;

    // A disabled plugin costs nothing, so "unused and expensive" does not apply to it.
    // Without this the report lists globally-disabled plugins as if they were a bill.
    const enabledIn = live.filter((p) => resolvePlugin(ctx.ws, p, id).value).length;
    if (enabledIn === 0) continue;

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
] as const;

export function runAll(ctx: AuditContext): Finding[] {
  return rank(DETECTORS.flatMap((d) => d(ctx)));
}
