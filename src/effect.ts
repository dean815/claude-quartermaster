/**
 * What a pending config change takes effect on: `/reload-plugins`, or a restart.
 *
 * The point is restraint. Toggling a skill, command, agent, hook, LSP, monitor or theme
 * never invalidates the prompt cache -- those load from disk on reload. Saying "restart
 * required" for a skill toggle is worse than saying nothing, because a warning that
 * fires on everything is a warning the user learns to skip. Two things genuinely cost a
 * restart: a plugin providing an MCP server whose tools are *not* deferred, and a
 * bare-tool-name deny rule.
 *
 * **Only one of those two is observable, and that is the finding.**
 *
 * A session transcript records `deferred_tools_delta`, and the block kinds
 * `cost/transcript.ts` measures are exactly `deferred_tools | mcp_instructions |
 * skill_listing | agent_listing | hook_output`. None of them represents a tool that
 * loaded *eagerly* -- that tool lands in the system prompt, which this tool does not
 * read. So a server whose tools were not deferred leaves the same trace as a server
 * that connected and published nothing, and the same trace as one whose delta arrived
 * after the transcript's last flush: no trace at all.
 *
 * Measured on the 2,071 transcripts on the machine this was written against, because
 * the absence of a *record* is not the absence of a *signal* until someone looks. The
 * one candidate signal is a server that publishes an `mcp_instructions` block and
 * contributes no name to `deferred_tools` in the same session:
 *
 * - 14 distinct servers ever do it, over 25 session-occurrences.
 * - **Every one of the 14 also appears with deferred tools in other sessions.** Orphan
 *   rates run 30.8% (`plugin_airtable_airtable`, 12 of 39) down to 0.6%
 *   (`computer-use`, 1 of 173). Servers orphaned in 100% of their sessions: **0**.
 * - The 11 sessions carrying MCP instructions and no `deferred_tools_delta` at all name
 *   servers (`n8n`, `claude_ai_Linear`) with 168 and 27 deferred sessions elsewhere.
 *
 * A property that holds for a server in 1 session out of 133 is not a property of the
 * server. So the signal measures session-to-session flakiness -- connection timing --
 * and not deferral. **Non-deferral is unobservable with what this tool measures**, and
 * the honest vocabulary has two values plus "could not tell", not three.
 *
 * Which leaves `restart` reachable from the deny-rule half alone. That is not a gap to
 * be filled with a predicate: `ENABLE_TOOL_SEARCH` appears nowhere in this repo, and
 * under the default `auto` deferral is a runtime decision, so "will this server's tools
 * be deferred" is not a static property that could be looked up. Guessing it and
 * rounding the guess to `restart` would rebuild the cry-wolf behaviour this file exists
 * to prevent.
 *
 * The day it fails: Claude Code starts recording the eagerly-loaded tool set, at which
 * point `DeferralEvidence` grows its third value and `unmeasured` stops absorbing two
 * different situations.
 */
import { isBareDenyRule } from './detect.ts';
import { normalizeServerName } from './cost/transcript.ts';
import type { TranscriptMeasurement } from './cost/transcript.ts';
import type { PluginInventory } from './inventory.ts';
import { pluginServerKey } from './mcp.ts';
import type { SettingsValidity } from './surfaces/types.ts';

/**
 * What a change needs before it is live.
 *
 * `unknown` is a first-class answer, not a polite `restart`. It says the measurement
 * that would decide this was never taken -- which is `SkillPresence`'s rule about a
 * zeroed counter, applied to a session record instead of a counter.
 *
 * `none` is the opposite kind of answer and arrives from DEA-147: the change lands in a
 * settings file Claude Code discards, so nothing about the running session's inputs
 * moves and there is nothing to reload or restart *for*. Not folded into `reload`,
 * because "run /reload-plugins and this takes effect" would be false.
 */
export type Effect = 'none' | 'reload' | 'restart' | 'unknown';

/**
 * What one session transcript can say about one server's tools.
 *
 * Two values where the shape wants three. `ProjectPresence` in `skills.ts` has
 * `observed | unobserved | unmeasured`, and the middle one is missing here because
 * nothing records it -- see the file header for the measurement. `unmeasured`
 * therefore covers both "no session listed these tools" and "these tools loaded
 * eagerly", and no caller may split them.
 */
