/**
 * Planning a write: what it would change, and everything that stops it.
 *
 * This is the first thing in the repo that decides to modify a user's Claude Code
 * configuration. It decides only -- `apply.ts` is what writes -- and it is split that way
 * so every refusal is reachable without a filesystem and every gate below can run over a
 * plan that was never applied.
 *
 * ## Three axes, one path (QM-45, QM-46)
 *
 * `enabledPlugins` and `skillOverrides` are different keys holding different value
 * domains in the same file, and everything between the two -- the target, the seed, the
 * three refusals, the staging, the diff, the backup, the undo -- is the same. So the
 * difference is a value (`Axis`, below) and not a second copy of this module.
 *
 * **The third axis fits the record and did not fit the record as written (QM-46).** MCP
 * scoping is a per-project decision stored in the *user's* file, as a flat deny-list whose
 * polarity is inverted -- an entry means *off* -- so `settingsKey`, `entries(file)`, a
 * `targetFor` hardcoding `<proj>/.claude/settings.local.json` and a seed that is a settings
 * document were each a settings-shaped fact wearing an axis-shaped name. They are widened
 * rather than forked: the target, the container, the chain surgery and the undo unit become
 * fields, and the diff, the confirmation, the checks, the backup and the CLI are untouched.
 * A third copy of the consent model is the outcome that was being avoided; an `Axis`
 * contorted until it describes nothing is the other one, and the test for having avoided
 * both is that every field below names something the three axes genuinely disagree about.
 *
 * ## The files it writes, and the one it must not
 *
 * `<project>/.claude/settings.local.json` and `~/.claude.json`, each reachable only from
 * the axis that declares it. `settings.json` is tracked config that belongs to the repo
 * rather than to this machine, and no axis may name it. `apply.ts`'s final guard reads the
 * registry rather than a literal, because "we only ever build the right path" is a promise
 * with no way to fail loudly.
 *
 * ## Why the drift guard does not span the confirmation (QM-46)
 *
 * `~/.claude.json` is written by every live session. Sampled every 3s for 72s with ordinary
 * sessions running: **6 content changes in 72s, a mean interval of 11.5s**, gaps of 6, 3,
 * 9, 18, 12 and 21 seconds. A human reading a printed diff and typing `y` takes longer than
 * that, so a byte-level guard spanning the confirmation refuses on nearly every attempt --
 * not as a race someone engineered but as the ordinary case. DEA-112's stage-then-confirm
 * -then-apply works on `settings.local.json` because nothing else writes it; lifted here
 * unchanged it would make a command that never applies anything.
 *
 * So the plan holds **edits and a precondition**, not bytes to be written back. `applyPlan`
 * re-reads on confirmation, re-applies the same batch to the fresh bytes, and hands
 * `applyStage` a read-modify-write measured in milliseconds. What is re-checked after that
 * second read is the *semantic* precondition -- the id's own entry in the target still says
 * what the plan said it said -- and not that the file is byte-identical to what the human
 * saw. Those are different questions and only the first is the user's. The reviewed diff
 * stays binding on the entries it changes rather than on every byte of the file, which on
 * the two quiet axes is a distinction with no difference and here is the whole design.
 *
 * ## Why a refusal rather than a write
 *
 * Three of the checks below stop a write that would *appear* to work: the file is
 * discarded, or the key is ignored, or the value already resolves the way it was asked
 * for. Each produces valid JSON, a zero exit code, and no change in behaviour -- which is
 * DEA-145's failure exactly, and this repo has paid for it once already.
 *
 * **The safe direction is a property of the consumer, not of the classifier (DEA-112).**
 * DEA-151 sends a `doctor` message it cannot place to `not-checked`, because for a
 * *reporting* tool a wrong `discarded` fabricates a high-severity finding about working
 * config while a wrong `not-checked` only loses a detection. For a *writing* tool the
 * asymmetry runs the other way: a file that might be discarded is a write that might not
 * land, and the user has no way to notice. So `targetValidity` refuses on `discarded`
 * **and** on `not-checked` carrying schema errors -- the state DEA-151 built precisely so
 * that an unrecognised first-party message would be visible. It is visible here as a
 * refusal.
 *
 * That is not hypothetical. Measured on 2.1.224, `enabledPlugins.<id>: 42` makes `doctor`
 * print `Invalid input`, which `costOf` recognises as nothing and which therefore reads
 * `not-checked` -- and `claude plugin list --json` in the same directory reports the
 * file's other entries as **not applied**. A rule keyed on `discarded` alone would have
 * written into it. The recording is `test/fixtures/doctor/unplaced-plugin-entry/`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';

import type { AuditContext } from './detect.ts';
import {
  buildDeferralIndex,
  classify,
  worstEffect,
  type Classification,
  type Effect,
  type PendingChange,
  type WriteTarget,
} from './effect.ts';
import { buildMcpCatalog } from './mcp.ts';
import {
  PROJECT_SCOPES,
  SKILL_VALUES,
  resolveCell,
  type Cell,
  type ChainLink,
  type SkillValue,
} from './model.ts';
import { resolveMcpServer, resolvePlugin, resolveSkill } from './resolve.ts';
import { applyEdits, stageEdits, type Edit, type Stage } from './surfaces/write.ts';
import type { ProjectRecord, SettingsFile, Workspace } from './surfaces/types.ts';

/** The filename the settings axes write. Read by `apply.ts`'s last guard. */
export const TARGET_FILENAME = 'settings.local.json';

/** The filename the MCP axis writes -- the user's, never a project's. */
export const CLAUDE_JSON_FILENAME = '.claude.json';

/**
 * Everything a settings entry can be, across every axis this writes.
 *
 * A union and not a type parameter, deliberately. `Cell<V>` is generic because the
 * resolver is a piece of algebra with no opinion about `V`; this module is the opposite,
 * and the two concrete domains reach four places that cannot be generic anyway --
 * `UndoRecord` is JSON on disk, `apply.ts` never knows which axis it is applying,
 * `describePlan` returns strings, and the CLI parses one grammar. Threading `<V>` through
 * all of them to express a set of two would be flexibility nobody asked for, and
 * `Axis.show` alone would make `Axis<boolean>` unassignable to `Axis<unknown>`.
 */
export type EntryValue = boolean | SkillValue;

/**
 * What a target that does not exist yet is created as, and what undo restores it to.
 *
 * Inert rather than finished, so the create and the edit stay two separable steps: the
 * create is exclusive (`wx`) and decides nothing, and the edit goes through
 * `stageEdits`/`applyStage` like every other write in this repo. It is also what makes
 * undo an ordinary restore -- undoing a write that created its own file returns the file
 * to this text rather than deleting it, because deleting a file is not something this
 * tool does.
 *
 * It declares the axis's key **empty**, which merges to nothing and is what an absent key
 * already means, and it is laid out over three lines on purpose. `write.ts` copies a
 * document's own layout rather than choosing one -- indent unit, colon spacing, line
 * ending -- so a seed of `{}` is a document with no layout to copy and the first entry
 * would be spliced in compact, fixing that shape for every later edit. Two spaces and a
 * key already present is the smallest seed that makes the file Claude Code writes.
 *
 * A function of the key rather than one constant, because seeding a skills write with
 * `enabledPlugins` would create a file whose only content is a key the write does not
 * touch -- and `undo` would then restore *that*, leaving a plugin block behind on a
 * target this tool created for a skill.
 */
export const emptySettings = (settingsKey: string): string => `{\n  "${settingsKey}": {}\n}\n`;

