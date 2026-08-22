/**
 * The model the grid renders, and the boundary it crosses.
 *
 * `qm audit --json` emits findings -- prose and counts someone already decided to
 * print. Phase 1b serves the *resolved model itself*, over a socket, which changes what
 * the `Workspace` is: a structure held in one process becomes a payload. Parts of it do
 * not belong on a wire, and the third is not a field -- which is the point of it.
 *
 *   - `McpServerSpec.env` / `.headers`   values are credentials.
 *   - `ChainLink.source`                 an absolute path, on every link of every cell.
 *   - everything else on `ProjectEntry`  both are **cast whole** out of `~/.claude.json`
 *     and on `McpServerSpec`             and `.mcp.json` rather than built field by field,
 *                                        so each carries whatever else those files hold
 *                                        and no name here says what. Measured 2026-08-22:
 *                                        `ProjectEntry` names six keys and the 161 entries
 *                                        on this machine carry **34** it does not.
 *
 * So the payload is built field by field from what this file names, rather than
 * serialised from the model and stripped afterwards. The two look equivalent today and
 * differ on exactly one day: when a field appears upstream that nobody here has heard
 * of. A strip list fails open that day; an allowlist fails closed.
 *
 * **The rule outlives its examples (QM-44), and QM-30 is that claim tested rather than
 * predicted.** This list used to open with `SettingsFile.rest` -- an explicit bag of every
 * settings key the readers do not name -- and QM-44 called it contingent. It is gone: the
 * readers drop those keys at the door now, and `test/view.test.ts` gates that they do. The
 * discipline did not move an inch, because the third bullet is the same hazard with *no*
 * field name to point at, which is harder to notice and no less live. So it is stated as
 * the mechanism (allowlist, field by field, closed value domains) and never as the list,
 * and losing an example is not evidence that the mechanism can be relaxed.
 *
 * ## The second direction (QM-44)
 *
 * `PlanView` is the same boundary with a plan on it. A `TogglePlan` cannot go on a wire at
 * all -- `TogglePlan.axis` is a record of functions -- so the question was never "serialise
 * and strip", and what crosses is chosen here field by field like everything above. Three
 * of its fields are refused for reasons the workspace payload already knows:
 *
 *   - `before` / `after`        the whole text of a settings file: every key the readers do
 *                               not name, verbatim, plus whatever the next release adds.
 *                               Since QM-30 this is the *only* place in the model those
 *                               keys still exist, which sharpens the refusal rather than
 *                               softening it. The reviewed unit is the *entry* and not the
 *                               byte (QM-46), which is also what `applyPlan` binds its
 *                               precondition to, so the diff is not what the consent rests
 *                               on.
 *   - `project` / `target`      absolute paths, exactly as `ChainLink.source` is. They cross
 *                               as `projectId` and as a display form.
 *   - `edits`                   `Edit.value` is `unknown` by construction -- whatever
 *                               `write.ts` was asked to splice. `changes` already says what
 *                               the entries become, in a closed domain.
 *
 * And **no message crosses at all** -- notes and refusals cross as their codes. Those
 * sentences are composed for a terminal and three of the eight note bodies interpolate an
 * absolute path (`creates-file`, `tracked-path`, `would-restate`); publishing prose built
 * elsewhere and hoping it stays path-free is a strip list wearing a different hat. The
 * codes are closed unions, the page glosses them, and `ServeOptions.log` puts the full
 * `describePlan` text in the terminal that started the server -- which is the trusted
 * channel, and the one place the whole diff belongs.
 *
 * This module still writes nothing. `planView` projects a plan; `apply.ts` is what applies
 * one.
 */
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import type { AuditContext } from '../detect.ts';
import { distribution, type Distribution } from '../cost/summary.ts';
import type { Effect } from '../effect.ts';
import type { Cell, McpValue, Origin, PluginValue, Scope, SkillValue } from '../model.ts';
import { allMcpServerNames, buildMcpCatalog } from '../mcp.ts';
import { allPluginIds, resolveMcpServer, resolvePlugin, resolveSkill } from '../resolve.ts';
import { allSkillIds, buildSkillCatalog } from '../skills.ts';
import { memorySlug } from '../surfaces/read.ts';
import type { ProjectRecord, Workspace } from '../surfaces/types.ts';
import { planEffect, type EntryValue, type ToggleNoteCode, type TogglePlan } from '../toggle.ts';
import type { ApplyResult } from '../apply.ts';

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
 * CLI's output contained. That is the header's third bullet on a smaller scale -- a key
 * set another program decides, reaching the model without passing through anything that
 * names it -- and it gets the same treatment. Smaller only in blast radius: a component
 * kind is a word off a help-style listing rather than a config file's contents, so this
 * one is the cheap case of the rule and not the reason for it.
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
 * The projects that become columns.
 *
 * One expression, two callers (QM-44). `columnPaths` has to answer for exactly the set
 * `viewFrom` drew, because a digest the grid never published must not be writable and a
 * column it did publish must be -- and a second copy of the filter agrees with the first
 * until someone edits one of them.
 */
function columnRecords(ctx: AuditContext): ProjectRecord[] {
  return ctx.ws.projects.filter((p) => p.alive && (!ctx.scope || p.path === ctx.scope));
}

/**
 * The path each column stands for. Server-side only, and never part of a payload.
 *
 * The grid keys everything to `projectId`, which is a digest precisely so the path stays
 * off the wire; a write has to name a directory, so the inverse lives here beside the
 * function that built the digests. Held by the server, never sent: a caller names a
 * column, and the server -- not the caller -- decides which directory that is.
 */
