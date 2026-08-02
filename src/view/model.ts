/**
 * The model the grid renders, and the boundary it crosses.
 *
 * `qm audit --json` emits findings -- prose and counts someone already decided to
 * print. Phase 1b serves the *resolved model itself*, over a socket, which changes what
 * the `Workspace` is: a structure held in one process becomes a payload. Three of its
 * fields do not belong on a wire.
 *
 *   - `McpServerSpec.env` / `.headers`   values are credentials.
 *   - `SettingsFile.rest`                every key the readers do not name, kept whole
 *                                        for Phase 2 round-tripping. Unbounded and
 *                                        unknown by construction: whatever the next
 *                                        Claude Code release adds lands there.
 *   - `ChainLink.source`                 an absolute path, on every link of every cell.
 *
 * So the payload is built field by field from what this file names, rather than
 * serialised from the model and stripped afterwards. The two look equivalent today and
 * differ on exactly one day: when a field appears upstream that nobody here has heard
 * of. A strip list fails open that day; an allowlist fails closed. `rest` guarantees
 * the day comes.
 *
 * Read-only, like the rest of the tool. Nothing here touches a config file.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { AuditContext } from '../detect.ts';
import { distribution, type Distribution } from '../cost/summary.ts';
import type { Cell, McpValue, Origin, PluginValue, Scope, SkillValue } from '../model.ts';
import {
  allMcpServerNames,
  allPluginIds,
  resolveMcpServer,
  resolvePlugin,
  resolveSkill,
} from '../resolve.ts';
import { allSkillIds, buildSkillCatalog } from '../skills.ts';
import { memorySlug } from '../surfaces/read.ts';
import type { ProjectRecord, Workspace } from '../surfaces/types.ts';

/** Which surface decided this row. A flattened grid still knows what it is looking at. */
export type ExtensionKind = 'plugin' | 'mcp' | 'skill';

/** `Distribution` restated here, so nothing reaches the wire that this file did not write. */
export interface ViewDistribution {
  samples: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
}

export interface ProjectCost {
  /** Sessions measured for this project. A figure without its sample count is a guess. */
  sessions: number;
  /** Startup-block chars per session. A range, never a point -- see `cost/summary.ts`. */
  baselineChars: ViewDistribution;
}

/** One column of the grid. */
export interface ViewProject {
  /** Stable handle. Not the path -- see `projectId`. */
  id: string;
  /** Directory name, or `~` for the home project. Never a path. */
  label: string;
  cost: ProjectCost;
}

/** One scope's contribution, with the file rendered rather than named. */
export interface ViewChainLink<V> {
  scope: Scope;
  value: V;
  /** Display form: `~/.claude.json`, `<project>/.claude/settings.local.json`. */
  source: string;
}

/**
 * One (extension, project) pair.
 *
 * `value` and `origin` stay separate, as they are in `Cell`. The glyph comes from the
 * value and the styling from the origin; folding them into one enum is what made the
 * A-F table unable to express a four-valued skill.
 */
export interface ViewCell<V> {
  /** The column this belongs to. Matches `ViewProject.id`. */
  project: string;
  value: V;
  origin: Origin;
  /** Ascending by precedence. The last link won. Empty when nothing set a value. */
  chain: ViewChainLink<V>[];
}

export interface ExtensionCost {
  /** Rounded by `claude plugin details` to two significant figures. */
  alwaysOnTokens: number;
  /** Only the kinds the CLI reported. An absent kind is "could not tell", never zero. */
  components: Array<{ name: string; count: number }>;
  /** True when `alwaysOnTokens` excludes MCP servers this plugin provides. */
  mcpUncounted: boolean;
}

/** One row of the grid: one extension, across every project in view. */
export interface ExtensionRow<V> {
  /** The id as the config files write it -- plugin id, server name, skill id. */
  id: string;
  kind: ExtensionKind;
  cells: ViewCell<V>[];
  /** `null` when this extension has no price on offer. Not the same as free. */
  cost: ExtensionCost | null;
}

export interface GridView {
  projects: ViewProject[];
  plugins: ExtensionRow<PluginValue>[];
  mcpServers: ExtensionRow<McpValue>[];
  skills: ExtensionRow<SkillValue>[];
}

// ---------------------------------------------------------------------------

const HOME_LABEL = '~';

