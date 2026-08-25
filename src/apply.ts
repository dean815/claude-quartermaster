/**
 * Applying a planned write, keeping the pre-image, and putting it back.
 *
 * Everything hazardous is already solved and tested in `surfaces/write.ts` (DEA-139):
 * `applyStage` refuses on mtime **or** sha256 drift, writes a same-directory temp with
 * the original mode, `fsync`s it, and renames. This file consumes that and adds the three
 * things it does not have -- creating a target that is not there yet, a timestamped
 * backup, and one undo.
 *
 * ## The drift window is this function, and not the human's decision (QM-46)
 *
 * `~/.claude.json` changes every ~11.5 seconds under ordinary use. A plan staged before a
 * prompt and applied after it therefore spans a window that will nearly always have had a
 * write in it, so a guard on those bytes refuses nearly always and the command applies
 * nothing. So the plan carries **edits and a precondition** and this function does the
 * read-modify-write: re-read, re-apply the same batch, check the precondition, hand
 * `applyStage` a stage a few milliseconds old. `applyStage`'s guard is unchanged and is
 * still the thing that decides the write; what changed is how long it is asked to cover.
 *
 * The precondition is **semantic**: every id's own entry in the target must still be what
 * the plan said it was, and the re-staged text must hold exactly what the plan said it
 * would. That is the user's question. Whether some other project's `lastCost` moved in the
 * meantime is not, and refusing on it is how the byte-level guard would have failed.
 *
 * What that does **not** re-check is the rest of the resolution chain -- a project's
 * `.mcp.json`, the settings files, the user-scope launch specs -- which were read at plan
 * time and are not re-read. They are not the contended file; `~/.claude.json` is, and the
 * one part of it this axis reads for resolution beyond its own entry is `mcpServers`, so a
 * launch spec removed inside the confirmation window would leave the printed `from`/`to`
 * describing a chain that has since moved. Named rather than closed: closing it means
 * re-reading the workspace between the prompt and the write.
 *
 * ## Undo is an apply, and its unit is the axis's
 *
 * Restoring a pre-image is a write to a file that has been sitting on disk since, so it
 * gets the same guard by going through the same function: `stageEdits` reads the file and
 * captures its hash and mtime, the restoring text is put on that stage, and `applyStage`
 * decides. What that guard cannot see is the *interesting* case -- an edit made
 * deliberately after the apply, by a person or by Claude Code -- because that edit is
 * minutes old and perfectly quiescent. So undo checks a second thing first, and *what* it
 * checks follows `Axis.undo`:
 *
 * - `file`   -- the whole file must still hash to what this tool left there, and the whole
 *   pre-image goes back. Right for `settings.local.json`, which nothing else writes.
 * - `entries` -- each changed entry must still hold what this tool wrote, and only those
 *   entries are put back. Right for `~/.claude.json`, where the whole-file restore would
 *   discard every `lastCost` and `lastSessionId` written since the apply, and where its
 *   hash guard would refuse within ~11.5s and undo would never run at all.
 *
 * ## What is never deleted
 *
 * Nothing. A target this tool created is undone back to `{}`, not removed, and a backup
 * blob is never unlinked -- including the orphans a refused apply leaves behind, which are
 * a few hundred bytes in this tool's own state directory. The alternative is a delete path
 * in the first phase that mutates a user's configuration, which is not a trade worth
 * making for tidiness.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { applyStage, stageEdits, type Stage } from './surfaces/write.ts';
import {
  AXES,
  TARGET_FILENAME,
  emptySettings,
  type Axis,
  type EntryValue,
  type TogglePlan,
} from './toggle.ts';

/**
 * This tool's own state, not the user's.
 *
 * `~/.local/state/claude-quartermaster/` already holds `baseline.json` and
 * `oracle-run.json`; backups join them rather than living beside the config they came
 * from, because a backup written into `<project>/.claude/` is a file the next audit has
 * to explain.
 */
