/**
 * Planning a write: what it would change, and everything that stops it.
 *
 * This is the first thing in the repo that decides to modify a user's Claude Code
 * configuration. It decides only -- `apply.ts` is what writes -- and it is split that way
 * so every refusal is reachable without a filesystem and every gate below can run over a
 * plan that was never applied.
 *
 * ## Two axes, one path (QM-45)
 *
 * `enabledPlugins` and `skillOverrides` are different keys holding different value
 * domains in the same file, and everything between the two -- the target, the seed, the
 * three refusals, the staging, the diff, the backup, the undo -- is the same. So the
 * difference is a value (`Axis`, below) and not a second copy of this module. What the
 * generalisation costs is that `planToggles` can no longer call `resolvePlugin` by name;
 * what it buys is that the third axis (QM-46, `~/.claude.json`'s deny-list) inherits every
 * guard here instead of forcing a third copy of the consent model.
 *
 * ## The one file it writes, and the two it must not
 *
 * `<project>/.claude/settings.local.json`, and nothing else. `settings.json` is tracked
 * config that belongs to the repo rather than to this machine, and `~/.claude.json` is
 * the 200KB file every live session writes telemetry into. Both are named in `apply.ts`'s
 * final guard rather than merely avoided by construction, because "we only ever build the
 * right path" is a promise with no way to fail loudly.
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
import { join, resolve as resolvePath } from 'node:path';

import type { AuditContext } from './detect.ts';
import {
  buildDeferralIndex,
  classify,
  worstEffect,
  type Classification,
  type Effect,
} from './effect.ts';
import { SKILL_VALUES, resolveCell, type Cell, type ChainLink, type SkillValue } from './model.ts';
import { resolvePlugin, resolveSkill } from './resolve.ts';
import { applyEdits, sha256, stageEdits, type Edit, type Stage } from './surfaces/write.ts';
import type { ProjectRecord, SettingsFile, Workspace } from './surfaces/types.ts';

/** The only filename this phase writes. Read by `apply.ts`'s last guard. */
export const TARGET_FILENAME = 'settings.local.json';

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
 * One writable surface: which key it lands in, how it resolves, and what a user may say.
 *
 * The registry, not a `switch`. Every axis-specific fact is a field here, so a check or a
 * note that reaches for one is visibly reaching for a *parameter* -- and the day a fourth
 * field is needed, the compiler names every axis that has not supplied it. That is
 * DEA-145's rule about required parameters applied to a record: there is no default axis
 * and no default anything on one.
 */
export interface Axis {
  /** The `ChangeKind` `classify` answers about, and the word `--axis` takes. */
  kind: 'plugin' | 'skill';
  /** The settings key entries land in. */
  settingsKey: string;
  /** The value an id resolves to where no settings file mentions it. */
  fallback: EntryValue;
  /** How the id resolves in this project today, chain and all. */
  resolve(ws: Workspace, project: ProjectRecord, id: string): Cell<EntryValue>;
  /** This axis's own block in a settings file, when the file has one. */
  entries(file: SettingsFile): Readonly<Record<string, EntryValue>> | undefined;
  /**
   * Every spelling `<id>=<value>` accepts, in the order `--help` lists them.
   *
   * A map and not a parser, so the accepted set is inspectable: a test can assert that
   * the skill axis offers four distinct values and that none of them is a boolean, which
   * is the "four-valued write collapsing to boolean" mutation stated as data.
   */
  spellings: ReadonlyMap<string, EntryValue>;
  /** The noun the notes and refusals use for one row on this axis. */
  noun: string;
}

export const PLUGIN_AXIS: Axis = {
  kind: 'plugin',
  settingsKey: 'enabledPlugins',
  fallback: false,
  resolve: (ws, project, id) => resolvePlugin(ws, project, id),
  entries: (file) => file.enabledPlugins,
  // `true`/`false` as well as `on`/`off`, because this key holds JSON booleans and a user
  // reading the file sees them. Both spellings predate QM-45 and are kept.
  spellings: new Map<string, EntryValue>([
    ['on', true],
    ['off', false],
    ['true', true],
    ['false', false],
  ]),
  noun: 'plugin',
};

/**
 * The four-valued axis, spelled exactly as `SKILL_VALUES` declares it.
 *
 * Built *from* `SKILL_VALUES` rather than beside it, so a fifth state added to the model
 * is a spelling the CLI accepts on the same commit rather than one it silently rejects.
 * No `true`/`false` here: a boolean is not one of the four, and accepting it would mean
 * choosing which of `on` and `name-only` a `true` meant -- which is the collapse this
 * axis exists to avoid, arriving through the grammar instead of through the write.
 */