export const targetFor = (projectPath: string): string =>
  join(projectPath, '.claude', TARGET_FILENAME);

/**
 * Whether the workspace attests an id's spelling, and what it costs if it does not.
 *
 * The key a write emits has to be the key Claude Code matches (DEA-145): a
 * `plugin:<marketplace id>:<server>` is a string no config file acts on, and emitting one
 * into a deny-list is that defect with a write attached. `null` from `Axis.attest` is an
 * axis that does not ask -- see the settings axes for why, which is QM-45's reasoning and
 * not an omission.
 */
export interface Attestation {
  /** Where this spelling came from. Printed, so a note can say what it rests on. */
  basis: string;
  /** Set when the spelling is this tool's own guess. A refusal body. */
  guessed: { message: string; evidence: string[]; fix: string } | null;
  /** Set when it is attested by something historical or by nothing. */
  note: string | null;
}

/**
 * One writable surface: which file and key it lands in, how it resolves, and what a user
 * may say.
 *
 * The registry, not a `switch`. Every axis-specific fact is a field here, so a check or a
 * note that reaches for one is visibly reaching for a *parameter* -- and the day a further
 * field is needed, the compiler names every axis that has not supplied it. That is
 * DEA-145's rule about required parameters applied to a record: there is no default axis
 * and no default anything on one.
 */
export interface Axis {
  /** The word `--axis` takes. `AXES` is keyed by it, and `UndoRecord` stores it. */
  name: string;
  /** The key entries land in, as the diff header and the refusals name it. */
  writtenKey: string;
  /** The noun the notes and refusals use for one row on this axis. */
  noun: string;
  /** The value an id resolves to where nothing mentions it. */
  fallback: EntryValue;
  /**
   * Whether `fallback` is Claude Code's own answer or this model's silence (QM-46).
   *
   * `true` on the settings axes: an unmentioned plugin really does not load and an
   * unmentioned skill really is `on`, so a request for that value is a request for the
   * state the project is already in. **`false` on the MCP axis**, where a claude.ai
   * connector nothing on disk mentions resolves `false` and may well be loading -- `mcp.ts`
   * says so in as many words, and reading that `false` as "already off" would refuse the
   * single commonest real write on this axis. Measured: 22 of the 34 distinct names in this
   * machine's deny-lists are connectors, every one of which was in exactly that state
   * before someone denied it.
   */
  fallbackDecides: boolean;
  /**
   * Every spelling `<id>=<value>` accepts, in the order `--help` lists them.
   *
   * A map and not a parser, so the accepted set is inspectable: a test can assert that
   * the skill axis offers four distinct values and that none of them is a boolean, which
   * is the "four-valued write collapsing to boolean" mutation stated as data.
   */
  spellings: ReadonlyMap<string, EntryValue>;
  /** How the id resolves in this project today, chain and all. */
  resolve(ws: Workspace, project: ProjectRecord, id: string): Cell<EntryValue>;
  /** The file this write lands in for one project. */
  target(ws: Workspace, project: string): string;
  /**
   * The bytes an absent target is created as, or `null` where this axis may not create it.
   *
   * `null` is not "create it empty". `~/.claude.json` arriving on a machine that has none
   * carries a `machineID` and a `userID` the user did not have (DEA-140), so a tool that
   * discloses first-party subcommands creating it must not create it itself.
   *
   * A field and not part of `target`, because `apply.ts` writes these bytes and holds no
   * workspace to ask for them -- and a plan carrying its own seed could decide what the
   * exclusive create writes, which is the authority `test/apply.test.ts` pins to the axis.
   */
  seed: string | null;
  /**
   * Whether a path is one this axis may write for this project.
   *
   * Separate from `target` because `apply.ts` holds a plan and not a workspace, and the
   * guard has to be answerable from the plan alone -- a guard that re-derived the path
   * from the same data the plan was built with would agree with whatever the plan says
   * (the `memorySlug` defect). The settings axes answer exactly; the MCP axis answers on
   * the basename, because the directory is `Workspace`'s to know and this predicate's to
   * take. That leaves `<anywhere>/.claude.json` acceptable to it, which is as far as it
   * goes: with `seed` null, the only such file this can write is one that already exists.
   */
  owns(target: string, project: string): boolean;
  /**
   * Where the per-project decision is stored, which settles three questions at once
   * (QM-46).
   *
   * - `project-file` -- the target is the project's own settings file. `<home>` as a
   *   project *is* user scope there, so `homeCollision` fires; nothing has to be registered
   *   anywhere; and the file decides one project by construction.
   * - `user-file` -- the target is `~/.claude.json` and the decision is a value under
   *   `projects[<abspath>]`. **The `~` collision does not apply**, checked rather than
   *   assumed: `projects[<home>]` is an ordinary key beside 151 others, so the issue's
   *   "something else has to" replace that guard should be read as "check, then say
   *   nothing". What does apply is that the entry has to exist to be edited, and that the
   *   file is shared by every project on the machine -- hence `unregisteredProject` and
   *   the `shared-file` note.
   *
   * One field rather than three booleans, because the three answers are one fact and
   * booleans that always move together are a fact that has been written down three times.
   */
  stored: 'project-file' | 'user-file';
  /** The settings file whose schema validity gates this write, where one gates it. */
  validated(record: ProjectRecord): SettingsFile | null;
  /** Whether the workspace attests this id's spelling. `null` where the axis does not ask. */
  attest(ctx: AuditContext, id: string): Attestation | null;
  /**
   * Another entry that would contest this write, where the axis has one to contest it.
   *
   * `null` on the settings axes: precedence there is total and this repo's whole model of
   * it is `resolveCell`, so no second entry at the same scope can exist for the resolver to
   * be unsure about. The MCP axis is the one that can, because `resolveMcpServer` pushes a
   * deny and an allow at the same scope out of the same file.
   */
  contested(
    record: ProjectRecord | null,
    req: ToggleRequest,
  ): { message: string; evidence: string[]; fix: string } | null;
  /** This id's own entry in the target document, `null` when it holds none. */
  entryIn(doc: unknown, project: string, id: string): EntryValue | null;
  /** The entry a requested value lands as; `null` where it lands as no entry at all. */
  entryFor(value: EntryValue): EntryValue | null;
  /**
   * The batch that makes each id's entry read its wanted state.
   *
   * `null` for a state this axis cannot express -- removing an object member, which
   * `write.ts` has no operation for. It is a return value and not an assertion because it
   * is the same fact `undo` states from the other side, and one of the two has to be the
   * one a caller checks.
   */
  editsFor(
    doc: unknown,
    project: string,
    wanted: ReadonlyMap<string, EntryValue | null>,
  ): Edit[] | null;
  /** The chain this write produces, out of the one it resolves against today. */
  afterChain(
    now: Cell<EntryValue>,
    target: string,
    value: EntryValue,
  ): ChainLink<EntryValue>[];
  /** What `classify` is asked about one change here. */
  pending(id: string, project: string, target: WriteTarget | null): PendingChange;
  /**
   * What undo puts back: the whole file, or only the entries this write changed (QM-46).
   *
   * Not a preference. On a file nothing else writes, the whole-file restore is strictly
   * stronger -- it reverts every key the batch touched and its guard, "the file still
   * hashes to what this tool left there", is meaningful. On `~/.claude.json` the same
   * operation is a guaranteed loss of every `lastCost` and `lastSessionId` written since,
   * and the guard would refuse within ~11.5s of the apply, so undo would simply never work.
   * The unit follows the file's contention, and the record says which one it took.
   */
  undo: 'file' | 'entries';
}