export function stateDir(): string {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, 'claude-quartermaster');
}

export const backupsDir = (state: string): string => join(state, 'backups');
export const undoRecordPath = (state: string): string => join(state, 'last-apply.json');

/**
 * The last apply, and everything undo needs to refuse.
 *
 * Both hashes, because they answer different questions: `sha256Before` says the backup on
 * disk is the one this record is about, and `sha256After` says nothing has touched the
 * target since. A record carrying only one of them can restore the wrong bytes or clobber
 * a later edit, and there is no way to tell which from the outside.
 */
export interface UndoRecord {
  appliedAt: string;
  /** Which axis wrote it, by `Axis.name`. Decides what undo puts back (QM-46). */
  axis: string;
  project: string;
  target: string;
  backup: string;
  /** The target did not exist before this apply; undo returns it to `{}`. */
  createdTarget: boolean;
  sha256Before: string;
  sha256After: string;
  /**
   * What moved, in the axis's own value domain (QM-45).
   *
   * `id` rather than `pluginId`, and `EntryValue` rather than `boolean`, because the
   * record has to describe a skill write as accurately as a plugin one -- a four-valued
   * change flattened to a boolean here would print `true -> false` for
   * `name-only -> user-invocable-only`.
   *
   * `wasInFile` and `willBeInFile` are the *file's* entry either side of the write, and
   * `null` means "no entry" (QM-46). They are what an entry-scoped undo restores and what
   * it checks before restoring, so on that path they are load-bearing rather than display:
   * `from`/`to` are resolved values and cannot be written back into anything.
   */
  changes: Array<{
    id: string;
    from: EntryValue;
    to: EntryValue;
    wasInFile: EntryValue | null;
    willBeInFile: EntryValue | null;
  }>;
  /** Set once undo has run. One undo, and a second is refused rather than repeated. */
  undoneAt?: string;
}

export type ApplyResult =
  | {
      outcome: 'written';
      bytes: number;
      backup: string;
      record: UndoRecord;
      /**
       * The file moved between the review and the write, and the batch landed on the
       * bytes as they were then (QM-46).
       *
       * Reported rather than refused, and reported rather than silent: the entries this
       * plan is about are checked and unchanged, and everything else in the file belongs
       * to whoever wrote it. A run that quietly merged into someone else's write would be
       * asking to be trusted about the one thing nobody can see afterwards.
       */
      rebased: boolean;
    }
  | { outcome: 'refused'; code: ApplyRefusalCode; message: string; evidence: string[] };

export type ApplyRefusalCode =
  /** The plan names a file this phase promised never to write. */
  | 'forbidden-target'
  /** The target appeared between planning and applying. */
  | 'target-appeared'
  /** An id's entry in the target is no longer what the plan was made against. */
  | 'precondition-moved'
  /** The re-staged text does not hold what the plan said it would. */
  | 'preview-diverged'
  /** `write.ts` refused -- the file moved, vanished, or the edit does not fit. */
  | 'write-refused';

/**
 * The file only a promoted axis may write, named rather than merely not built.
 *
 * `settings.json` is the repo's own tracked configuration, and promoting a local decision
 * into it is a separate, explicit action -- which `toggle.ts`'s `promote` now is (QM-55).
 * The set still names it, and a promoted axis clears **only this** condition and only for
 * the path it builds itself; `owns` below is unchanged and independent, so `settings.json`
 * arriving on any axis `AXES` can return is refused exactly as it always was.
 *
 * **`~/.claude.json` left this set in QM-46 and did not become unguarded.** It is now the
 * MCP axis's declared target, and the guard below reads the *registry* -- a plan's target
 * must be the path its own axis builds for its own project -- so a path arriving from
 * anywhere else is still refused, and by a rule that cannot be satisfied by naming a file
 * some other axis happens to own.
 *
 * A basename set, so this catches a path arriving from anywhere: a caller building its own
 * plan, a future grid endpoint, a test tampering with one.
 */