export type DeferralEvidence =
  /** A measured session listed this server's tools in its deferred set. */
  | 'observed-deferred'
  /** No measured session listed them. Could not tell -- never "loaded eagerly". */
  | 'unmeasured';

/**
 * The kinds of thing a staged change can be about.
 *
 * The first seven are the cache-safe component kinds, listed rather than collapsed into
 * one `component` because the acceptance criterion names them one by one and a reader
 * checking "does a theme toggle force a restart" should find the word `theme`.
 */
export type ChangeKind =
  | 'skill'
  | 'command'
  | 'agent'
  | 'hook'
  | 'lsp'
  | 'monitor'
  | 'theme'
  | 'plugin'
  | 'mcp-server'
  | 'deny-rule';

/**
 * Component kinds that load from disk and touch no tool definition.
 *
 * A `Set` rather than a chain of `||` so that adding a kind is one edit in one place;
 * the union above and this set are the two halves that must agree, and TypeScript
 * checks the membership but not the completeness. The day it fails is the day Claude
 * Code adds an eighth cache-safe kind and it is added to `ChangeKind` alone, where it
 * would silently fall through to the MCP branch and read `unknown`.
 */
const CACHE_SAFE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'skill',
  'command',
  'agent',
  'hook',
  'lsp',
  'monitor',
  'theme',
]);

/** One staged change, as DEA-112's apply step will describe it. */
export type PendingChange =
  | { kind: Exclude<ChangeKind, 'plugin' | 'mcp-server' | 'deny-rule'>; id: string; project?: string }
  | { kind: 'plugin'; id: string; project?: string }
  /** `name` is the config key -- `plugin:airtable:airtable`, `claude.ai Linear`. */
  | { kind: 'mcp-server'; name: string; project?: string }
  | {
      kind: 'deny-rule';
      rules: readonly string[];
      source: string;
      /**
       * Whether Claude Code accepts `source`. Required, so no construction site gets an
       * optimistic guess for free -- the `pluginServerKey` rule (DEA-145).
       *
       * On the change rather than in `ClassifyInput`, because it is a fact about this
       * change's own target file and not about the observed world. The deny-rule kind is
       * the only one naming a file today; when DEA-112 stages a real plugin or skill
       * write, that change will name one too and will carry its validity the same way.
       */
      sourceValidity: SettingsValidity;
      project?: string;
    };

export interface Classification {
  change: PendingChange;
  effect: Effect;
  /** One sentence, in the voice the report prints. */
  reason: string;
  /**
   * Sessions the deferral claim rests on. Zero wherever the classification rests on no
   * observation at all -- a skill toggle is `reload` by construction, not by evidence,
   * and reporting a sample count for it would dress a rule up as a measurement.
   */
  sessions: number;
  evidence: string[];
}

/**
 * The observed side of the world: which server namespaces were seen carrying deferred
 * tools, and in how many sessions.
 *
 * Built once and passed in, because a classifier called per staged change must not
 * re-walk every transcript per call.
 */
export interface DeferralIndex {
  /** Namespace (`plugin_data_hex`) -> sessions whose deferred set carried its tools. */
  byNamespace: ReadonlyMap<string, number>;
  /** Sessions carrying a deferred-tools block at all. The denominator. */
  measuredSessions: number;
  /** Sessions looked at, measured or not. */
  totalSessions: number;
}

export function buildDeferralIndex(
  measurements: readonly TranscriptMeasurement[],
): DeferralIndex {
  const byNamespace = new Map<string, number>();
  let measuredSessions = 0;

  for (const m of measurements) {
    if (!m.blocks.some((b) => b.kind === 'deferred_tools')) continue;
    measuredSessions++;
    // `m.servers` is derived from the deferred tool names alone, so membership here is
    // exactly "this server's tools were deferred in this session".
    for (const s of m.servers) {
      if (s.kind === 'builtin') continue;
      byNamespace.set(s.server, (byNamespace.get(s.server) ?? 0) + 1);
    }
  }

  return { byNamespace, measuredSessions, totalSessions: measurements.length };
}