/**
 * A settings axis: one key of `<project>/.claude/settings.local.json`.
 *
 * The two share every field but `writtenKey`, `fallback`, `spellings`, `noun`, `resolve`
 * and `pending`, so the shape is built once here. Spelled out as a function rather than
 * a spread of one axis over another, so neither is the other's special case.
 */
function settingsAxis(
  base: Pick<
    Axis,
    'name' | 'writtenKey' | 'noun' | 'fallback' | 'spellings' | 'resolve' | 'pending'
  >,
): Axis {
  const key = base.writtenKey;
  return {
    ...base,
    fallbackDecides: true,
    target: (_ws, project) => targetFor(project),
    seed: emptySettings(key),
    owns: (target, project) => target === targetFor(project),
    stored: 'project-file',
    validated: (record) => record.localSettings,
    contested: () => null,
    // QM-45's call, unchanged: the catalogs that would answer exclude `stale` and
    // `unmeasured` rows, so an unknown-id refusal built on them would refuse real writes.
    // A mistyped id still writes a key nothing matches, and that is reported as the cost of
    // this rather than fixed here.
    attest: () => null,
    entryIn: (doc, _project, id) => {
      const block = (doc as Record<string, unknown> | null)?.[key];
      if (block === null || typeof block !== 'object') return null;
      const value = (block as Record<string, unknown>)[id];
      return value === undefined ? null : (value as EntryValue);
    },
    entryFor: (value) => value,
    editsFor: (doc, _project, wanted) => {
      const out: Edit[] = [];
      const fresh: Record<string, EntryValue> = {};
      const block = (doc as Record<string, unknown> | null)?.[key];
      // An **empty** block takes the whole-key shape, like an absent one. `write.ts`
      // copies the separator between two existing members, and an empty container has
      // none to copy, so a per-entry insert into `{}` splices in compact and fixes that
      // shape for every later edit. Writing the key whole instead renders it with the
      // document's own indent unit -- which is the entire reason `emptySettings` seeds a
      // file with a layout rather than with `{}` (DEA-112), and which used to hold only
      // because a file that did not exist arrived here as a `null` `SettingsFile`.
      const hasEntries =
        block !== null && typeof block === 'object' && Object.keys(block).length > 0;
      for (const [id, value] of wanted) {
        // `write.ts` splices values; it has no way to delete an object member, so the
        // state "this file says nothing about the id" is unreachable from here.
        if (value === null) return null;
        if (hasEntries) out.push({ path: [key, id], value });
        else fresh[id] = value;
      }
      return hasEntries ? out : [{ path: [key], value: fresh }];
    },
    afterChain: (now, target, value) => [
      ...now.chain.filter((l) => l.source !== target),
      { scope: 'local', value, source: target },
    ],
    undo: 'file',
  };
}

export const PLUGIN_AXIS: Axis = settingsAxis({
  name: 'plugin',
  writtenKey: 'enabledPlugins',
  noun: 'plugin',
  fallback: false,
  resolve: (ws, project, id) => resolvePlugin(ws, project, id),
  pending: (id, project, target) => ({
    kind: 'plugin',
    id,
    project,
    ...(target ? { target } : {}),
  }),
  // `true`/`false` as well as `on`/`off`, because this key holds JSON booleans and a user
  // reading the file sees them. Both spellings predate QM-45 and are kept.
  spellings: new Map<string, EntryValue>([
    ['on', true],
    ['off', false],
    ['true', true],
    ['false', false],
  ]),
});

/**
 * The four-valued axis, spelled exactly as `SKILL_VALUES` declares it.
 *
 * Built *from* `SKILL_VALUES` rather than beside it, so a fifth state added to the model
 * is a spelling the CLI accepts on the same commit rather than one it silently rejects.
 * No `true`/`false` here: a boolean is not one of the four, and accepting it would mean
 * choosing which of `on` and `name-only` a `true` meant -- which is the collapse this
 * axis exists to avoid, arriving through the grammar instead of through the write.
 */
export const SKILL_AXIS: Axis = settingsAxis({
  name: 'skill',
  writtenKey: 'skillOverrides',
  noun: 'skill',
  fallback: 'on',
  resolve: (ws, project, id) => resolveSkill(ws, project, id),
  pending: (id, project, target) => ({
    kind: 'skill',
    id,
    project,
    ...(target ? { target } : {}),
  }),
  spellings: new Map<string, EntryValue>(SKILL_VALUES.map((v) => [v, v])),
});

const MCP_AXIS_KEY = 'disabledMcpServers';

/** The MCP deny-list key, as a JSON path into `~/.claude.json`. */
const denyListPath = (project: string): (string | number)[] => [
  'projects',
  project,
  MCP_AXIS_KEY,
];

/** The deny-list this document holds for one project, or `null` when it holds none. */
function denyList(doc: unknown, project: string): string[] | null {
  const entry = (doc as { projects?: Record<string, unknown> } | null)?.projects?.[project];
  if (entry === null || typeof entry !== 'object') return null;
  const list = (entry as Record<string, unknown>)[MCP_AXIS_KEY];
  return Array.isArray(list) && list.every((n) => typeof n === 'string') ? (list as string[]) : null;
}

/**
 * The deny-list axis: `~/.claude.json` -> `projects[<abspath>].disabledMcpServers`.
 *
 * **The container is a list with inverted polarity, and that is what the fields above are
 * for.** Presence means *off*, so `entryFor(true)` is `null` -- turning a server on is
 * removing its entry rather than writing one -- and `editsFor` appends one element to add
 * and rewrites the array to remove, because `write.ts` can splice a value in and cannot
 * take one out.
 *
 * **`enabledMcpServers` is read and never written.** `resolveMcpServer` reads both lists
 * and pushes both at `project` scope, so which of the two wins is decided by the order this
 * repo happens to push them in -- a reverse-engineered ordering nothing has measured
 * against the live binary. Writing a deny for a name the allow-list already holds would
 * therefore be a write whose effect this tool cannot state, which is why `contestedEntry`
 * refuses it instead. Three entries across three projects on this machine, so it is a
 * narrow guard and a real one.
 *
 * **The project entry is never created.** `write.ts` creates only the last segment of a
 * path, so a project `~/.claude.json` has never recorded refuses `no-such-path` rather than
 * having a `projects[<path>]` invented for it -- a claim about the machine this tool is not
 * entitled to make. `unregisteredProject` says so before the edit is reached.
 */