export const FORBIDDEN_BASENAMES: ReadonlySet<string> = new Set(['settings.json']);

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export interface ApplyOptions {
  now: Date;
  /** Injected, so nothing under test writes into the user's real state directory. */
  state: string;
  /**
   * Called with the stage after it is taken and before anything is written.
   *
   * The seam the concurrency gate needs, and it exists for that (QM-46). Since the plan no
   * longer carries a stage, the window `applyStage` exists for is the microseconds inside
   * this function -- and a gate that cannot open that window is a gate that can only watch
   * the semantic precondition and call it the drift check. `test/apply.test.ts` writes to
   * the target from here and asserts the write is refused with the file intact. Nothing in
   * `src/` passes it, the way nothing in `src/` passes `planToggles`' `checks`.
   */
  onStaged?: (stage: Stage) => void;
}

/**
 * Write the plan.
 *
 * The order is deliberate: guard, create, stage, compare, back up, write, record. The
 * backup lands before the write so a crash between them costs an orphan blob rather than
 * an undo nobody can perform, and the record lands after it so an undo can never point at
 * a write that did not happen.
 */
export function applyPlan(plan: TogglePlan, opts: ApplyOptions): ApplyResult {
  const bannedName = FORBIDDEN_BASENAMES.has(basename(plan.target)) && !plan.axis.promotes;
  if (bannedName || !plan.axis.owns(plan.target, plan.project)) {
    return {
      outcome: 'refused',
      code: 'forbidden-target',
      message: 'A plan writes the file its own axis names for its own project, and nothing else.',
      evidence: [`the ${plan.axis.name} axis does not own ${plan.target}`],
    };
  }

  if (plan.creates) {
    const { seed } = plan.axis;
    if (seed === null) {
      return {
        outcome: 'refused',
        code: 'write-refused',
        message: `${plan.target} does not exist and the ${plan.axis.name} axis does not create it.`,
        evidence: [plan.target],
      };
    }
    mkdirSync(dirname(plan.target), { recursive: true });
    try {
      // Exclusive: if anything created this file between planning and now, the plan was
      // made against a file that does not exist and the one that does is not ours to
      // edit sight unseen.
      // The seed is derived from the plan's axis rather than taken from `plan.before`, so
      // a plan claiming to create a file cannot decide the bytes this writes. If the two
      // ever disagree the edits land differently and the `willBeInFile` postcondition
      // below refuses, which is the check that keeps them honest.
      writeFileSync(plan.target, seed, { flag: 'wx' });
    } catch (err) {
      return {
        outcome: 'refused',
        code: 'target-appeared',
        message: `${plan.target} appeared between planning and applying, so the reviewed diff is against a file that no longer describes it.`,
        evidence: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  // The read-modify-write, entire. Never the stage the plan was reviewed from: on the
  // contended axis that stage is stale by the time anyone answers a prompt, and the guard
  // it carries would refuse a write nothing is wrong with (QM-46).
  const staged = stageEdits(plan.target, plan.edits);
  if (staged.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${plan.target} could not be staged for the write.`,
      evidence: [`${staged.refusal.reason}: ${staged.refusal.detail}`],
    };
  }
  const stage: Stage = staged.stage;

  const moved = checkPreconditions(plan, stage);
  if (moved) return moved;

  const backup = writeBackup(plan, stage, opts);
  opts.onStaged?.(stage);
  const written = applyStage(stage);
  if (written.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${plan.target} moved after it was staged, so nothing was written.`,
      evidence: [`${written.refusal.reason}: ${written.refusal.detail}`],
    };
  }

  const record: UndoRecord = {
    appliedAt: opts.now.toISOString(),
    axis: plan.axis.name,
    project: plan.project,
    target: plan.target,
    backup,
    createdTarget: plan.creates,
    sha256Before: sha256(stage.original),
    sha256After: sha256(stage.text),
    changes: plan.changes.map((c) => ({
      id: c.id,
      from: c.from,
      to: c.to,
      wasInFile: c.wasInFile,
      willBeInFile: c.willBeInFile,
    })),
  };
  mkdirSync(opts.state, { recursive: true });
  writeFileSync(undoRecordPath(opts.state), `${JSON.stringify(record, null, 2)}\n`);

  return {
    outcome: 'written',
    bytes: written.bytes,
    backup,
    record,
    rebased: stage.original !== plan.before,
  };
}

/**
 * The two questions the re-read has to answer, and neither of them is about bytes.
 *
 * *Did the world move under the plan* -- every id's own entry in the target must still be
 * what the plan was made against, or the diff someone approved described a different
 * starting state. And *does the batch still do what it said* -- the re-staged text must
 * hold exactly the entry the plan promised, which is the reviewed diff made binding on the
 * entries it changes rather than on every byte of a file other processes write.
 *
 * `plan.after` is deliberately not compared. On a file written every ~11.5s it will differ
 * from the staged text for reasons that are nobody's business here, and refusing on it is
 * the design this issue exists to replace.
 */
function checkPreconditions(plan: TogglePlan, stage: Stage): ApplyResult | null {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(stage.original);
    after = JSON.parse(stage.text);
  } catch (err) {
    return {
      outcome: 'refused',
      code: 'preview-diverged',
      message: `${plan.target} did not parse when it was re-read, so nothing was written.`,
      evidence: [err instanceof Error ? err.message : String(err)],
    };
  }

  for (const change of plan.changes) {
    const held = plan.axis.entryIn(before, plan.project, change.id);
    if (!Object.is(held, change.wasInFile)) {
      return {
        outcome: 'refused',
        code: 'precondition-moved',
        message:
          `${change.id} is no longer what it was when the diff was printed, so the change ` +
          'you approved is not the change this would make.',
        evidence: [
          `${plan.target} › ${plan.axis.writtenKey}: reviewed ${show(change.wasInFile)}, found ${show(held)}`,
        ],
      };
    }
    const landed = plan.axis.entryIn(after, plan.project, change.id);
    if (!Object.is(landed, change.willBeInFile)) {
      return {
        outcome: 'refused',
        code: 'preview-diverged',
        message: 'The edit does not put the entry where the diff said it would, so nothing was written.',
        evidence: [
          `${change.id}: reviewed ${show(change.willBeInFile)}, staged ${show(landed)}`,
        ],
      };
    }
  }
  return null;
}

const show = (value: EntryValue | null): string => (value === null ? 'no entry' : String(value));

/**
 * The pre-image, under a name that says when and what.
 *
 * The target path is slugged into the filename the way `memorySlug` slugs one for Claude
 * Code's own layout, so two projects' backups never collide and a directory listing is
 * readable without opening anything. A filename has a length limit and an absolute path
 * does not, so a long one keeps its tail -- the project and the filename, which is the
 * half worth reading -- cut back to a segment boundary rather than mid-word.
 *
 * **The bytes are the stage's, not the plan's (QM-46).** `stage.original` is what the write
 * is actually replacing; `plan.before` is what someone read a diff of, and on the contended
 * axis those differ by whatever telemetry landed in between. A backup of the reviewed text
 * would be a pre-image of a state that never existed on disk.
 *
 * **0600, explicitly.** `~/.claude.json` is 0600 here and holds a `userID`, a `machineID`
 * and every project path on the machine; a copy of it made under the default umask would
 * publish it at 0644. The settings axes get the same mode for the reason `applyStage`
 * restores a mode unconditionally -- a rule that applies to one path is a rule someone
 * forgets at the second call site.
 *
 * An entry-scoped undo never reads this blob. It is kept anyway: it is the only record of
 * what the file held, and the refusals below name it so there is somewhere to look.
 */
function writeBackup(plan: TogglePlan, stage: Stage, opts: ApplyOptions): string {
  const dir = backupsDir(opts.state);
  mkdirSync(dir, { recursive: true });
  const stamp = opts.now.toISOString().replaceAll(':', '-').replace('.', '-');
  const slug = plan.target.replaceAll('/', '-');
  const cut = slug.slice(-150);
  const path = join(dir, `${stamp}${cut === slug ? cut : cut.slice(Math.max(0, cut.indexOf('-')))}`);
  writeFileSync(path, stage.original, { mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export type UndoResult =
  | { outcome: 'restored'; record: UndoRecord; bytes: number }
  | { outcome: 'nothing'; message: string }
  | { outcome: 'refused'; code: UndoRefusalCode; message: string; evidence: string[] };

export type UndoRefusalCode =
  | 'already-undone'
  /** The target is gone since the apply. */
  | 'target-vanished'
  /** The target no longer holds what this tool wrote, so undo would discard that. */
  | 'target-changed'
  /** The backup is missing, or is not the pre-image the record names. */
  | 'backup-unusable'
  /** The record names an axis this build does not have, so it cannot be read back. */
  | 'unknown-axis'
  | 'write-refused';

export function readUndoRecord(state: string): UndoRecord | null {
  const path = undoRecordPath(state);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UndoRecord;
  } catch {
    return null;
  }
}

/**
 * Put the last apply back.
 *
 * One apply deep, deliberately: a stack of undos is a second state machine with its own
 * staleness rules, and nothing here needs one. The record is marked rather than deleted,
 * so `qm undo` twice says *when* it was undone instead of saying there was nothing to do.
 */
export function undoLast(opts: ApplyOptions): UndoResult {
  const record = readUndoRecord(opts.state);
  if (!record) return { outcome: 'nothing', message: 'No apply has been recorded, so there is nothing to undo.' };
  if (record.undoneAt) {
    return {
      outcome: 'refused',
      code: 'already-undone',
      message: 'The last apply has already been undone. Undo goes one step, not a history.',
      evidence: [`applied ${record.appliedAt}, undone ${record.undoneAt}`],
    };
  }

  const axis = AXES.get(record.axis);
  if (!axis) {
    return {
      outcome: 'refused',
      code: 'unknown-axis',
      message: `The last apply was made on an axis this build does not have, so what it put where cannot be read back.`,
      evidence: [`record names ${JSON.stringify(record.axis)}, this build has ${[...AXES.keys()].join(', ')}`],
    };
  }

  if (!existsSync(record.target)) {
    return {
      outcome: 'refused',
      code: 'target-vanished',
      message: `${record.target} is gone, so there is nothing to restore into.`,
      evidence: [record.target],
    };
  }

  if (axis.undo === 'entries') return undoEntries(record, axis, opts);

  const current = readFileSync(record.target, 'utf8');
  if (sha256(current) !== record.sha256After) {
    return {
      outcome: 'refused',
      code: 'target-changed',
      message:
        'The file has changed since qm wrote it, so restoring the backup would discard an edit ' +
        'this tool did not make.',
      evidence: [
        `expected ${record.sha256After.slice(0, 12)}, found ${sha256(current).slice(0, 12)}`,
        `backup kept at ${record.backup}`,
      ],
    };
  }

  if (!existsSync(record.backup)) {
    return {
      outcome: 'refused',
      code: 'backup-unusable',
      message: 'The backup this record names is gone, so there is nothing to restore from.',
      evidence: [record.backup],
    };
  }
  const before = readFileSync(record.backup, 'utf8');
  if (sha256(before) !== record.sha256Before) {
    return {
      outcome: 'refused',
      code: 'backup-unusable',
      message: 'The backup is not the pre-image this record was written for.',
      evidence: [
        `${record.backup} hashes ${sha256(before).slice(0, 12)}, record says ${record.sha256Before.slice(0, 12)}`,
      ],
    };
  }

  // An undo is an apply. No edits: the read, the hash and the mtime come from the same
  // function every other write here goes through, and only the text is swapped -- so a
  // file written between this read and the rename is refused exactly as it would be on
  // the way in.
  const staged = stageEdits(record.target, []);
  if (staged.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${record.target} could not be staged for the restore.`,
      evidence: [`${staged.refusal.reason}: ${staged.refusal.detail}`],
    };
  }
  const written = applyStage({ ...staged.stage, text: before });
  if (written.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${record.target} moved during the restore, so nothing was written.`,
      evidence: [`${written.refusal.reason}: ${written.refusal.detail}`],
    };
  }

  return finish(record, opts, written.bytes);
}

function finish(record: UndoRecord, opts: ApplyOptions, bytes: number): UndoResult {
  const done: UndoRecord = { ...record, undoneAt: opts.now.toISOString() };
  writeFileSync(undoRecordPath(opts.state), `${JSON.stringify(done, null, 2)}\n`);
  return { outcome: 'restored', record: done, bytes };
}

/**
 * Put back the entries, and nothing else in the file (QM-46).
 *
 * The whole-file restore above cannot be used on `~/.claude.json` and the reason is not
 * squeamishness: the pre-image is 220KB of a document every live session writes telemetry
 * into, so restoring it discards every `lastCost` and `lastSessionId` written since -- and
 * its own guard, "the file still hashes to what this tool left there", stops matching
 * within ~11.5 seconds of the apply, so the operation that would clobber telemetry is also
 * the operation that would refuse to run.
 *
 * What survives is the *intent* of that guard, at the granularity that can survive it: each
 * changed entry must still hold what this tool wrote. An entry someone has since changed by
 * hand refuses exactly as a whole file someone edited does, and for the same stated reason
 * -- restoring over it would be this tool silently reverting an edit it did not make. What
 * it cannot see, and what the whole-file check could, is a change to some *other* key of
 * the same file. On this file that is the point.
 */
function undoEntries(record: UndoRecord, axis: Axis, opts: ApplyOptions): UndoResult {
  const current = readFileSync(record.target, 'utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(current);
  } catch (err) {
    return {
      outcome: 'refused',
      code: 'target-changed',
      message: `${record.target} does not parse, so nothing was restored.`,
      evidence: [err instanceof Error ? err.message : String(err), `backup kept at ${record.backup}`],
    };
  }

  const wanted = new Map<string, EntryValue | null>();
  for (const change of record.changes) {
    const held = axis.entryIn(doc, record.project, change.id);
    if (!Object.is(held, change.willBeInFile ?? null)) {
      return {
        outcome: 'refused',
        code: 'target-changed',
        message:
          `${change.id} has changed since qm wrote it, so restoring would discard an edit ` +
          'this tool did not make.',
        evidence: [
          `${record.target} › ${axis.writtenKey}: expected ${show(change.willBeInFile ?? null)}, found ${show(held)}`,
          `backup kept at ${record.backup}`,
        ],
      };
    }
    wanted.set(change.id, change.wasInFile ?? null);
  }

  const edits = axis.editsFor(doc, record.project, wanted);
  if (edits === null) {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `The ${axis.name} axis cannot express the state this record asks it to restore.`,
      evidence: [record.target],
    };
  }

  const staged = stageEdits(record.target, edits);
  if (staged.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${record.target} could not be staged for the restore.`,
      evidence: [`${staged.refusal.reason}: ${staged.refusal.detail}`],
    };
  }
  opts.onStaged?.(staged.stage);
  const written = applyStage(staged.stage);
  if (written.outcome === 'refused') {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `${record.target} moved during the restore, so nothing was written.`,
      evidence: [`${written.refusal.reason}: ${written.refusal.detail}`],
    };
  }
  return finish(record, opts, written.bytes);
}
