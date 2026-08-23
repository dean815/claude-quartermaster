/**
 * Which MCP servers exist at all.
 *
 * Deriving the axis from the deny-list is circular in exactly the way `allSkillIds` was
 * before DEA-134: a server became a row only once someone had scoped it, and scoping is
 * what the grid is for. Measured against the first-party `/mcp` panel (Claude Code
 * v2.1.220), that axis was close to inverted rather than merely short -- of the 16
 * servers the panel called live, 15 had no row, and the one that did was the one the
 * panel called *disabled*. 26 of the 39 rows existed only because something had once
 * been denied.
 *
 * Four sources name servers, and they name different things rather than more or less of
 * the same thing. Ordered by the strength of the claim, which is also the order
 * `presenceOf` reads them in:
 *
 * - `~/.claude.json` -> `mcpServers`. The launch spec is on disk, so this is the
 *   strongest claim available: six here, and they match the panel exactly.
 * - A project's `.mcp.json`. The same claim, made by a project about itself.
 * - `plugin-catalog-cache.json` -> `components.mcpServers`. 103 catalogued plugins
 *   declare a server; 10 of those are installed here. **Only an enabled plugin's server
 *   loads**, and `resolvePlugin` already answers that -- taking all ten would put four
 *   servers on the axis that no session can reach.
 * - `claudeAiMcpEverConnected`. The only on-disk trace of a claude.ai connector, which
 *   is declared in claude.ai and in no file here. 32 entries, already in the
 *   `claude.ai <Name>` form the deny-list uses, and they cover all 12 panel-live
 *   connectors the axis used to miss.
 *
 * The deny/allow list stays a source, last. It names things no other source can -- a
 * `plugin:X:Y` for a plugin that is not installed, a connector removed from claude.ai --
 * and dropping it would delete rows the grid has today.
 *
 * **Ever-connected is not installed.** The key says *Ever*, and the set only grows: a
 * connector disconnected months ago is still in it, and nothing on disk says which of
 * the 32 are live now. So it gets its own presence value and its own word, and no caller
 * can round it up to "installed" without editing this file. That is CLAUDE.md's
 * `usageCount` rule applied to a set rather than to a counter.
 *
 * **Transcripts are not a source, and the reason is a join rather than a policy.**
 * Sessions here observe 146 tool namespaces against these rows, with 9 in common. The
 * 137 are not 137 missing servers: 31 are bare UUIDs (`6f1f8065-e9be-...`) carrying no
 * name at all, 49 are `plugin_X_Y` and 36 are `claude_ai_X`, both of which are a *lossy*
 * normalisation -- `.`, ` ` and `-` all become `_`, so `claude_ai_Uber_Eats` has more
 * than one config key it could have come from. Normalising forward, from config key to
 * namespace, is exact and would let a row say it was observed; it adds no row, so it is
 * not done here. Reversing it is a guess, and a guess puts a confident wrong number on
 * the grid. `view/model.ts` declines the same join for per-server cost, for the same
 * reason. Declared unjoinable, which is an answer.
 *
 * **Built-ins get no source of their own.** `claude-in-chrome` and `computer-use` sit in
 * the panel under "Built-in MCPs (always available)" and in no file this tool reads.
 * Enumerating them means writing a list Claude Code owns into a repo that can check it
 * against nothing -- right until the release that adds or renames one, then confidently
 * wrong with no source to notice. And they are not excluded from the grid anyway: the
 * deny/allow list treats a built-in's name like any other, which is why `computer-use`
 * is a row here at all (`~`'s `enabledMcpServers` names it). So a built-in appears
 * exactly when a config file has an opinion about it, and that is the only claim about
 * built-ins this tool can support. The day it fails is the day someone wants to see a
 * built-in nobody has ever touched; the fix then is a first-party source that lists
 * them, not a literal in this file.
 *
 * **This decides rows, not cells.** `resolveMcpServer` is unchanged, so a connector
 * nobody has denied still reads `false`/`inherited` -- which says *no file decided
 * this*, not *it does not load*. Pushing a `true` link for an `ever-connected` entry
 * would make a cell claim availability on the strength of a historical set, which is the
 * mistake the presence value exists to refuse. It is the separation `skills.ts` draws
 * between a resolved `Cell` and `skillPresenceIn`, and it is drawn here for the same
 * reason.
 */
import { normalizeServerName } from './cost/transcript.ts';
import { pluginNamespace, type PluginInventory, type PluginKeyBasis } from './inventory.ts';
import { resolvePlugin } from './resolve.ts';
import type { Workspace } from './surfaces/types.ts';