/**
 * Was this server's tool list observed in the deferred set, and in how many sessions?
 *
 * The config-key-to-namespace direction only. `mcp.ts` explains why the reverse is
 * declined: `claude_ai_Uber_Eats` has more than one config key it could have come from,
 * so reading a namespace back to a key is a guess. Forward it is exact.
 */
export function deferralOf(
  index: DeferralIndex,
  configKey: string,
): { evidence: DeferralEvidence; sessions: number; namespace: string } {
  const namespace = normalizeServerName(configKey);
  const sessions = index.byNamespace.get(namespace) ?? 0;
  return {
    evidence: sessions > 0 ? 'observed-deferred' : 'unmeasured',
    sessions,
    namespace,
  };
}

/**
 * Combine several sub-answers into one.
 *
 * `unknown` outranks `reload` because it means "a restart has not been ruled out", and
 * `restart` outranks both because it has been ruled *in*. Note the direction: this is
 * how several known answers merge, not a default. Nothing here ever turns an absence of
 * evidence into `restart`.
 */
const RANK: Record<Effect, number> = { none: 0, reload: 1, unknown: 2, restart: 3 };

/**
 * The seed is the first element and not `reload`, so a list of `none` stays `none`.
 * An empty list is still `reload` -- no sub-answers means no reason to have been asked,
 * and the two callers below never pass one.
 */
export function worstEffect(effects: readonly Effect[]): Effect {
  let worst: Effect = effects[0] ?? 'reload';
  for (const e of effects) if (RANK[e] > RANK[worst]) worst = e;
  return worst;
}

/**
 * Every MCP server config key a plugin provides, and whether any source could say.
 *
 * `null` means no source covers this plugin -- 17 of the 42 installed plugins here have
 * no catalog entry -- which is "could not tell" and not "provides none". An empty array
 * is the positive claim: a source enumerated this plugin's components and listed no MCP
 * server among them.
 *
 * The keys are spelled with the plugin's manifest name where one could be read, and with
 * the marketplace id where none could (DEA-145). No second return value says which,
 * because the caller passed the whole `PluginInventory` in and `manifestName === null` is
 * that answer at the source -- `McpEntry.keyBasis` exists only because a *row* has no
 * inventory left to consult. What it changes here is a verdict: `notion@...` keyed as
 * `plugin:notion:notion` joined to a namespace no session published and classified
 * `unknown`; keyed as `plugin:Notion:notion` it is `observed-deferred` and `reload`.
 */
export function pluginServerKeys(inv: PluginInventory | undefined): string[] | null {
  if (!inv || !inv.enumerated.length) return null;
  const out = new Set<string>();
  for (const src of inv.enumerated) {
    for (const name of src.mcpServerNames) out.add(pluginServerKey(inv.id, name, inv.manifestName));
  }
  return [...out].sort();
}

export interface ClassifyInput {
  index: DeferralIndex;
  /** Keyed by plugin id, as `readInventories` returns. */
  inventories: ReadonlyMap<string, PluginInventory>;
}