export const MCP_AXIS: Axis = {
  name: 'mcp',
  writtenKey: MCP_AXIS_KEY,
  noun: 'MCP server',
  fallback: false,
  fallbackDecides: false,
  spellings: new Map<string, EntryValue>([
    ['on', true],
    ['off', false],
  ]),
  resolve: (ws, project, id) => resolveMcpServer(ws, project, id),
  target: (ws) => ws.claudeJson.path,
  seed: null,
  owns: (target) => basename(target) === CLAUDE_JSON_FILENAME,
  stored: 'user-file',
  // Nothing validates `~/.claude.json` against a settings schema -- `doctor` reports on
  // settings files -- so there is no verdict to gate on and no file to attach one to. Not
  // `not-checked` by another name: that value says a measurement was attempted.
  validated: () => null,
  attest: (ctx, id) => attestMcpName(ctx, id),
  contested: (record, req) => {
    // Only a deny can be contested: `on` removes an entry rather than adding one, so there
    // is nothing beside it for the allow-list to disagree with.
    if (req.value !== false || !record?.entry?.enabledMcpServers?.includes(req.id)) return null;
    return {
      message:
        `${req.id} is already in this project's enabledMcpServers, and which of an allow and ` +
        'a deny Claude Code honours is not something this tool has measured — so a deny ' +
        'written beside it might decide nothing.',
      evidence: [`projects[${JSON.stringify(record.path)}].enabledMcpServers holds ${req.id}`],
      fix: `Remove ${req.id} from enabledMcpServers first, then try again.`,
    };
  },
  entryIn: (doc, project, id) => (denyList(doc, project)?.includes(id) ? false : null),
  entryFor: (value) => (value ? null : false),
  editsFor: (doc, project, wanted) => {
    let list = denyList(doc, project);
    const out: Edit[] = [];
    for (const [id, value] of wanted) {
      const present = list?.includes(id) ?? false;
      if (value === null) {
        if (!present) continue;
        list = list!.filter((n) => n !== id);
        out.push({ path: denyListPath(project), value: list });
        continue;
      }
      if (present) continue;
      if (list === null) {
        list = [id];
        out.push({ path: denyListPath(project), value: list });
        continue;
      }
      // Appending by index puts one element in and moves no other byte, where rewriting
      // the array would re-encode every name in it. Removal has no such shape.
      out.push({ path: [...denyListPath(project), list.length], value: id });
      list = [...list, id];
    }
    return out;
  },
  afterChain: (now, target, value) => {
    // This axis's own links are the deny/allow entries: `project` scope, in the target
    // file. A `.mcp.json` declaration is also `project` scope and survives, because its
    // source is its own file; a user-scope launch spec lives in this same file and
    // survives on its scope. Filtering on the path alone would take both.
    const rest = now.chain.filter(
      (l) => !(l.source === target && PROJECT_SCOPES.includes(l.scope)),
    );
    return value ? rest : [...rest, { scope: 'project', value, source: target }];
  },
  pending: (id, project) => ({ kind: 'mcp-server', name: id, project }),
  undo: 'entries',
};

/** The axes `--axis` names, in the order `--help` lists them. `plugin` is the default. */
export const AXES: ReadonlyMap<string, Axis> = new Map(
  [PLUGIN_AXIS, SKILL_AXIS, MCP_AXIS].map((a) => [a.name, a]),
);

/**
 * Where an MCP server name came from, and whether this tool made it up.
 *
 * The issue's headline refusal -- refuse when the plugin half was built from the
 * marketplace id -- protects **zero rows today**: measured across the live catalog, 7 rows
 * read `manifest`, 55 carry no plugin at all and **0** read `marketplace-id`. It is built
 * anyway, as a tripwire: DEA-145's defect is real and 2 of the 42 installed manifests here
 * are unreadable, so the day one of those plugins enumerates a server is the day this fires.
 *
 * **The live risk is the other 55.** They are claude.ai connectors and user-scope servers,
 * and 21 of them are named by no config file at all -- so denying one *mints* the key
 * exactly as the plugin case does, with no `keyBasis` to record where the string came from,
 * because `keyBasis` is documented as the basis of the *plugin half* and is `null` whenever
 * no plugin provides the row. So the basis is computed here, over the whole name, and the
 * connector case gets its own value rather than being left unmarked:
 *
 * - `manifest` / `marketplace-id`  a plugin provides it; `keyBasis` says which half-name.
 * - `config`        a config file on this machine holds this exact string. Copied, not built.
 * - `ever-connected` only `claudeAiMcpEverConnected` names it -- a set that only grows and
 *                    says nothing about today (`mcp.ts`), so the string is reconstructed
 *                    from a historical record.
 * - `unattested`    no source here produces this name at all.
 *
 * A plugin-provided row takes its plugin basis even where a config file echoes the same
 * string, because a name this tool built is a name it can have built wrong however many
 * deny-lists already carry the mistake -- which is precisely what DEA-145 measured.
 *
 * Neither `ever-connected` nor `unattested` refuses. All three deny-list forms are attested
 * on this machine (`claude.ai <Name>` 22, `plugin:X:Y` 7, bare 5), so the shapes are right
 * and what is missing is provenance rather than correctness; and a connector declared in
 * claude.ai leaves no trace here until it connects, so refusing an unattested name would
 * refuse on "this machine has seen it" while claiming to refuse on "Claude Code matches it".
 */
export function attestMcpName(ctx: AuditContext, id: string): Attestation {
  const entry = buildMcpCatalog(ctx.ws, ctx.inventories).entries.find((e) => e.name === id);
  if (entry?.keyBasis === 'marketplace-id') {
    return {
      basis: 'marketplace-id',
      guessed: {
        message:
          `The name of this server is built from a marketplace id because its plugin's ` +
          `manifest could not be read, and Claude Code namespaces by the manifest name — so ` +
          `the key this would write is one no config file matches.`,
        evidence: [
          `${id} comes from ${entry.fromPlugin}, whose .claude-plugin/plugin.json was unreadable`,
        ],
        fix: 'Reinstall or repair that plugin so its manifest name can be read, then try again.',
      },
      note: null,
    };
  }
  if (entry?.keyBasis === 'manifest') {
    return { basis: 'manifest', guessed: null, note: null };
  }
  if (entry && (entry.userScope || entry.declaredIn.length || entry.scopedIn.length)) {
    return { basis: 'config', guessed: null, note: null };
  }
  if (entry?.everConnected) {
    return {
      basis: 'ever-connected',
      guessed: null,
      note:
        `No config file on this machine holds the name ${JSON.stringify(id)}. It is ` +
        `reconstructed from claudeAiMcpEverConnected, which records that a connector ` +
        `connected once and never that it still does — so this write mints the key rather ` +
        `than copying one. The form is right: 22 of this machine's deny-list entries are ` +
        `spelled that way.`,
    };
  }
  return {
    basis: 'unattested',
    guessed: null,
    note:
      `Nothing on this machine names an MCP server ${JSON.stringify(id)} — not a launch ` +
      `spec, not a project's .mcp.json, not an enabled plugin's catalog entry, not the ` +
      `ever-connected set and no deny-list. The entry will be written and will match ` +
      `whatever Claude Code calls that server, if anything.`,
  };
}

/**
 * A value as the diff, the change line and the notes print it.
 *
 * `String` and not `JSON.stringify`, so a skill reads `on -> off` rather than
 * `"on" -> "off"`. The token printed is the JSON value's own text either way, which is
 * the property worth having: what the line says is what lands in the file.
 */
export const showValue = (value: EntryValue): string => String(value);

// ---------------------------------------------------------------------------
// Requests, refusals, notes
// ---------------------------------------------------------------------------

export interface ToggleRequest {
  id: string;
  /** The value to write. On the plugin axis `true` means the plugin loads here. */
  value: EntryValue;
}

export type ToggleRefusalCode =
  /** `--project` named a directory the workspace does not carry. */
  | 'no-such-project'
  /** The project *is* `~`, so its "project" settings file is the user-scope one. */
  | 'home-collision'
  /** Claude Code refuses the target file whole. */
  | 'target-discarded'
  /** `doctor` reported on the target in words this release cannot place. */
  | 'target-unplaced'
  /** A schema error names the axis's key, so what this writes is not in force. */
  | 'target-ignores-key'
  /** The id already resolves to the requested value here. */
  | 'no-change'
  /** The name this would write is one this tool built rather than one it was given. */
  | 'key-guessed'
  /** `~/.claude.json` has never recorded this project, so there is no entry to edit. */
  | 'unregistered-project'
  /** An allow-list entry contests the deny this would write, and neither is known to win. */
  | 'contested-entry'
  /** The target does not exist and this axis may not create it. */
  | 'target-missing'
  /** `write.ts` would not touch the file -- duplicate key, malformed JSON, and so on. */
  | 'edit-refused';