export const SKILL_AXIS: Axis = {
  kind: 'skill',
  settingsKey: 'skillOverrides',
  fallback: 'on',
  resolve: (ws, project, id) => resolveSkill(ws, project, id),
  entries: (file) => file.skillOverrides,
  spellings: new Map<string, EntryValue>(SKILL_VALUES.map((v) => [v, v])),
  noun: 'skill',
};

/** The axes `--axis` names, in the order `--help` lists them. `plugin` is the default. */
export const AXES: ReadonlyMap<string, Axis> = new Map([
  ['plugin', PLUGIN_AXIS],
  ['skill', SKILL_AXIS],
]);

/**
 * A value as the diff, the change line and the notes print it.
 *
 * `String` and not `JSON.stringify`, so a skill reads `on -> off` rather than
 * `"on" -> "off"`. The token printed is the JSON value's own text either way, which is
 * the property worth having: what the line says is what lands in the file.
 */
export const showValue = (value: EntryValue): string => String(value);

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
  | 'creates-file';

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
  to: EntryValue;
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
  /** The file as it is -- `EMPTY_SETTINGS` when it is about to be created. */
  before: string;
  /** The file as it would be. Byte-for-byte what lands. */
  after: string;
  edits: Edit[];
  /**
   * The staged read of an existing target, holding its hash and mtime.
   *
   * `null` exactly when `creates`, because there is nothing to stage against until the
   * file exists. A created target is staged inside `applyPlan`, immediately after an
   * exclusive create, and the resulting text is compared against `after` -- so the
   * reviewed bytes are the applied bytes on both paths.
   */
  stage: Stage | null;
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
  home: string;
  project: string;
  /** `null` when the workspace does not carry this directory at all. */
  record: ProjectRecord | null;
  target: string;
  /** The target settings file, or `null` when it does not exist yet. */
  targetFile: SettingsFile | null;
  requests: readonly ToggleRequest[];
  /** Per requested id: how it resolves now, and how it would resolve after. */
  resolved: ReadonlyMap<string, ResolvedPair>;
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
  run: ({ home, project, target }) =>
    resolvePath(project) !== resolvePath(home)
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
            `Claude Code ignores ${axis.settingsKey} in this file, so a ${axis.noun} entry ` +
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
  return key === axis.settingsKey || key.startsWith(`${axis.settingsKey}.`);
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
 */
