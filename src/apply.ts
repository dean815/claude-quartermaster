/**
 * Applying a planned write, keeping the pre-image, and putting it back.
 *
 * Everything hazardous is already solved and tested in `surfaces/write.ts` (DEA-139):
 * `applyStage` refuses on mtime **or** sha256 drift, writes a same-directory temp with
 * the original mode, `fsync`s it, and renames. This file consumes that and adds the three
 * things it does not have -- creating a target that is not there yet, a timestamped
 * backup, and one undo.
 *
 * ## Undo is an apply
 *
 * Restoring a pre-image is a write to a file that has been sitting on disk since, so it
 * gets the same guard by going through the same function: `stageEdits(target, [])` reads
 * the file and captures its hash and mtime, the backup's bytes are put on that stage, and
 * `applyStage` decides. What that guard cannot see is the *interesting* case -- an edit
 * made deliberately after the apply, by a person or by Claude Code -- because that edit is
 * minutes old and perfectly quiescent. So undo checks a second thing first: the file must
 * still hash to what this tool left there. Restoring over someone else's change would be
 * this tool silently reverting an edit it did not make.
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
import { EMPTY_SETTINGS, TARGET_FILENAME, type TogglePlan } from './toggle.ts';

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
  project: string;
  target: string;
  backup: string;
  /** The target did not exist before this apply; undo returns it to `{}`. */
  createdTarget: boolean;
  sha256Before: string;
  sha256After: string;
  changes: Array<{ pluginId: string; from: boolean; to: boolean }>;
  /** Set once undo has run. One undo, and a second is refused rather than repeated. */
  undoneAt?: string;
}

export type ApplyResult =
  | { outcome: 'written'; bytes: number; backup: string; record: UndoRecord }
  | { outcome: 'refused'; code: ApplyRefusalCode; message: string; evidence: string[] };

export type ApplyRefusalCode =
  /** The plan names a file this phase promised never to write. */
  | 'forbidden-target'
  /** The target appeared between planning and applying. */
  | 'target-appeared'
  /** The bytes staged are not the bytes reviewed. */
  | 'preview-diverged'
  /** `write.ts` refused -- the file moved, vanished, or the edit does not fit. */
  | 'write-refused';

/**
 * The files this phase promised never to write, named rather than merely not built.
 *
 * `settings.json` is the repo's own tracked configuration, and promoting a local decision
 * into it is a separate, explicit action nobody has asked for yet. `~/.claude.json` is the
 * 200KB file every live session writes telemetry into, and v1 stays away from it entirely.
 *
 * A basename set, so this catches a path arriving from anywhere -- a caller building its
 * own plan, a future grid endpoint, a test tampering with one. The positive check that
 * the basename *is* `settings.local.json` would be enough on its own; both are here so
 * that breaking either one is visible as breaking a named promise.
 */
export const FORBIDDEN_BASENAMES: ReadonlySet<string> = new Set(['settings.json', '.claude.json']);

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

export interface ApplyOptions {
  now: Date;
  /** Injected, so nothing under test writes into the user's real state directory. */
  state: string;
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
  const name = basename(plan.target);
  if (FORBIDDEN_BASENAMES.has(name) || name !== TARGET_FILENAME) {
    return {
      outcome: 'refused',
      code: 'forbidden-target',
      message: `Writes go to ${TARGET_FILENAME} and nowhere else.`,
      evidence: [plan.target],
    };
  }

  if (plan.creates) {
    mkdirSync(dirname(plan.target), { recursive: true });
    try {
      // Exclusive: if anything created this file between planning and now, the plan was
      // made against a file that does not exist and the one that does is not ours to
      // edit sight unseen.
      writeFileSync(plan.target, EMPTY_SETTINGS, { flag: 'wx' });
    } catch (err) {
      return {
        outcome: 'refused',
        code: 'target-appeared',
        message: `${plan.target} appeared between planning and applying, so the reviewed diff is against a file that no longer describes it.`,
        evidence: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  let stage: Stage;
  if (plan.creates) {
    const staged = stageEdits(plan.target, plan.edits);
    if (staged.outcome === 'refused') {
      return {
        outcome: 'refused',
        code: 'write-refused',
        message: `${plan.target} could not be staged after it was created.`,
        evidence: [`${staged.refusal.reason}: ${staged.refusal.detail}`],
      };
    }
    stage = staged.stage;
  } else if (plan.stage) {
    stage = plan.stage;
  } else {
    return {
      outcome: 'refused',
      code: 'write-refused',
      message: `A plan for an existing ${TARGET_FILENAME} must carry the stage it was reviewed from.`,
      evidence: [plan.target],
    };
  }

  // The postcondition that makes the reviewed diff binding on both paths. It can only
  // fire for a created target -- an existing one was staged at plan time and its text is
  // `plan.after` by construction -- and it is checked on both because a postcondition
  // that runs only where it cannot fail is the DEA-133 defect.
  if (stage.text !== plan.after) {
    return {
      outcome: 'refused',
      code: 'preview-diverged',
      message: 'The bytes staged are not the bytes reviewed, so nothing was written.',
      evidence: [`reviewed ${plan.after.length} bytes, staged ${stage.text.length} bytes`],
    };
  }

  const backup = writeBackup(plan, opts);
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
    project: plan.project,
    target: plan.target,
    backup,
    createdTarget: plan.creates,
    sha256Before: sha256(plan.before),
    sha256After: sha256(plan.after),
    changes: plan.changes.map((c) => ({ pluginId: c.pluginId, from: c.from, to: c.to })),
  };
  mkdirSync(opts.state, { recursive: true });
  writeFileSync(undoRecordPath(opts.state), `${JSON.stringify(record, null, 2)}\n`);

  return { outcome: 'written', bytes: written.bytes, backup, record };
}

/**
 * The pre-image, under a name that says when and what.
 *
 * The target path is slugged into the filename the way `memorySlug` slugs one for Claude
 * Code's own layout, so two projects' backups never collide and a directory listing is
 * readable without opening anything. Kept to a tail of 150 characters: a filename has a
 * length limit and an absolute path does not.
 */
function writeBackup(plan: TogglePlan, opts: ApplyOptions): string {
  const dir = backupsDir(opts.state);
  mkdirSync(dir, { recursive: true });
  const stamp = opts.now.toISOString().replaceAll(':', '-').replace('.', '-');
  const slug = plan.target.replaceAll('/', '-');
  const path = join(dir, `${stamp}${slug.slice(-150)}`);
  writeFileSync(path, plan.before);
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

  if (!existsSync(record.target)) {
    return {
      outcome: 'refused',
      code: 'target-vanished',
      message: `${record.target} is gone, so there is nothing to restore into.`,
      evidence: [record.target],
    };
  }

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

  const done: UndoRecord = { ...record, undoneAt: opts.now.toISOString() };
  writeFileSync(undoRecordPath(opts.state), `${JSON.stringify(done, null, 2)}\n`);
  return { outcome: 'restored', record: done, bytes: written.bytes };
}