export interface ToggleRefusal {
  code: ToggleRefusalCode;
  /** One sentence, in the voice the CLI prints. */
  message: string;
  /** Verbatim specifics: a `doctor` line, a chain link, a `write.ts` refusal detail. */
  evidence: string[];
  /** What to do about it, where there is something to do. */
  fix?: string;
}

export type ToggleNoteCode =
  /** Nothing validated the target, so whether Claude Code applies it is unknown. */
  | 'not-validated'
  /** The target is not ignored by git, so the next `git add -A` commits it. */
  | 'tracked-path'
  /** No `git` on PATH, or the project is not a repository -- so nobody asked. */
  | 'gitignore-unchecked'
  /** The entry this writes is one `restated-entries` will report. */
  | 'would-restate'
  /** The target does not exist and will be created. */
  | 'creates-file'
  /** The name written is one this tool reconstructed rather than copied. */
  | 'minted-key'
  /** The entry moves and the resolved value does not, because no source declares the id. */
  | 'value-unmoved'
  /** The target is shared by every project, and this write decides one of them. */
  | 'shared-file';

export interface ToggleNote {
  code: ToggleNoteCode;
  message: string;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface EntryChange {
  id: string;
  /** What the id resolves to in this project today. */
  from: EntryValue;
  /**
   * What it would resolve to after the write.
   *
   * The *resolved* value and not the requested one (QM-46). On the settings axes they are
   * always equal, because the entry this writes is the highest-precedence link there is.
   * On the MCP axis they need not be: un-denying a connector nothing on disk declares
   * removes a real entry and leaves the cell reading `false` either way, and printing the
   * request there would say `false -> true` about a value that did not move. The `note`
   * for that case is `value-unmoved`.
   */
  to: EntryValue;
  /** The entry the target held for this id before the write, `null` for none. */
  wasInFile: EntryValue | null;
  /** The entry the target holds for it after, `null` for none. */
  willBeInFile: EntryValue | null;
  /** What `classify` says this change needs before it is live. */
  effect: Classification;
}

export interface TogglePlan {
  /** Which key this plan writes, and everything else that differs by axis. */
  axis: Axis;
  project: string;
  target: string;
  /** The target does not exist; applying creates it. */
  creates: boolean;
  /** The file as it was read for review -- the axis's seed when it is about to be created. */
  before: string;
  /**
   * The file as it would be, from the bytes reviewed.
   *
   * **Reviewed rather than binding, and that is the QM-46 change.** `applyPlan` re-reads
   * the target on confirmation and re-applies `edits` to whatever it finds, so on a file
   * another process writes every ~11.5s the bytes that land will differ from these -- in
   * the telemetry someone else wrote, never in the entries this plan is about. What stays
   * binding is `willBeInFile` per change, checked against the re-staged text; the run
   * prints when the rest of the file moved underneath.
   */
  after: string;
  edits: Edit[];
  changes: EntryChange[];
  notes: ToggleNote[];
}

export type PlanResult =
  | { outcome: 'planned'; plan: TogglePlan }
  | { outcome: 'refused'; refusals: ToggleRefusal[] };

/** How one requested id resolves now, and how it would resolve after the write. */
export interface ResolvedPair {
  now: Cell<EntryValue>;
  after: Cell<EntryValue>;
}

/** What every check is handed. Built once, so no check re-reads a file or re-resolves. */
export interface CheckInput {
  /** The axis being written. Every check that is axis-aware reads it from here. */
  axis: Axis;
  /** The workspace and its inventories, for the checks that ask a catalog. */
  ctx: AuditContext;
  home: string;
  project: string;
  /** `null` when the workspace does not carry this directory at all. */
  record: ProjectRecord | null;
  target: string;
  /** The settings file whose validity gates this write, or `null` where none does. */
  targetFile: SettingsFile | null;
  requests: readonly ToggleRequest[];
  /** Per requested id: how it resolves now, and how it would resolve after. */
  resolved: ReadonlyMap<string, ResolvedPair>;
  /** Per requested id, once: where its spelling came from. `null` where the axis is silent. */
  attested: ReadonlyMap<string, Attestation | null>;
  /**
   * Per requested id: the entry the target document holds for it today, `null` for none.
   *
   * Read from the file rather than from the model, because it is the half of the plan
   * `applyPlan` re-checks against the fresh bytes and the two have to be the same question.
   */
  entries: ReadonlyMap<string, EntryValue | null>;
}

/**
 * One reason a write does not happen.
 *
 * A list of named checks rather than a chain of `if`s inside `planToggles`, so that a
 * gate can drop exactly one and watch the suite go red. That is the whole reason for the
 * shape: `test/toggle.test.ts` runs the scenario table once per check with that check
 * removed, and every removal must cost a refusal. A guard nobody can delete is a guard
 * nobody has tested.
 */
export interface PlanCheck {
  name: string;
  run(input: CheckInput): ToggleRefusal[];
}

const homeCollision: PlanCheck = {
  name: 'home-collision',
  run: ({ axis, home, project, target }) =>
    axis.stored !== 'project-file' || resolvePath(project) !== resolvePath(home)
      ? []
      : [
          {
            code: 'home-collision',
            message:
              'The home directory is registered as a project, and its project-scope local ' +
              'settings file is the user-scope one — so a "project" write here lands on every ' +
              'project at once.',
            evidence: [`${target} is ~/.claude/${TARGET_FILENAME}`],
            fix: 'Name the project you meant with --project, or edit user scope deliberately.',
          },
        ],
};

/**
 * A project `~/.claude.json` has never recorded.
 *
 * `write.ts` creates only the last segment of a path, deliberately: building the missing
 * `projects[<abspath>]` would be inventing an entry Claude Code never registered, which is
 * a claim about the machine this tool is not entitled to assert. Without this the edit
 * refuses `no-such-path` naming an offset, which is true and says nothing a user can act
 * on. `ProjectRecord.registered` is the same question, already answered by the reader.
 *
 * Silent on the settings axes, whose decision lives in the project's own file and needs no
 * entry anywhere -- `qm set` on a brand-new project is exactly the case DEA-112 built the
 * create path for.
 */
const unregisteredProject: PlanCheck = {
  name: 'unregistered-project',
  run: ({ axis, record, project, target }) =>
    axis.stored === 'user-file' && record && !record.registered
      ? [
          {
            code: 'unregistered-project',
            message:
              `${target} has no entry for this project, and one is not invented here — Claude ` +
              'Code has not run in this directory, so there is nothing recorded to scope.',
            evidence: [`projects[${JSON.stringify(project)}] is absent`],
            fix: 'Start a session in this directory once, then try again.',
          },
        ]
      : [],
};

/** A source that would contest this write, on the axes that have one. */
const contestedEntry: PlanCheck = {
  name: 'contested-entry',
  run: ({ axis, record, requests }) =>
    requests.flatMap((req) => {
      const contest = axis.contested(record, req);
      return contest
        ? [
            {
              code: 'contested-entry' as const,
              message: contest.message,
              evidence: contest.evidence,
              fix: contest.fix,
            },
          ]
        : [];
    }),
};

/**
 * A name this tool built rather than one it was given (DEA-145).
 *
 * The refusal body comes from the axis, because what makes a spelling a guess differs by
 * axis and two of the three decline to ask at all. See `attestMcpName` for what the four
 * bases mean and for the measurement showing this fires on nothing today.
 */
const keyProvenance: PlanCheck = {
  name: 'key-provenance',
  run: ({ attested }) =>
    [...attested.values()].flatMap((a) =>
      a?.guessed ? [{ code: 'key-guessed' as const, ...a.guessed }] : [],
    ),
};

const line = (path: string, key: string, message: string) => `${path} › ${key}: ${message}`;

/**
 * Whether Claude Code would apply what is written here.
 *
 * Three refusals out of one question, because the three say different things to a user
 * and only one of them has a first-party repair. See the file header for why
 * `not-checked` *with errors* refuses: this consumer's cheap failure is the opposite of
 * the reporter's.
 */
const targetValidity: PlanCheck = {
  name: 'target-validity',
  run: ({ axis, targetFile }) => {
    if (!targetFile) return [];
    const { validity, schemaErrors, path } = targetFile;
    const evidence = schemaErrors.map((e) => line(path, e.key, e.message));

    if (validity === 'discarded') {
      return [
        {
          code: 'target-discarded',
          message:
            'Claude Code refuses this settings file against its schema, so an entry written ' +
            'into it would parse, report success, and change nothing.',
          evidence,
          fix: 'Run claude doctor in this project and fix the key it names, then try again.',
        },
      ];
    }

    if (validity === 'not-checked' && schemaErrors.length) {
      return [
        {
          code: 'target-unplaced',
          message:
            'claude doctor reported on this file in words this release does not recognise, so ' +
            'whether Claude Code still applies it was not decided — and a write that might not ' +
            'land is not one this tool makes.',
          evidence,
          fix: 'Run claude doctor in this project and fix what it names, then try again.',
        },
      ];
    }

    // Every partial acceptance leaves the file applying and one part of it not. If that
    // part is the key this writes, the write is as dead as it would be in a discarded
    // file -- and the validity says `field-dropped`, which is otherwise a green light.
    const named = schemaErrors.filter((e) => namesWrittenKey(axis, e.key));
    if (named.length) {
      return [
        {
          code: 'target-ignores-key',
          message:
            `Claude Code ignores ${axis.writtenKey} in this file, so a ${axis.noun} entry ` +
            'written here would decide nothing even though the rest of the file applies.',
          evidence: named.map((e) => line(path, e.key, e.message)),
          fix: 'Run claude doctor in this project and fix the key it names, then try again.',
        },
      ];
    }

    return [];
  },
};

/**
 * The key a schema error has to name for a write on this axis to be pointless.
 *
 * Downward only -- the axis's key dropped whole, or one of its entries. The upward
 * direction `effectDependsOn` needs (a parent key taking a child with it) has nothing to
 * match here, because every written key is already top-level and has no parent but the
 * document.
 *
 * The axis is a required first parameter for `pluginServerKey`'s reason (DEA-145): a
 * default would answer about `enabledPlugins` on a call site that meant `skillOverrides`,
 * and the wrong answer is the one that lets the write through.
 */
export function namesWrittenKey(axis: Axis, key: string): boolean {
  return key === axis.writtenKey || key.startsWith(`${axis.writtenKey}.`);
}

/**
 * A write that would change nothing about how the plugin resolves.
 *
 * Two shapes, one refusal. The target file may already carry the entry, in which case the
 * write is a literal no-op; or some other scope may already decide it, in which case the
 * new entry is a `restated-entries` finding and nothing else. Both are the same answer to
 * the user -- *it already resolves that way* -- and both are what `restated-entries`
 * exists to complain about, so a write tool that produced them would be manufacturing its
 * own audit's findings.
 *
 * **The criterion is the resolved value, and not `origin === 'restated'`, and that is a
 * correction to the brief this was written from (DEA-112).** `resolveCell` computes
 * `restated` against the chain with *both* project-scope links removed, so a local entry
 * that overrides the project's own checked-in `settings.json` back to the user-scope value
 * reads `restated` while doing real work: without it the plugin resolves the other way.
 * Refusing on `restated` would refuse exactly the write someone reaches for when a repo's
 * tracked settings disable something they want. It is reported as a note instead.
 *
 * **The comparison is equality over the whole domain, and on a four-valued axis that is
 * the whole check (QM-45).** `Object.is` and not a truthiness test, not `!==` against a
 * boolean, and not "is it the fallback": a skill resolving `name-only` and a request for
 * `user-invocable-only` are two different non-default states, and any comparison that
 * folds the four into on/off refuses that write while letting `name-only` -> `name-only`
 * through. Both halves of that are failures, and the second is the one that writes.
 *
 * **A third shape arrives with an inverted container, and the resolved value cannot see it
 * (QM-46).** On a deny-list, "on" is the *absence* of an entry, so a request for `on`
 * against a name nothing denies produces no edit at all -- the value moves nowhere and
 * there is nothing to write, which no comparison of `now.value` to the request detects,
 * because they differ. And the mirror case is the resolved value being right for the wrong
 * reason: an unmentioned connector resolves `false` here while very possibly loading, so
 * refusing `off` on the strength of that `false` would refuse the commonest real write on
 * this axis. `Axis.fallbackDecides` is what separates those, and `empty` is what catches
 * the first.
 */
const noChange: PlanCheck = {
  name: 'no-change',
  run: ({ axis, requests, resolved, target, entries }) => {
    const out: ToggleRefusal[] = [];
    for (const req of requests) {
      const state = resolved.get(req.id);
      if (!state) continue;
      const wanted = axis.entryFor(req.value);
      const held = entries.get(req.id) ?? null;

      // Nothing to write: the target's own entry is already exactly what this would put
      // there, including the case where "there" means "no entry".
      if (Object.is(held, wanted)) {
        out.push({
          code: 'no-change',
          message:
            wanted === null
              ? `${axis.writtenKey} does not name ${req.id} here, so there is no entry to remove.`
              : `${target} already sets ${req.id} to ${showValue(wanted)}.`,
          evidence: [`${target} › ${axis.writtenKey}`],
        });
        continue;
      }

      // Something else already decides it, so the entry would be inert -- but only where
      // an unmentioned id genuinely means what the model says it means.
      if (!Object.is(state.now.value, req.value)) continue;
      if (!state.now.chain.length && !axis.fallbackDecides) continue;
      out.push({
        code: 'no-change',
        message: `${req.id} already resolves to ${showValue(req.value)} in this project.`,
        evidence: describeChain(axis, state.now, req.value),
        fix: 'Nothing to write. An entry restating this would be a restated-entries finding.',
      });
    }
    return out;
  },
};

function describeChain(axis: Axis, cell: Cell<EntryValue>, value: EntryValue): string[] {
  if (!cell.chain.length) {
    return [`no settings file mentions it, and an unmentioned ${axis.noun} is ${showValue(value)}`];
  }
  return cell.chain.map((l) => `${l.scope}: ${showValue(l.value)} — ${l.source}`);
}

/**
 * The checks, in the order they are asked.
 *
 * A missing project record is not among them. It is a precondition rather than a policy:
 * with no record there is nothing to resolve against, so every check below would be
 * asking about a world that was not built. `planToggles` answers it before any of this.
 */
export const CHECKS: readonly PlanCheck[] = [
  homeCollision,
  unregisteredProject,
  targetValidity,
  keyProvenance,
  contestedEntry,
  noChange,
];

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * What the write would be, or why there is not one.
 *
 * `checks` is a parameter with the real list as its default, so a gate can run the same
 * scenarios with one guard missing. Nothing in `src/` passes it.
 */
export function planToggles(
  ctx: AuditContext,
  axis: Axis,
  projectPath: string,
  requests: readonly ToggleRequest[],
  checks: readonly PlanCheck[] = CHECKS,
): PlanResult {
  const project = resolvePath(projectPath);
  const record = ctx.ws.projects.find((p) => p.path === project) ?? null;
  if (!record) {
    return {
      outcome: 'refused',
      refusals: [
        {
          code: 'no-such-project',
          message: 'Nothing in the workspace covers this directory, so there is nothing to write into.',
          evidence: [project],
        },
      ],
    };
  }
  const target = axis.target(ctx.ws, project);
  const seed = axis.seed;
  const targetFile = axis.validated(record);
  const creates = !existsSync(target);

  if (creates && seed === null) {
    return {
      outcome: 'refused',
      refusals: [
        {
          code: 'target-missing',
          message:
            `${target} does not exist, and this tool does not create it — the file arrives ` +
            'carrying a machineID and a userID nobody asked for, which is why every ' +
            'first-party command that creates it is disclosed rather than imitated.',
          evidence: [target],
          fix: 'Start a Claude Code session once so it writes the file, then try again.',
        },
      ],
    };
  }

  // The document as it stands, read once and shared by the checks, the edits and the
  // preview. `creates` means the seed, which is the document the file is about to be.
  let doc: unknown;
  let before: string;
  const refuseEdit = (detail: string): PlanResult => ({
    outcome: 'refused',
    refusals: [
      { code: 'edit-refused', message: `The edit to ${target} was refused rather than guessed at.`, evidence: [detail] },
    ],
  });
  if (creates) {
    before = seed!;
  } else {
    before = readFileSync(target, 'utf8');
  }
  try {
    doc = JSON.parse(before);
  } catch (err) {
    return refuseEdit(`not-json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const resolved = new Map<string, ResolvedPair>();
  const attested = new Map<string, Attestation | null>();
  const entries = new Map<string, EntryValue | null>();
  for (const req of requests) {
    const now = axis.resolve(ctx.ws, record, req.id);
    // The chain this write produces, from the axis rather than restated here: which link
    // is the target's own differs by axis, and the MCP one has two links at one scope out
    // of one file by construction (QM-43). The answer is taken from the real algebra.
    resolved.set(req.id, {
      now,
      after: resolveCell(axis.afterChain(now, target, req.value), axis.fallback),
    });
    attested.set(req.id, axis.attest(ctx, req.id));
    entries.set(req.id, axis.entryIn(doc, project, req.id));
  }

  const input: CheckInput = {
    axis,
    ctx,
    home: ctx.ws.home,
    project,
    record,
    target,
    targetFile,
    requests,
    resolved,
    attested,
    entries,
  };

  const refusals = checks.flatMap((c) => c.run(input));
  if (refusals.length) return { outcome: 'refused', refusals };

  const wanted = new Map<string, EntryValue | null>(
    requests.map((r) => [r.id, axis.entryFor(r.value)]),
  );
  const edits = axis.editsFor(doc, project, wanted);
  if (edits === null) {
    return refuseEdit(`${axis.writtenKey} cannot express one of the states this asks for`);
  }

  // Applied to the reviewed bytes by the same function `stageEdits` uses, on both paths.
  // The file is *not* staged here: on the contended axis a stage taken now would be stale
  // by the time anyone answers the prompt, and `applyPlan` re-reads and re-applies.
  const previewed = applyEdits(before, edits);
  if (previewed.outcome === 'refused') {
    return refuseEdit(`${previewed.refusal.reason}: ${previewed.refusal.detail}`);
  }
  const after = previewed.text;

  let afterDoc: unknown;
  try {
    afterDoc = JSON.parse(after);
  } catch (err) {
    return refuseEdit(`postcondition: ${err instanceof Error ? err.message : String(err)}`);
  }

  const index = buildDeferralIndex(ctx.measurements);
  const changes: EntryChange[] = requests.map((req) => ({
    id: req.id,
    from: resolved.get(req.id)!.now.value,
    to: resolved.get(req.id)!.after.value,
    wasInFile: entries.get(req.id) ?? null,
    willBeInFile: axis.entryIn(afterDoc, project, req.id),
    effect: classify(
      axis.pending(
        req.id,
        project,
        // Absent for a file about to be created and on the axis nothing validates: nothing
        // has validated a file that does not exist, and `not-checked` would claim a
        // measurement was attempted.
        //
        // Attached on every axis that has one rather than only on the plugin one, which is
        // what makes the header's "one mechanism, not two" true here as well: `classify`
        // answers `none` for a change into a discarded file, `targetValidity` refuses
        // exactly then, and neither is a restatement of the other.
        targetFile ? { source: targetFile.path, sourceValidity: targetFile.validity } : null,
      ),
      { index, inventories: ctx.inventories },
    ),
  }));

  return {
    outcome: 'planned',
    plan: {
      axis,
      project,
      target,
      creates,
      before,
      after,
      edits,
      changes,
      notes: notesFor(input, creates, resolved, changes),
    },
  };
}

/**
 * The edits, in the shape the file can take them.
 *
 * A file with no key for this axis gets one insert carrying every requested entry; a file
 * that has one gets an edit per entry, so the untouched entries are not re-encoded. That
 * difference is the whole of "surgical": the second shape rewrites nothing but the values
 * asked about, and the first adds one member and moves no other byte.
 *
 * A malformed block -- a number, a string -- is not special-cased. It reaches `write.ts`,
 * which refuses `not-a-container` naming the offset, and that refusal is a better answer
 * than any repair this could invent.
 *
 * `r.value` is written through unchanged, which is what keeps a four-valued axis
 * four-valued: nothing here maps a value onto anything, so `"name-only"` reaches the file
 * as `"name-only"` and there is no place for it to become `true`.
 */
export function editsFor(
  axis: Axis,
  doc: unknown,
  project: string,
  requests: readonly ToggleRequest[],
): Edit[] | null {
  return axis.editsFor(doc, project, new Map(requests.map((r) => [r.id, axis.entryFor(r.value)])));
}

function notesFor(
  input: CheckInput,
  creates: boolean,
  resolved: ReadonlyMap<string, ResolvedPair>,
  changes: readonly EntryChange[],
): ToggleNote[] {
  const notes: ToggleNote[] = [];

  if (creates) {
    notes.push({
      code: 'creates-file',
      message:
        `${input.target} does not exist and will be created. Undo restores it to ${JSON.stringify(
          emptySettings(input.axis.writtenKey).trim(),
        )} rather than removing it.`,
    });
  }

  // The file is shared, so what a reader of the diff is looking at is one project's entry
  // in a document holding every project's (QM-46). Said once per plan rather than left to
  // be inferred from a path.
  if (input.axis.stored === 'user-file') {
    notes.push({
      code: 'shared-file',
      message:
        `${input.target} holds this decision under projects[${JSON.stringify(input.project)}], ` +
        'beside every other project on this machine and beside the telemetry every live ' +
        'session writes. Only that one key is touched, and only the entries above in it.',
    });
  }

  for (const [id, attestation] of input.attested) {
    if (!attestation?.note) continue;
    notes.push({ code: 'minted-key', message: `${id}: ${attestation.note}` });
  }

  // The entry moves and the cell does not. Only reachable where `fallbackDecides` is false
  // -- elsewhere `noChange` refuses this shape rather than noting it -- and it is a note
  // because the write is real: it removes an entry that is really there, on a server this
  // model cannot see the live state of.
  for (const change of changes) {
    if (!Object.is(change.from, change.to)) continue;
    notes.push({
      code: 'value-unmoved',
      message:
        `${change.id}: the entry changes and the resolved value does not — nothing on disk ` +
        `declares this ${input.axis.noun}, so this model reads it ${showValue(change.to)} ` +
        'either way. What the write decides is whether the deny-list names it.',
    });
  }

  if (input.targetFile && input.targetFile.validity === 'not-checked') {
    notes.push({
      code: 'not-validated',
      message:
        'Nothing validated this file — claude doctor did not answer here — so whether Claude ' +
        'Code applies it is unknown. It resolves exactly as parsing alone has always made it.',
    });
  }

  const ignore = gitIgnoreState(input.project, input.target);
  if (ignore === 'tracked') {
    notes.push({
      code: 'tracked-path',
      message:
        `git does not ignore ${input.target}, so the next \`git add -A\` commits this machine's ` +
        'local configuration. Add `.claude/settings.local.json` to .gitignore if that is not what you want.',
    });
  } else if (ignore !== 'ignored') {
    notes.push({
      code: 'gitignore-unchecked',
      message:
        ignore === 'not-a-repo'
          ? 'This directory is not a git repository, so nothing was asked about ignoring the target.'
          : 'git is not on PATH, so whether the target is ignored was not checked.',
    });
  }