/** Classify one staged change. */
export function classify(change: PendingChange, input: ClassifyInput): Classification {
  if (CACHE_SAFE_KINDS.has(change.kind)) {
    return {
      change,
      effect: 'reload',
      reason: `A ${change.kind} loads from disk on /reload-plugins and changes no tool definition, so the prompt cache survives it.`,
      sessions: 0,
      evidence: [],
    };
  }

  if (change.kind === 'deny-rule') {
    // Before the bare/scoped question, because a rule in a file Claude Code drops is not
    // in force whatever its shape, so nothing about it can invalidate a cache. Only
    // `discarded`: a `field-dropped` or `not-checked` file is classified exactly as it
    // was before DEA-147.
    //
    // **The narrowing DEA-149 was filed to add is not one this release needs, and the
    // test is where that is kept honest.** The premise was a `field-dropped` file whose
    // dropped field is `permissions`, whose deny rules would then not be in force while
    // this branch still answered `reload`. Measured across thirteen malformed shapes on
    // 2.1.222 and re-measured on 2.1.224, there is no such file: every malformed
    // `permissions` shape refuses the file *whole*, and the one partial acceptance it has
    // removes non-string elements and leaves the surviving rules in force -- which
    // `readSettings` already drops, so `reload` is the right answer for what is left. A
    // narrowing here would fire on nothing and read as if it fired on something.
    // `EFFECT_SETTINGS_KEYS` below is how that stops being a claim in a comment.
    if (change.sourceValidity === 'discarded') {
      return {
        change,
        effect: 'none',
        reason:
          'Claude Code discards this settings file, so its deny rules are not in force ' +
          'and changing them moves nothing.',
        sessions: 0,
        evidence: [`${change.source} fails Claude Code's settings schema in the whole-file way`],
      };
    }

    const bare = change.rules.filter(isBareDenyRule);
    if (!bare.length) {
      return {
        change,
        effect: 'reload',
        reason:
          'Every rule here is scoped, and a scoped rule leaves the tool definition in ' +
          'the system prompt.',
        sessions: 0,
        evidence: change.rules.map((r) => `"${r}" in ${change.source}`),
      };
    }
    return {
      change,
      effect: 'restart',
      reason:
        `${bare.length} rule${bare.length === 1 ? '' : 's'} name a tool without scoping it, ` +
        'which removes the definition from the system prompt and invalidates the cache.',
      sessions: 0,
      evidence: bare.map((r) => `"${r}" in ${change.source}`),
    };
  }

  if (change.kind === 'mcp-server') {
    return fromServers(change, [change.name], input.index);
  }

  // A plugin toggle is only ever as costly as the MCP servers it brings with it.
  const keys = pluginServerKeys(input.inventories.get(change.id));
  if (keys === null) {
    return {
      change,
      effect: 'unknown',
      reason:
        'No source enumerates this plugin\'s components, so whether it provides an MCP ' +
        'server at all is unmeasured.',
      sessions: 0,
      evidence: ['no plugin-catalog entry'],
    };
  }
  if (!keys.length) {
    return {
      change,
      effect: 'reload',
      reason:
        'The catalog enumerates this plugin and lists no MCP server, so it can only add ' +
        'or remove cache-safe components.',
      sessions: 0,
      evidence: ['plugin-catalog entry declares no mcpServers'],
    };
  }
  return fromServers(change, keys, input.index);
}

/**
 * The settings keys whose *contents* a verdict here depends on (DEA-149).
 *
 * One entry, because one branch reads a settings key at all: `deny-rule` classifies the
 * rules in `permissions.deny`, and `none` versus `reload` versus `restart` turns on
 * whether those rules are in force. Nothing else in this file reads a settings key --
 * a plugin toggle resolves through the inventory and a server toggle through the
 * deferral index.
 *
 * It exists to be read by a test, and that is the whole point rather than an apology for
 * it. `classify` narrows on `discarded` alone and is right to, *because* no partial
 * acceptance names a key in this list -- a fact about Claude Code's schema messages, not
 * about this code, and one that can therefore change in a release nobody here is
 * consulted about. The tripwire in `test/dropped-field.test.ts` reads this list against
 * every recorded `doctor` message and goes red the day one of them names a key in it,
 * which is the day `sourceValidity === 'discarded'` stops being sufficient. Keeping the
 * list next to the branch it guards is what makes it move when the branch does.
 */
export const EFFECT_SETTINGS_KEYS: readonly string[] = ['permissions.deny'];

/**
 * Whether a `doctor` key path and a key this classifier reasons about are the same
 * configuration, in either direction.
 *
 * Both directions, because a dotted path is a tree: `permissions` dropped whole takes
 * `permissions.deny` with it, and `permissions.deny` dropped takes only itself. An
 * equality test would miss the first, which is the exact shape of the case this guards.
 */
export function effectDependsOn(key: string): boolean {
  return EFFECT_SETTINGS_KEYS.some(
    (k) => k === key || k.startsWith(`${key}.`) || key.startsWith(`${k}.`),
  );
}

/**
 * The MCP half, shared by a server toggle and a plugin that provides servers.
 *
 * Note what is absent: there is no branch producing `restart`. A server observed
 * deferred is cache-safe; anything else is `unmeasured`, and `unmeasured` resolves to
 * `unknown`. Writing the missing branch is the mistake the file header measures against
 * -- it would satisfy the issue's letter and reproduce the failure it was written to
 * prevent.
 */