export function columnPaths(ctx: AuditContext): Map<string, string> {
  return new Map(columnRecords(ctx).map((r) => [projectId(r.path), r.path]));
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

  const columns: Column[] = columnRecords(ctx).map((record) => {
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

  // All three axes enumerate what is *installed*, not what some settings file happens to
  // mention (DEA-134, and DEA-143 for MCP). Deriving rows from `skillOverrides` or from
  // `disabledMcpServers` made the grid circular: a row appeared only once it had been
  // scoped, and scoping is what the grid is for.
  const skillCatalog = buildSkillCatalog(ws, ctx.measurements, ctx.inventories);
  const mcpCatalog = buildMcpCatalog(ws, ctx.inventories);

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
      allMcpServerNames(mcpCatalog),
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

// ---------------------------------------------------------------------------
// A plan, projected (QM-44)
// ---------------------------------------------------------------------------

/**
 * How one id's entry moves, and what the change needs before it is live.
 *
 * Every field is a closed domain: `EntryValue` is `boolean | SkillValue`, `Effect` is four
 * words, and `id` is a row id `/api/view` already published. Nothing here is text some
 * other module composed.
 *
 * `from`/`to` are the *resolved* values and `wasInFile`/`willBeInFile` the file's own
 * entry, kept apart for the reason `EntryChange` keeps them apart -- on an inverted
 * container they disagree, and a reviewer of a write is owed both.
 */
export interface PlanChangeView {
  id: string;
  from: EntryValue;
  to: EntryValue;
  wasInFile: EntryValue | null;
  willBeInFile: EntryValue | null;
  effect: Effect;
}

/** A plan, as the grid may see it. See the header for the three fields it refuses. */
export interface PlanView {
  /**
   * The handle an apply names. Minted by the server and opaque here.
   *
   * A parameter rather than something this file generates, because it is the server's
   * state and not the model's: the projection describes a plan, and which plan the server
   * is holding is the server's question.
   */
  id: string;
  /** `Axis.name` -- the word `--axis` takes. Never the record, which is functions. */
  axis: string;
  /** `projectId` of the directory written, matching the grid's column key. */
  project: string;
  /** The column's own label: a directory name or `~`, never a path. */
  projectLabel: string;
  /** Display form of the file written, by the same rule `renderSource` follows. */
  target: string;
  creates: boolean;
  changes: PlanChangeView[];
  /** Codes, never messages. See the header. */
  notes: ToggleNoteCode[];
  /** The worst verdict across the batch, from `planEffect` rather than restated here. */
  effect: Effect;
}

/**
 * How each axis writes the file it declares.
 *
 * A table keyed by `Axis.name`, checked against the path the axis itself builds -- so this
 * is a lookup by identity, exactly as `renderSource` is, and a fourth axis renders
 * `(unrecognised source)` rather than publishing a path nobody reviewed. The filesystem is
 * deliberately not consulted: the target of a plan that creates its file does not exist
 * yet, so a table built from files that do would fall through on exactly the plan that is
 * about to make one.
 */
const AXIS_TARGETS: ReadonlyMap<string, string> = new Map([
  ['plugin', '<project>/.claude/settings.local.json'],
  ['skill', '<project>/.claude/settings.local.json'],
  ['mcp', '~/.claude.json'],
]);

function renderTarget(ws: Workspace, plan: TogglePlan): string {
  if (plan.target !== plan.axis.target(ws, plan.project)) return UNRECOGNISED_SOURCE;
  return AXIS_TARGETS.get(plan.axis.name) ?? UNRECOGNISED_SOURCE;
}

/**
 * A plan, field by field.
 *
 * The project is looked up rather than derived, so a plan for a directory that is not a
 * column cannot be described: the grid's own column set is what `projectId` and `labelFor`
 * are defined against, and a label for anything else would be a basename this module has
 * no display rule for. `null` is the answer, and the caller's answer to `null` is to refuse
 * -- which it can only do if this returns one rather than inventing a column.
 */
export function planView(ctx: AuditContext, plan: TogglePlan, id: string): PlanView | null {
  const record = columnRecords(ctx).find((r) => r.path === plan.project);
  if (!record) return null;

  return {
    id,
    axis: plan.axis.name,
    project: projectId(record.path),
    projectLabel: labelFor(record, ctx.ws),
    target: renderTarget(ctx.ws, plan),
    creates: plan.creates,
    changes: plan.changes.map((c) => ({
      id: c.id,
      from: c.from,
      to: c.to,
      wasInFile: c.wasInFile,
      willBeInFile: c.willBeInFile,
      effect: c.effect.effect,
    })),
    notes: plan.notes.map((n) => n.code),
    effect: planEffect(plan),
  };
}

/**
 * What an apply says afterwards.
 *
 * `bytes` and `rebased` are the two facts a person watching a write wants and neither is
 * a path. `backup` is deliberately absent -- it is an absolute path into this tool's state
 * directory, and the terminal that started the server prints it (`ServeOptions.log`), which
 * is where a path belongs. `ApplyRefusalCode` crosses; `message` and `evidence` do not,
 * for the reason notes do not.
 */
export type ApplyView =
  | { outcome: 'written'; bytes: number; rebased: boolean }
  | { outcome: 'refused'; code: string };

export function applyView(result: ApplyResult): ApplyView {
  return result.outcome === 'written'
    ? { outcome: 'written', bytes: result.bytes, rebased: result.rebased }
    : { outcome: 'refused', code: result.code };
}