  for (const [id, state] of resolved) {
    // `round-trip` and not `restated` (QM-43). This note exists for the write whose value
    // moves while landing on what the project would have inherited, and that shape is
    // `round-trip` by definition now: a `restated` result means every project-scope entry
    // agrees with the winner, which is a write whose value did not move, which `noChange`
    // refused before reaching here. The sentence explaining why the old label was not to
    // be believed is gone with the label.
    //
    // **The dissenting link names itself now (QM-46).** This used to end "because the
    // repo's tracked settings.json says so", which QM-45 checked and found true *on the
    // settings axes* -- `contributingFiles` admits exactly two project-scope files, so the
    // link that disagrees could only be `settings.json`. It is false on the MCP axis, where
    // `resolveMcpServer` pushes two `project` links by construction and the disagreeing one
    // is a `.mcp.json` declaration. Reading the source off the link is both true everywhere
    // and one fewer thing to keep in agreement with `contributingFiles`.
    if (state.after.origin !== 'round-trip') continue;
    const dissent = state.after.chain.find(
      (l) => PROJECT_SCOPES.includes(l.scope) && !Object.is(l.value, state.after.value),
    );
    notes.push({
      code: 'would-restate',
      message:
        `${id} will resolve to ${showValue(state.after.value)}, which is what this project ` +
        `would inherit with its own project-scope entries taken out — but the entry is in ` +
        `force, not redundant: without it the ${input.axis.noun} resolves ` +
        `${showValue(dissent?.value ?? state.now.value)}, because ${dissent?.source ?? 'another project-scope entry'} says so.`,
    });
  }