function fromServers(
  change: PendingChange,
  configKeys: readonly string[],
  index: DeferralIndex,
): Classification {
  const seen = configKeys.map((k) => ({ key: k, ...deferralOf(index, k) }));
  const effects = seen.map((s): Effect =>
    s.evidence === 'observed-deferred' ? 'reload' : 'unknown',
  );
  const effect = worstEffect(effects);
  const sessions = seen.reduce((n, s) => Math.max(n, s.sessions), 0);
  const unmeasured = seen.filter((s) => s.evidence === 'unmeasured');

  const evidence = seen.map(
    (s) =>
      s.evidence === 'observed-deferred'
        ? `${s.key} -> ${s.namespace}: tools deferred in ${s.sessions} of ${index.measuredSessions} measured sessions`
        : `${s.key} -> ${s.namespace}: no measured session listed its tools`,
  );

  if (effect === 'reload') {
    return {
      change,
      effect,
      reason:
        'Its tools were observed in the deferred set, and deferred tools are not in the ' +
        'system prompt, so the cache survives the toggle.',
      sessions,
      evidence,
    };
  }

  return {
    change,
    effect: 'unknown',
    reason:
      `${unmeasured.length === configKeys.length ? 'No' : 'Not every'} server here was ` +
      'observed deferred. Nothing records tools that loaded eagerly, so this is "could ' +
      'not tell" rather than "restart".',
    sessions,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface EffectReport {
  classifications: Classification[];
  measuredSessions: number;
  totalSessions: number;
}

/** Counts per change kind per effect, in the order `ChangeKind` declares them. */
export function tally(report: EffectReport): Array<{
  kind: ChangeKind;
  none: number;
  reload: number;
  restart: number;
  unknown: number;
}> {
  const order: ChangeKind[] = [
    'skill',
    'command',
    'agent',
    'hook',
    'lsp',
    'monitor',
    'theme',
    'plugin',
    'mcp-server',
    'deny-rule',
  ];
  const rows = new Map<
    ChangeKind,
    { kind: ChangeKind; none: number; reload: number; restart: number; unknown: number }
  >();
  for (const c of report.classifications) {
    const row = rows.get(c.change.kind) ?? {
      kind: c.change.kind,
      none: 0,
      reload: 0,
      restart: 0,
      unknown: 0,
    };
    row[c.effect]++;
    rows.set(c.change.kind, row);
  }
  return order.filter((k) => rows.has(k)).map((k) => rows.get(k)!);
}

export function classifyAll(
  changes: readonly PendingChange[],
  input: ClassifyInput,
): EffectReport {
  return {
    classifications: changes.map((c) => classify(c, input)),
    measuredSessions: input.index.measuredSessions,
    totalSessions: input.index.totalSessions,
  };
}

/**
 * Every change the grid could stage, as if it had been staged.
 *
 * Phase 1b stages nothing, so a report of *pending* changes would be empty on every
 * machine and prove nothing. Classifying the hypothetical set is what makes the
 * restraint checkable before DEA-112 exists to test it against -- and it is the
 * question a user actually has, which is "if I turn this off, what does it cost me".
 *
 * The axes are passed in already built rather than derived here: `allSkillIds`,
 * `allPluginIds` and `allMcpServerNames` each need sources this file does not read, and
 * reaching for them would make a classifier depend on three catalogs to answer a
 * question about one string.
 */
export function candidateChanges(axes: {
  skills: readonly string[];
  plugins: readonly string[];
  mcpServers: readonly string[];
  denyRules: ReadonlyArray<{
    rules: readonly string[];
    source: string;
    sourceValidity: SettingsValidity;
    project?: string;
  }>;
}): PendingChange[] {
  return [
    ...axes.skills.map((id): PendingChange => ({ kind: 'skill', id })),
    ...axes.plugins.map((id): PendingChange => ({ kind: 'plugin', id })),
    ...axes.mcpServers.map((name): PendingChange => ({ kind: 'mcp-server', name })),
    ...axes.denyRules.map(
      (d): PendingChange => ({
        kind: 'deny-rule',
        rules: d.rules,
        source: d.source,
        sourceValidity: d.sourceValidity,
        ...(d.project ? { project: d.project } : {}),
      }),
    ),
  ];
}
