/**
 * The write gate: the bytes that land, the file that must not be touched, and undo.
 *
 * `write.test.ts` proves `applyStage` refuses a file that moved. This proves DEA-112
 * *uses* it -- which is a different claim, and the one a mutant can break without
 * touching `write.ts` at all. So every gate here runs twice: once against the real
 * `applyPlan` / `undoLast`, and once against a mutant that does the obvious wrong thing.
 * A mutant that passes is a hole in the gate rather than a mutant to delete.
 *
 * ## What it never touches
 *
 * No real config, and no real state directory. `ApplyOptions.state` is injected precisely
 * so that nothing here can reach `~/.local/state/claude-quartermaster`, and every target
 * is a file under `mkdtempSync`. The two forbidden basenames are asserted by *naming*
 * them, not by pointing at the user's copies.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FORBIDDEN_BASENAMES,
  applyPlan,
  backupsDir,
  readUndoRecord,
  stateDir,
  undoLast,
  undoRecordPath,
  type ApplyOptions,
  type ApplyResult,
  type UndoResult,
} from '../src/apply.ts';
import { EMPTY_SETTINGS, TARGET_FILENAME, type TogglePlan } from '../src/toggle.ts';
import { stageEdits, type Edit } from '../src/surfaces/write.ts';

let root = '';
before(() => {
  root = mkdtempSync(join(tmpdir(), 'qm-apply-'));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Plans, without a workspace
// ---------------------------------------------------------------------------

const BEFORE = '{\n  "enabledPlugins": {\n    "other@m": true\n  },\n  "unmodelled": [1, 2]\n}\n';
const AFTER =
  '{\n  "enabledPlugins": {\n    "other@m": true,\n    "p@m": true\n  },\n  "unmodelled": [1, 2]\n}\n';
const EDITS: Edit[] = [{ path: ['enabledPlugins', 'p@m'], value: true }];

let seq = 0;
/** A fresh project directory and state directory, so no two cases share either. */
function scratch(label: string): { project: string; target: string; state: string } {
  const project = join(root, `${label}-${seq++}`);
  mkdirSync(join(project, '.claude'), { recursive: true });
  return {
    project,
    target: join(project, '.claude', TARGET_FILENAME),
    state: join(project, '__state__'),
  };
}

/** A plan over a file that already exists, staged the way `planToggles` stages one. */
function planOver(target: string, project: string, text = BEFORE): TogglePlan {
  writeFileSync(target, text);
  const staged = stageEdits(target, EDITS);
  if (staged.outcome === 'refused') throw new Error(`staging refused: ${staged.refusal.detail}`);
  return {
    project,
    target,
    creates: false,
    before: text,
    after: staged.stage.text,
    edits: EDITS,
    stage: staged.stage,
    changes: [{ pluginId: 'p@m', from: false, to: true, effect: effectStub() }],
    notes: [],
  };
}

/** A plan over a file that does not exist yet. */
function planNew(target: string, project: string): TogglePlan {
  const edits: Edit[] = [{ path: ['enabledPlugins'], value: { 'p@m': true } }];
  return {
    project,
    target,
    creates: true,
    before: EMPTY_SETTINGS,
    after: '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n',
    edits,
    stage: null,
    changes: [{ pluginId: 'p@m', from: false, to: true, effect: effectStub() }],
    notes: [],
  };
}

const effectStub = () => ({
  change: { kind: 'plugin' as const, id: 'p@m' },
  effect: 'reload' as const,
  reason: 'stub',
  sessions: 0,
  evidence: [],
});

const opts = (state: string): ApplyOptions => ({ now: new Date(), state });

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