const noChange: PlanCheck = {
  name: 'no-change',
  run: ({ axis, requests, resolved, target }) => {
    const out: ToggleRefusal[] = [];
    for (const req of requests) {
      const state = resolved.get(req.id);
      if (!state || !Object.is(state.now.value, req.value)) continue;
      const here = state.now.chain.find((l) => l.source === target);
      out.push({
        code: 'no-change',
        message: `${req.id} already resolves to ${showValue(req.value)} in this project.`,
        evidence: here
          ? [`${target} already sets it to ${showValue(here.value)}`]
          : describeChain(axis, state.now, req.value),
        ...(here
          ? {}
          : { fix: 'Nothing to write. An entry restating this would be a restated-entries finding.' }),
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
export const CHECKS: readonly PlanCheck[] = [homeCollision, targetValidity, noChange];

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
  const target = targetFor(project);
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
  const targetFile = record.localSettings;

  const resolved = new Map<string, ResolvedPair>();
  for (const req of requests) {
    const now = axis.resolve(ctx.ws, record, req.id);
    // The chain this write produces: the target's own link replaced, everything else left
    // alone, and the answer taken from the real algebra rather than restated here.
    const link: ChainLink<EntryValue> = { scope: 'local', value: req.value, source: target };
    const after = resolveCell(
      [...now.chain.filter((l) => l.source !== target), link],
      axis.fallback,
    );
    resolved.set(req.id, { now, after });
  }

  const input: CheckInput = {
    axis,
    home: ctx.ws.home,
    project,
    record,
    target,
    targetFile,
    requests,
    resolved,
  };

  const refusals = checks.flatMap((c) => c.run(input));
  if (refusals.length) return { outcome: 'refused', refusals };

  const creates = !existsSync(target);
  const edits = editsFor(axis, targetFile, requests);
  const seed = emptySettings(axis.settingsKey);
  const refuseEdit = (detail: string): PlanResult => ({
    outcome: 'refused',
    refusals: [
      {
        code: 'edit-refused',
        message: `The edit to ${target} was refused rather than guessed at.`,
        evidence: [detail],
      },
    ],
  });

  let before: string;
  let stage: Stage | null = null;
  let after: string;

  if (creates) {
    // Nothing on disk to stage against. The batch is applied to the text the file will be
    // created as, by the same function `stageEdits` uses, and `applyPlan` re-stages after
    // the create and compares -- so what is reviewed is what lands on this path too.
    before = seed;
    const previewed = applyEdits(seed, edits);
    if (previewed.outcome === 'refused') {
      return refuseEdit(`${previewed.refusal.reason}: ${previewed.refusal.detail}`);
    }
    after = previewed.text;
  } else {
    const original = readFileSync(target);
    const staged = stageEdits(target, edits);
    if (staged.outcome === 'refused') {
      return refuseEdit(`${staged.refusal.reason}: ${staged.refusal.detail}`);
    }
    // The pre-image is read separately from the stage, so it has to be proved to *be* the
    // pre-image: `Stage.hash` is the hash of the bytes the stage was taken from, and these
    // bytes must match it or the file moved between the two reads. Compared with the
    // function that produced the hash, not a second one.
    //
    // **Ungated, and reported rather than removed.** Deleting this line leaves all 605
    // tests green: the window is the microseconds between two `readFileSync` calls inside
    // this function, and nothing outside it can open that window. What it protects is the
    // *review* and the *backup* rather than the write -- `applyStage` decides the write on
    // its own hash -- so its absence would show as a diff and a pre-image describing a
    // state that never existed, which is exactly the kind of thing nobody notices.
    if (sha256(original) !== staged.stage.hash) {
      return refuseEdit(`${target} changed while it was being read`);
    }
    before = original.toString('utf8');
    stage = staged.stage;
    after = staged.stage.text;
  }

  const index = buildDeferralIndex(ctx.measurements);
  const changes: EntryChange[] = requests.map((req) => ({
    id: req.id,
    from: resolved.get(req.id)!.now.value,
    to: req.value,
    effect: classify(
      {
        kind: axis.kind,
        id: req.id,
        project,
        // Absent for a file about to be created: nothing has validated a file that does
        // not exist, and `not-checked` would claim a measurement was attempted.
        //
        // Attached on both axes rather than only on the plugin one, which is what makes
        // the header's "one mechanism, not two" true here as well: `classify` answers
        // `none` for a change into a discarded file, `targetValidity` refuses exactly
        // then, and neither is a restatement of the other.
        ...(targetFile
          ? { target: { source: targetFile.path, sourceValidity: targetFile.validity } }
          : {}),
      },
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
      stage,
      changes,
      notes: notesFor(input, creates, resolved),
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
  targetFile: SettingsFile | null,
  requests: readonly ToggleRequest[],
): Edit[] {
  if (targetFile && axis.entries(targetFile)) {
    return requests.map((r) => ({ path: [axis.settingsKey, r.id], value: r.value }));
  }
  const value: Record<string, EntryValue> = {};
  for (const r of requests) value[r.id] = r.value;
  return [{ path: [axis.settingsKey], value }];
}

function notesFor(
  input: CheckInput,
  creates: boolean,
  resolved: ReadonlyMap<string, ResolvedPair>,
): ToggleNote[] {
  const notes: ToggleNote[] = [];

  if (creates) {
    notes.push({
      code: 'creates-file',
      message:
        `${input.target} does not exist and will be created. Undo restores it to ${JSON.stringify(
          emptySettings(input.axis.settingsKey).trim(),
        )} rather than removing it.`,
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
    // **The last clause is still true on the skill axis, and was checked rather than
    // assumed (QM-45).** Both axes take their project-scope links from `contributingFiles`,
    // which pushes `project` from `settings.json` and `local` from `settings.local.json`
    // and nothing else -- and the target's own link is filtered out of `after` above. So
    // the link that disagrees with the winner can only be the repo's tracked
    // `settings.json`, on either axis. It is *not* true of `resolveMcpServer`, which
    // pushes two `project` links by construction, so QM-46 has to revisit this sentence
    // rather than inherit it.
    if (state.after.origin !== 'round-trip') continue;
    notes.push({
      code: 'would-restate',
      message:
        `${id} will resolve to ${showValue(state.after.value)}, which is what this project ` +
        `would inherit with its own settings files taken out — but the entry is in force, ` +
        `not redundant: without it the ${input.axis.noun} resolves ` +
        `${showValue(state.now.value)}, because the repo's tracked settings.json says so.`,
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
  out.push(`${plan.target}${plan.creates ? '  (new file)' : ''}  ·  ${plan.axis.settingsKey}`);
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