/**
 * The service two names are both a path to. `claude_ai_Linear`, `linear-server` and
 * `plugin_productivity_linear` all reduce to `linear`.
 *
 * **Moved here from `detect.ts` in QM-52 rather than copied.** It had one caller and now
 * has two -- `duplicateAccessPaths` asking it of a transcript namespace, and
 * `MCP_AXIS.suppressing` asking it of a config key -- and a second copy is how the two
 * would drift the moment either grew a suffix. It lives in `mcp.ts` because the vocabulary
 * is this module's, and because `toggle.ts` already imports from here while a value edge to
 * `detect.ts` would be new.
 *
 * Takes a **namespace**, so a config key has to be put through `normalizeServerName` first
 * (`serviceOfName` does that and is the form config-side callers want). The direction is
 * the exact one: config key -> namespace, never back (`mcp.ts` header, DEA-123).
 *
 * The suffix list is three literals and CLAUDE.md already names the risk -- two genuinely
 * different services named apart only by `-server` would merge. Checked across the 145
 * live namespaces when it was written; both collapses it causes are correct. QM-52
 * considered widening it to strip a trailing `.io`/`.com`, which would have caught
 * `raindrop` against `claude.ai raindrop.io`, and **declined**: that turns every
 * dotted connector name into a prefix match on a shared predicate, and the cost of a wrong
 * merge here is a note claiming a suppression that does not exist. The miss is reported
 * instead.
 */
export function serviceOf(namespace: string): string {
  return namespace
    .replace(/^claude_ai_/, '')
    .replace(/^plugin_[^_]+_/, '')
    .replace(/-(trading|server|mcp)$/, '')
    .toLowerCase();
}

/** `serviceOf` for a name as a config file spells it, rather than as a transcript does. */
export function serviceOfName(name: string): string {
  return serviceOf(normalizeServerName(name));
}

/**
 * How well the workspace can account for a server.
 *
 * - `available`      something on disk says it can load now: a launch spec at user
 *                    scope, a project's own `.mcp.json`, or an enabled plugin.
 * - `ever-connected` `claudeAiMcpEverConnected` names it and nothing else does. It
 *                    connected at some point. That is the whole claim -- not that it
 *                    is connected, and not that it is installed.
 * - `scoped-only`    only a deny/allow-list entry names it. Someone decided about it
 *                    and no source says what it was.
 */
export type McpPresence = 'available' | 'ever-connected' | 'scoped-only';

/**
 * Re-exported from `inventory.ts`, which is where the substitution it describes lives
 * (DEA-146). It stays importable from here because `McpEntry.keyBasis` is declared here,
 * and moving a consumer's import path is churn nobody asked for.
 */
export type { PluginKeyBasis } from './inventory.ts';

export interface McpEntry {
  /** The name a `disabledMcpServers` entry would use. */
  name: string;
  presence: McpPresence;
  /** `~/.claude.json` -> `mcpServers` carries a launch spec for it. */
  userScope: boolean;
  /** Projects whose `.mcp.json` declares it, sorted. */
  declaredIn: string[];
  /**
   * The plugin whose catalog entry provides it. Non-null implies the plugin resolves
   * enabled in at least one live project -- a disabled plugin's server does not load,
   * so it is no more a row than a plugin nobody installed.
   */
  fromPlugin: string | null;
  /**
   * Where the plugin half of the name came from. `null` exactly when `fromPlugin` is --
   * no plugin provides this row, so there is no key to have got right or wrong.
   */
  keyBasis: PluginKeyBasis | null;
  /** `claudeAiMcpEverConnected` names it. Connected once; says nothing about today. */
  everConnected: boolean;
  /** Projects whose deny-list or allow-list names it, sorted. */
  scopedIn: string[];
}

export interface McpCatalog {
  /** Every name any source can produce, sorted. */
  entries: McpEntry[];
}

/**
 * `notion@claude-plugins-official` + manifest `Notion` + `notion`
 * -> `plugin:Notion:notion`.
 *
 * The middle segment is the plugin's **manifest** name, not the marketplace id. Claude
 * Code never uses the id here, and the difference is invisible on 39 of the 42 plugins
 * installed on the machine this was measured against -- which is what let it stand
 * (DEA-145). Counted across the transcripts there, inside the `needsAuthMcpServers`
 * field Claude Code writes rather than anywhere prose could reach:
 *
 *   - `plugin:Notion:notion`         389 occurrences
 *   - `plugin:productivity:notion`    27 occurrences (a second plugin, same server name)
 *   - `plugin:notion:notion`           0 occurrences -- the key this used to build
 *
 * with `mcp__plugin_Notion_notion__` on 14,064 tool calls for the same server. So the
 * old key was not merely differently-cased: it is a string Claude Code matches nothing
 * against. It cost the audit twice -- the grid labelled that row with a name no config
 * file could act on, and `deferralOf` joined it to a namespace no session ever published,
 * so the busiest MCP server on the machine read as unobserved.
 *
 * `manifestName` is required rather than optional, and `null` is its "could not read"
 * value. An optional parameter would let a call site omit it and silently get the guess,
 * which is exactly the failure being fixed; required, every caller has to have gone and
 * looked. What `pluginNamespace` substitutes on `null` is the same id prefix as before --
 * still the best available guess, and `PluginKeyBasis` is how the row says so.
 */