describe('applying a plan', () => {
  test('writes exactly the reviewed bytes, and keeps the pre-image', () => {
    const s = scratch('happy');
    const plan = planOver(s.target, s.project);
    const result = applyPlan(plan, opts(s.state));

    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(readFileSync(s.target, 'utf8'), AFTER);
    assert.equal(readFileSync(result.backup, 'utf8'), BEFORE);
    assert.equal(result.record.target, s.target);
    assert.equal(result.record.createdTarget, false);
    assert.deepEqual(result.record.changes, [{ pluginId: 'p@m', from: false, to: true }]);
    // Nothing outside the edited value moved -- the array written inline stays inline.
    assert.ok(readFileSync(s.target, 'utf8').includes('"unmodelled": [1, 2]'));
    assert.equal(readdirSync(join(s.project, '.claude')).filter((f) => f.includes('.qm-')).length, 0);
  });

  test('creates a target that is not there, exclusively, and lands the reviewed bytes', () => {
    const s = scratch('create');
    const plan = planNew(s.target, s.project);
    assert.equal(existsSync(s.target), false);

    const result = applyPlan(plan, opts(s.state));
    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(readFileSync(s.target, 'utf8'), plan.after);
    // The pre-image of a created file is what it was created as, so undo restores an
    // empty settings file rather than deleting one.
    assert.equal(readFileSync(result.backup, 'utf8'), EMPTY_SETTINGS);
    assert.equal(result.record.createdTarget, true);
  });

  test('a target that appeared since planning is refused, and left alone', () => {
    const s = scratch('appeared');
    const plan = planNew(s.target, s.project);
    writeFileSync(s.target, '{"someone": "else"}');

    const result = applyPlan(plan, opts(s.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'target-appeared');
    assert.equal(readFileSync(s.target, 'utf8'), '{"someone": "else"}');
  });

  test('and the record lands only after the write, beside the baseline', () => {
    const s = scratch('record');
    const plan = planOver(s.target, s.project);
    assert.equal(readUndoRecord(s.state), null);

    applyPlan(plan, opts(s.state));
    assert.equal(readUndoRecord(s.state)?.target, s.target);
    assert.equal(undoRecordPath(s.state), join(s.state, 'last-apply.json'));
    assert.equal(backupsDir(s.state), join(s.state, 'backups'));
  });

  /**
   * The state directory, as the rest of the tool already resolves it.
   *
   * `XDG_STATE_HOME` is honoured because `baseline.json` and `oracle-run.json` are already
   * there and a backup that ignored it would be the one file of this tool's state living
   * somewhere else.
   */
  test('the state directory follows XDG_STATE_HOME, as the baseline does', () => {
    const saved = process.env['XDG_STATE_HOME'];
    try {
      process.env['XDG_STATE_HOME'] = '/xdg';
      assert.equal(stateDir(), '/xdg/claude-quartermaster');
    } finally {
      if (saved === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// The gate: a file that moved, and a file that must not be written
// ---------------------------------------------------------------------------

type Applier = (plan: TogglePlan, o: ApplyOptions) => ApplyResult;

/**
 * The obvious wrong implementation: write the reviewed text, ask nothing.
 *
 * It is what `applyPlan` would be without `applyStage` and without the basename guard, so
 * one mutant measures both gates below. Written from scratch rather than as a patch over
 * the real function, for `effect.test.ts`'s reason -- a mutant built on the real one
 * inherits every branch it does not touch.
 */
const naive: Applier = (plan) => {
  writeFileSync(plan.target, plan.after);
  return {
    outcome: 'written',
    bytes: Buffer.byteLength(plan.after),
    backup: '',
    record: {
      appliedAt: '',
      project: plan.project,
      target: plan.target,
      backup: '',
      createdTarget: plan.creates,
      sha256Before: '',
      sha256After: '',
      changes: [],
    },
  };
};

/**
 * Everything an apply must refuse, with what the target must still say afterwards.
 *
 * Both halves of the concurrency check are here as separate rows. Either alone is
 * defeatable: a coarse filesystem timestamp hides a fast write, so the hash is what
 * catches it, and the hash alone cannot distinguish a quiet file from one being written.
 */
function driftGate(apply: Applier): string[] {
  const failures: string[] = [];
  const check = (label: string, target: string, expected: string, result: ApplyResult) => {
    if (result.outcome !== 'refused') failures.push(`${label}: applied instead of refusing`);
    const now = readFileSync(target, 'utf8');
    if (now !== expected) failures.push(`${label}: the target was overwritten`);
  };

  {
    const s = scratch('drift-mtime');
    const plan = planOver(s.target, s.project);
    const meanwhile = BEFORE.replace('"other@m": true', '"other@m": false');
    writeFileSync(s.target, meanwhile);
    check('a file written since staging', s.target, meanwhile, apply(plan, opts(s.state)));
  }

  {
    const s = scratch('drift-hash');
    const plan = planOver(s.target, s.project);
    const meanwhile = BEFORE.replace('"other@m": true', '"other@m": false');
    writeFileSync(s.target, meanwhile);
    // The mtime half satisfied on purpose, so only the content can notice.
    const asIfUnmoved: TogglePlan = {
      ...plan,
      stage: { ...plan.stage!, mtimeMs: statSync(s.target).mtimeMs },
    };
    check('a file whose content moved under an unchanged mtime', s.target, meanwhile, apply(asIfUnmoved, opts(s.state)));
  }

  {
    const s = scratch('drift-gone');
    const plan = planOver(s.target, s.project);
    unlinkSync(s.target);
    const result = apply(plan, opts(s.state));
    if (result.outcome !== 'refused') failures.push('a file deleted since staging: applied instead of refusing');
  }

  return failures;
}

/** The two files this phase promised never to write, by name. */
function forbiddenGate(apply: Applier): string[] {
  const failures: string[] = [];
  for (const name of ['settings.json', '.claude.json']) {
    const s = scratch(`forbidden-${name.replace('.', '')}`);
    const target = join(s.project, '.claude', name);
    writeFileSync(target, BEFORE);
    const plan: TogglePlan = { ...planOver(s.target, s.project), target };

    const result = apply(plan, opts(s.state));
    if (result.outcome !== 'refused') failures.push(`${name}: applied instead of refusing`);
    if (readFileSync(target, 'utf8') !== BEFORE) failures.push(`${name}: was written`);
  }
  return failures;
}

const report = (f: readonly string[]) => `\n  ${f.length} failure(s):\n  ${f.join('\n  ')}`;

describe('the write gate', () => {
  test('a file that moved since staging is refused, both halves', () => {
    const failures = driftGate(applyPlan);
    assert.deepEqual(failures, [], report(failures));
  });

  test('and settings.json and ~/.claude.json are refused by name', () => {
    assert.deepEqual([...FORBIDDEN_BASENAMES].sort(), ['.claude.json', 'settings.json']);
    const failures = forbiddenGate(applyPlan);
    assert.deepEqual(failures, [], report(failures));
  });

  test('the bytes staged must be the bytes reviewed', () => {
    const s = scratch('diverged');
    const plan = planOver(s.target, s.project);
    const result = applyPlan({ ...plan, after: `${plan.after}\n/* not what was staged */` }, opts(s.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'preview-diverged');
    assert.equal(readFileSync(s.target, 'utf8'), BEFORE);
  });

  test('an applier that skips both gates is caught by both', () => {
    const drift = driftGate(naive);
    assert.ok(drift.length > 0, 'the drift gate passed a writer that checks nothing — that is a hole');
    assert.ok(
      drift.some((f) => /a file written since staging/.test(f)) &&
        drift.some((f) => /unchanged mtime/.test(f)),
      `the drift gate failed, but not on both halves: ${report(drift)}`,
    );

    const forbidden = forbiddenGate(naive);
    assert.ok(forbidden.length > 0, 'the forbidden gate passed a writer that checks nothing');
    assert.ok(
      forbidden.some((f) => f.startsWith('settings.json:')) &&
        forbidden.some((f) => f.startsWith('.claude.json:')),
      `the forbidden gate failed, but not on both names: ${report(forbidden)}`,
    );
    console.log(`    caught the naive writer: ${drift.length} drift, ${forbidden.length} forbidden`);
  });
});

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

type Undoer = (o: ApplyOptions) => UndoResult;

/**
 * The obvious wrong undo: put the backup back, ask nothing.
 *
 * The check it drops is the one no `applyStage` can make -- a deliberate edit made after
 * the apply is minutes old and perfectly quiescent, so only the recorded hash notices it.
 */
const clobber: Undoer = (o) => {
  const record = readUndoRecord(o.state);
  if (!record) return { outcome: 'nothing', message: 'none' };
  writeFileSync(record.target, readFileSync(record.backup, 'utf8'));
  return { outcome: 'restored', record, bytes: 0 };
};

/** Apply, then hand the state directory back for undoing. */
function applied(label: string): { target: string; state: string } {
  const s = scratch(label);
  const plan = planOver(s.target, s.project);
  const result = applyPlan(plan, opts(s.state));
  assert.equal(result.outcome, 'written');
  return { target: s.target, state: s.state };
}

function undoGate(undo: Undoer): string[] {
  const failures: string[] = [];

  {
    // The target edited by someone else after the apply. Restoring would silently revert
    // an edit this tool did not make.
    const a = applied('undo-changed');
    const theirs = `${AFTER.trimEnd()}\n`.replace('"p@m": true', '"p@m": false');
    writeFileSync(a.target, theirs);
    const result = undo(opts(a.state));
    if (result.outcome !== 'refused') failures.push('a target edited since the apply: restored anyway');
    if (readFileSync(a.target, 'utf8') !== theirs) failures.push('a target edited since the apply: was overwritten');
  }

  {
    // The backup itself edited. The record's `sha256Before` is what says these are not
    // the bytes the apply replaced.
    const a = applied('undo-backup');
    const record = readUndoRecord(a.state)!;
    writeFileSync(record.backup, '{"not": "the pre-image"}');
    const result = undo(opts(a.state));
    if (result.outcome !== 'refused') failures.push('a tampered backup: restored anyway');
    if (readFileSync(a.target, 'utf8') !== AFTER) failures.push('a tampered backup: was written to the target');
  }

  return failures;
}

describe('undo', () => {
  test('restores the pre-image byte for byte, and only once', () => {
    const a = applied('undo-happy');
    assert.equal(readFileSync(a.target, 'utf8'), AFTER);

    const first = undoLast(opts(a.state));
    assert.equal(first.outcome, 'restored');
    assert.equal(readFileSync(a.target, 'utf8'), BEFORE);

    const second = undoLast(opts(a.state));
    assert.equal(second.outcome, 'refused');
    if (second.outcome !== 'refused') return;
    assert.equal(second.code, 'already-undone');
    assert.equal(readFileSync(a.target, 'utf8'), BEFORE, 'the second undo wrote');
  });

  test('a created target goes back to empty settings rather than being deleted', () => {
    const s = scratch('undo-created');
    const plan = planNew(s.target, s.project);
    assert.equal(applyPlan(plan, opts(s.state)).outcome, 'written');

    assert.equal(undoLast(opts(s.state)).outcome, 'restored');
    assert.equal(existsSync(s.target), true, 'undo deleted a file');
    assert.equal(readFileSync(s.target, 'utf8'), EMPTY_SETTINGS);
  });

  test('nothing recorded is nothing to undo, and is not an error', () => {
    const s = scratch('undo-empty');
    const result = undoLast(opts(s.state));
    assert.equal(result.outcome, 'nothing');
  });

  test('a target that vanished is refused', () => {
    const a = applied('undo-vanished');
    unlinkSync(a.target);
    const result = undoLast(opts(a.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'target-vanished');
  });

  test('a missing backup is refused rather than treated as an empty one', () => {
    const a = applied('undo-nobackup');
    const record = readUndoRecord(a.state)!;
    unlinkSync(record.backup);
    const result = undoLast(opts(a.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'backup-unusable');
    assert.equal(readFileSync(a.target, 'utf8'), AFTER);
  });

  test('the guards hold, and an undo without them is caught', () => {
    const real = undoGate(undoLast);
    assert.deepEqual(real, [], report(real));

    const mutant = undoGate(clobber);
    assert.ok(mutant.length > 0, 'the undo gate passed a restore that checks nothing — that is a hole');
    assert.ok(
      mutant.some((f) => /a target edited since the apply/.test(f)) &&
        mutant.some((f) => /a tampered backup/.test(f)),
      `the undo gate failed, but not on both guards: ${report(mutant)}`,
    );
    console.log(`    caught the clobbering undo: ${mutant.join(' | ')}`);
  });

  /**
   * The other half of "the restore is an apply": `applyStage`, not just `stageEdits`.
   *
   * A hand mutation that swapped `applyStage` for a bare write while leaving `stageEdits`
   * in place left the whole suite green -- the UTF-8 gate below still fired, because that
   * refusal comes from the staging half. What separates the two is that `applyStage`
   * writes a *new* file and renames it over the target, so a read-only target is restored
   * and keeps its mode, while a bare write to the same path is refused by the kernel.
   * That is a real property of the design and not a contrivance: a settings file the user
   * has locked down is a file this tool should still be able to put back.
   */
  test('the restore renames over the target, so a read-only one is still restored', () => {
    const a = applied('undo-readonly');
    chmodSync(a.target, 0o444);

    const result = undoLast(opts(a.state));
    assert.equal(result.outcome, 'restored');
    assert.equal(readFileSync(a.target, 'utf8'), BEFORE);
    assert.equal(statSync(a.target).mode & 0o777, 0o444, 'the restore widened the mode');

    // What a bare write does at that path, which is what makes this a gate rather than
    // a description.
    assert.throws(() => writeFileSync(a.target, BEFORE), /EACCES/);
  });

  /**
   * That the restore is an apply, and not a `writeFileSync`.
   *
   * The recorded-hash guard above is undo's own, and it catches an edit made before undo
   * starts. What `stageEdits`/`applyStage` add is the window between the read and the
   * rename -- which cannot be forced from outside, since both happen inside `undoLast`.
   * What *can* be forced is a refusal only `stageEdits` makes: a target whose bytes do
   * not round-trip through UTF-8. The record's expectation is moved to match those bytes
   * first, so undo's own guard passes and the refusal can only have come from the shared
   * writer. `clobber` restores here, which is the divergence.
   */
  test('and the restore goes through stageEdits, not a bare write', () => {
    const a = applied('undo-utf8');
    // A lone continuation byte: valid as a file, not as UTF-8.
    writeFileSync(a.target, Buffer.from([0x7b, 0x80, 0x7d]));

    const state = readUndoRecord(a.state)!;
    const asRead = readFileSync(a.target, 'utf8');
    writeFileSync(
      undoRecordPath(a.state),
      JSON.stringify(
        { ...state, sha256After: createHash('sha256').update(Buffer.from(asRead, 'utf8')).digest('hex') },
        null,
        2,
      ),
    );

    const result = undoLast(opts(a.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'write-refused');
    assert.match(result.evidence[0]!, /not-utf8/);
    assert.deepEqual([...readFileSync(a.target)], [0x7b, 0x80, 0x7d], 'the target was written anyway');

    // And the mutant does not refuse, which is what makes this a gate.
    const again = clobber(opts(a.state));
    assert.equal(again.outcome, 'restored');
  });
});