/**
 * A source this table does not name. Fixed text -- not the path, and not a basename
 * taken from it, because a file nobody here recognised is precisely the one whose name
 * must not print. Unreachable today: the five entries below are every file
 * `resolve.ts` can put in a chain. That is the point. A sixth scope added upstream
 * shows up here, in the open, instead of publishing a path nobody reviewed.
 */
const UNRECOGNISED_SOURCE = '(unrecognised source)';

/**
 * Every file that can appear in this project's chains, and how each is written.
 *
 * Dropping `source` is not an option -- showing which file decided a value is the grid's
 * whole purpose. But the absolute prefix is not the part a person reads: the scope and
 * the filename are, and the project is already the column, so `<project>/` says what the
 * directory name would and says it for every project at once.
 *
 * The rendering is a lookup by identity rather than surgery on the string. Slicing a
 * known prefix off a path reads well until the path does not nest the way it was assumed
 * to -- a project whose files were read from somewhere other than its recorded path then
 * falls through to the home form and spells out directory names on the way down. A table
 * cannot fall through: a path either is one of these files or is not.
 *
 * User entries go in first and are not overwritten, which settles `~`-is-a-project: its
 * `.claude/settings.json` *is* the user-scope file, and the user form is the true one.
 * `contributingFiles` resolves the same collision the same way, at its lowest scope.
 */
export function sourceDisplays(ws: Workspace, record: ProjectRecord): Map<string, string> {
  const table = new Map<string, string>();
  const put = (path: string | undefined, display: string) => {
    if (path && !table.has(path)) table.set(path, display);
  };

  put(ws.userSettings?.path, '~/.claude/settings.json');
  // Project-scoped decisions living in a user-scoped file: the deny-list is here, not in
  // the project, and the display has to keep that legible.
  put(ws.claudeJson.path, '~/.claude.json');
  put(record.settings?.path, '<project>/.claude/settings.json');
  put(record.localSettings?.path, '<project>/.claude/settings.local.json');
  put(record.mcpJson?.path, '<project>/.mcp.json');
  return table;
}

/** The one line the whole boundary rests on: named, or nothing. */
export function renderSource(abs: string, table: ReadonlyMap<string, string>): string {
  return table.get(abs) ?? UNRECOGNISED_SOURCE;
}

/**
 * A stable handle for a project that is not its path.
 *
 * The grid keys cells to columns, and the obvious key -- the absolute path -- is the one
 * thing this module exists to keep off the wire. A digest is stable for a directory
 * across runs and restarts, and tells a reader who does not already know the path
 * nothing about it.
 */
export function projectId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

/**
 * `~` is a registered project, and its basename is the account name.
 *
 * Two ways to recognise it: the path is the home directory, or -- the same fact seen
 * structurally -- its settings file is the user-scope file. The second is checked
 * because the first is an equality between two strings that are only equal when a
 * workspace was loaded from the machine it describes.
 */
function labelFor(record: ProjectRecord, ws: Workspace): string {
  const isHome =
    record.path === ws.home ||
    (ws.userSettings !== null && record.settings?.path === ws.userSettings.path);
  return isHome ? HOME_LABEL : basename(record.path);
}

function viewDistribution(d: Distribution): ViewDistribution {
  return {
    samples: d.samples,
    min: d.min,
    p25: d.p25,
    median: d.median,
    p75: d.p75,
    p95: d.p95,
    max: d.max,
  };
}

/**
 * Component kinds `claude plugin details` prints.
 *
 * Named here rather than taken from `PluginCost.counts`, whose keys are whatever that
 * CLI's output contained. A key set another program decides is the same problem as
 * `rest` on a smaller scale, and it gets the same treatment.
 */
const COMPONENT_KINDS = ['Skills', 'Agents', 'Hooks', 'MCP servers', 'LSP servers'] as const;

/**
 * What a plugin costs, if anything can say.
 *
 * `PluginCost.source` is deliberately absent: it is whatever `Source:` line the CLI
 * printed, which can be a filesystem path for a locally-installed marketplace.
 *
 * Asking for a price can be expensive -- the index behind `get` may spawn a subprocess
 * on a miss -- which is the price index's business, not this function's. A cost grid
 * asks for a cost for every row it draws; laziness lives where the number is read.
 */
function pluginCostOf(ctx: AuditContext, id: string): ExtensionCost | null {
  const c = ctx.pluginCosts.get(id);
  // Unpriced and priced-at-NaN are the same answer to a reader: this is not known. The
  // CLI's `unpricedPlugins` draws the line in the same place.
  if (!c || !Number.isFinite(c.alwaysOnTokens)) return null;

  return {
    alwaysOnTokens: c.alwaysOnTokens,
    components: COMPONENT_KINDS.flatMap((name) => {
      const count = c.counts[name];
      return count === undefined ? [] : [{ name, count }];
    }),
    mcpUncounted: c.mcpUncounted,
  };
}