  return notes;
}

/**
 * Whether git ignores the target path.
 *
 * `git check-ignore` and not a read of `.gitignore`: the answer depends on the repo's own
 * file, on every parent directory's, on `.git/info/exclude` and on `core.excludesFile` --
 * and on this machine it is the last of those that does the work. Measured 2026-08-10
 * across the 17 repositories under `~/claude`: **6** name `settings.local.json` in their
 * own `.gitignore`, and the other **11** are covered only by `~/.config/git/ignore`. So
 * the file is ignored *here* and is not ignored *by the repos*, and a cloud session or
 * anyone else's clone would commit it.
 *
 * Exit codes are git's: 0 ignored, 1 not ignored, 128 not a repository. Anything else,
 * and a missing binary, is "nobody asked" rather than either answer.
 *
 * The working directory is the **project**, never the target's parent: a target that is
 * about to be created usually sits in a `.claude/` that does not exist yet, and spawning
 * into a missing directory fails with the same `ENOENT` a missing `git` does -- so the
 * check reported "git is not on PATH" on precisely the runs it exists for.
 */
export function gitIgnoreState(
  projectDir: string,
  target: string,
): 'ignored' | 'tracked' | 'not-a-repo' | 'no-git' {
  const result = spawnSync('git', ['check-ignore', '-q', '--', target], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  if (result.error) return 'no-git';
  if (result.status === 0) return 'ignored';
  if (result.status === 1) return 'tracked';
  return 'not-a-repo';
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The plan, as lines.
 *
 * Returned rather than printed so the gate can read what the user reads. The effect lines
 * are `classify`'s own verdict and its own sentence -- there is no string here that says
 * what a change needs, because a second copy of that rule is a copy that can be right
 * while the classifier is wrong (DEA-123).
 *
 * **The header names the key, and the change lines name states rather than switches
 * (QM-45).** `foo: on -> name-only` and `bar: false -> true` are both read against the
 * `settingsKey` on the first line and against the same key in the diff below -- so a
 * four-valued change is legible without the reader having to know which axis was asked
 * for, and every state printed is a state the file is about to hold verbatim.
 */
export function describePlan(plan: TogglePlan): string[] {
  const out: string[] = [];
  out.push(`${plan.target}${plan.creates ? '  (new file)' : ''}  ·  ${plan.axis.writtenKey}`);
  out.push('');
  out.push(...unifiedDiff(plan.before, plan.after).map((l) => `  ${l}`));
  out.push('');

  for (const c of plan.changes) {
    out.push(`  ${c.id}: ${showValue(c.from)} -> ${showValue(c.to)}`);
    out.push(`    effect: ${c.effect.effect}`);
    out.push(`    ${c.effect.reason}`);
    for (const e of c.effect.evidence) out.push(`      · ${e}`);
  }

  if (plan.notes.length) {
    out.push('');
    for (const n of plan.notes) out.push(`  note (${n.code}): ${n.message}`);
  }

  return out;
}

/** The worst verdict across the batch, which is what the run's exit line reports. */
export function planEffect(plan: TogglePlan): Effect {
  return worstEffect(plan.changes.map((c) => c.effect.effect));
}

/**
 * A one-hunk line diff, with context.
 *
 * One hunk and not a real LCS: every edit this module makes lands inside `enabledPlugins`,
 * so the changed lines are adjacent and a common-prefix/common-suffix scan shows exactly
 * them. Two edits far apart in a large file would print the lines between them, which is
 * more than needed and never less -- the failure mode of a diff for *review* should be
 * showing too much.
 */
export function unifiedDiff(before: string, after: string, context = 3): string[] {
  const a = lines(before);
  const b = lines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  if (head === a.length && head === b.length) return ['(no change)'];

  const from = Math.max(0, head - context);
  const out: string[] = [`--- before (${a.length} lines)`, `+++ after (${b.length} lines)`];
  for (let i = from; i < head; i++) out.push(`  ${a[i]}`);
  for (let i = head; i < a.length - tail; i++) out.push(`- ${a[i]}`);
  for (let i = head; i < b.length - tail; i++) out.push(`+ ${b[i]}`);
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + context); i++) {
    out.push(`  ${a[i]}`);
  }
  return out;
}

/**
 * Lines, without the empty one a trailing newline produces.
 *
 * A file ending in `\n` has as many lines as it has newlines, and a diff that prints an
 * extra blank context line for every file is a diff that reads as if something changed
 * at the end of both.
 */
function lines(text: string): string[] {
  const out = text.split('\n');
  if (out.at(-1) === '') out.pop();
  return out;
}