export function pluginServerKey(
  pluginId: string,
  serverName: string,
  manifestName: string | null,
): string {
  return `plugin:${pluginNamespace(pluginId, manifestName).name}:${serverName}`;
}

interface Acc {
  userScope: boolean;
  declaredIn: Set<string>;
  fromPlugin: string | null;
  keyBasis: PluginKeyBasis | null;
  everConnected: boolean;
  scopedIn: Set<string>;
}

/** Reconcile every source into one set. */
export function buildMcpCatalog(
  ws: Workspace,
  inventories: ReadonlyMap<string, PluginInventory>,
): McpCatalog {
  const acc = new Map<string, Acc>();
  const of = (name: string): Acc => {
    let a = acc.get(name);
    if (!a) {
      a = {
        userScope: false,
        declaredIn: new Set(),
        fromPlugin: null,
        keyBasis: null,
        everConnected: false,
        scopedIn: new Set(),
      };
      acc.set(name, a);
    }
    return a;
  };

  for (const name of Object.keys(ws.claudeJson.mcpServers)) of(name).userScope = true;

  for (const name of ws.claudeJson.claudeAiMcpEverConnected) of(name).everConnected = true;

  const live = ws.projects.filter((p) => p.alive);

  for (const p of ws.projects) {
    if (p.mcpJson) for (const n of Object.keys(p.mcpJson.mcpServers)) of(n).declaredIn.add(p.path);
    // Dead projects keep their deny-lists -- ten of the differential fixture's do -- and
    // a name only they carry is still a name the workspace has an opinion about.
    for (const n of p.entry?.disabledMcpServers ?? []) of(n).scopedIn.add(p.path);
    for (const n of p.entry?.enabledMcpServers ?? []) of(n).scopedIn.add(p.path);
  }

  for (const inv of inventories.values()) {
    // Enabled *somewhere* is the axis-level question: the row exists for every column,
    // and `resolvePlugin` decides per column what each cell says. Asking only the live
    // projects is deliberate -- a dead project's column is never rendered, so a plugin
    // enabled nowhere but there loads nowhere anyone can see.
    if (!live.some((p) => resolvePlugin(ws, p, inv.id).value)) continue;
    // Read once per plugin rather than per server: the basis is a property of the
    // manifest, so two servers from one plugin can never disagree about it.
    const basis: PluginKeyBasis = pluginNamespace(inv.id, inv.manifestName).basis;
    for (const src of inv.enumerated) {
      for (const name of src.mcpServerNames) {
        const a = of(pluginServerKey(inv.id, name, inv.manifestName));
        a.fromPlugin = inv.id;
        a.keyBasis = basis;
      }
    }
  }

  const entries: McpEntry[] = [...acc.entries()]
    .map(([name, a]) => ({
      name,
      presence: presenceOf(a),
      userScope: a.userScope,
      declaredIn: [...a.declaredIn].sort(),
      fromPlugin: a.fromPlugin,
      keyBasis: a.keyBasis,
      everConnected: a.everConnected,
      scopedIn: [...a.scopedIn].sort(),
    }))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  return { entries };
}

function presenceOf(a: Acc): McpPresence {
  if (a.userScope || a.declaredIn.size > 0 || a.fromPlugin !== null) return 'available';
  return a.everConnected ? 'ever-connected' : 'scoped-only';
}

/**
 * The grid's MCP axis.
 *
 * Every presence, unlike `allSkillIds`, which drops `stale`. That exclusion rests on an
 * override written for a skill that no longer loads doing nothing; no presence here is
 * dead in that way. A `scoped-only` name is one a live deny-list entry already acts on,
 * and an `ever-connected` one is a connector that comes back the moment claude.ai
 * reconnects it, with no file here changing. Dropping either deletes rows the grid has
 * today, which is the bug this issue is fixing, from the other side.
 *
 * Ordered by the default comparator rather than `localeCompare`, because that is what
 * this axis has always used -- `claude.ai CORE` sorts before `claude.ai Canary Data`.
 * Changing it would reorder every row for a reason nobody asked for.
 */
export function allMcpServerNames(catalog: McpCatalog): string[] {
  return catalog.entries.map((e) => e.name);
}

/** Entries per presence value, for reporting coverage rather than implying it. */
export function countByPresence(catalog: McpCatalog): Record<McpPresence, number> {
  const counts: Record<McpPresence, number> = {
    available: 0,
    'ever-connected': 0,
    'scoped-only': 0,
  };
  for (const e of catalog.entries) counts[e.presence]++;
  return counts;
}