/**
 * MCP servers and skills carry no per-extension price here.
 *
 * The measured per-server cost in `ctx.measurements` is keyed by the namespace in tool
 * names, which is not the config key: `plugin:X:Y` normalises onto `plugin_X_Y`, but a
 * connector named `Linear` in a deny-list appears as `claude_ai_Linear` or as a bare
 * UUID. The join is exact for two of the four server kinds and a guess for the others,
 * and a grid cell showing a confident wrong number costs more than an empty one. Skills
 * have no priced figure on the context at all.
 */
const noCost = (): null => null;

interface Column {
  record: ProjectRecord;
  project: ViewProject;
  /** Built once per project rather than once per cell. */
  sources: ReadonlyMap<string, string>;
}

function viewCell<V>(cell: Cell<V>, column: Column): ViewCell<V> {
  return {
    project: column.project.id,
    value: cell.value,
    origin: cell.origin,
    chain: cell.chain.map((l) => ({
      scope: l.scope,
      // Closed value domain -- `boolean` or `SkillValue`, never an object read off disk.
      value: l.value,
      source: renderSource(l.source, column.sources),
    })),
  };
}

function rowsFor<V>(
  kind: ExtensionKind,
  ids: readonly string[],
  columns: readonly Column[],
  resolve: (record: ProjectRecord, id: string) => Cell<V>,
  cost: (id: string) => ExtensionCost | null,
): Array<ExtensionRow<V>> {
  return ids.map((id) => ({
    id,
    kind,
    cells: columns.map((c) => viewCell(resolve(c.record, id), c)),
    cost: cost(id),
  }));
}

/**
 * The whole grid, projected from the resolved model.
 *
 * Every pair the resolver decides for a project in view appears here with the same
 * `value` and the same `origin`. The view is a presentation of the model and never a
 * second source of truth -- a cell that disagrees with `resolvePlugin` is a bug in this
 * file, not a different opinion.
 *
 * Dead projects are left out: a column for a directory that no longer exists has nothing
 * to render and no action behind it. A scoped run projects only its own project, for the
 * same reason the report drops workspace-wide findings there.
 */
export function viewFrom(ctx: AuditContext): GridView {
  const { ws } = ctx;

  // Transcripts sit under a slug of the project's absolute path. The slug is a path with
  // the slashes swapped, so it is derived here and never emitted.
  const charsBySlug = new Map<string, number[]>();
  for (const m of ctx.measurements) {
    const slug = m.path.split('/').at(-2) ?? '';
    const acc = charsBySlug.get(slug);
    if (acc) acc.push(m.totalChars);
    else charsBySlug.set(slug, [m.totalChars]);
  }

  const columns: Column[] = ws.projects
    .filter((p) => p.alive && (!ctx.scope || p.path === ctx.scope))
    .map((record) => {
      const chars = charsBySlug.get(memorySlug(record.path)) ?? [];
      return {
        record,
        sources: sourceDisplays(ws, record),
        project: {
          id: projectId(record.path),
          label: labelFor(record, ws),
          cost: { sessions: chars.length, baselineChars: viewDistribution(distribution(chars)) },
        },
      };
    });

  // Both axes enumerate what is *installed*, not what some settings file happens to
  // mention (DEA-134). Deriving rows from `skillOverrides` made the grid circular: a
  // skill appeared only once it had been scoped, and scoping is what the grid is for.
  const skillCatalog = buildSkillCatalog(ws, ctx.measurements, ctx.inventories);

  return {
    projects: columns.map((c) => c.project),
    plugins: rowsFor<PluginValue>(
      'plugin',
      allPluginIds(ws, ctx.inventories),
      columns,
      (record, id) => resolvePlugin(ws, record, id),
      (id) => pluginCostOf(ctx, id),
    ),
    mcpServers: rowsFor<McpValue>(
      'mcp',
      allMcpServerNames(ws),
      columns,
      (record, id) => resolveMcpServer(ws, record, id),
      noCost,
    ),
    skills: rowsFor<SkillValue>(
      'skill',
      allSkillIds(skillCatalog),
      columns,
      (record, id) => resolveSkill(ws, record, id),
      noCost,
    ),
  };
}
