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
  utimesSync,
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
import {
  AXES,
  MCP_AXIS,
  PLUGIN_AXIS,
  PROMOTED_TARGET_FILENAME,
  SKILL_AXIS,
  TARGET_FILENAME,
  emptySettings,
  promote,
  type TogglePlan,
} from '../src/toggle.ts';
import { applyEdits, applyStage, stageEdits, type Edit } from '../src/surfaces/write.ts';

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

/** The one change every plugin plan here makes, in the shape `planToggles` records it. */
const CHANGE = (): TogglePlan['changes'][number] => ({
  id: 'p@m',
  from: false,
  to: true,
  wasInFile: null,
  willBeInFile: true,
  effect: effectStub(),
});

/** A plan over a file that already exists, in the shape `planToggles` builds one. */
function planOver(target: string, project: string, text = BEFORE): TogglePlan {
  writeFileSync(target, text);
  const previewed = applyEdits(text, EDITS);
  if (previewed.outcome === 'refused') throw new Error(`preview refused: ${previewed.refusal.detail}`);
  return {
    axis: PLUGIN_AXIS,
    project,
    target,
    creates: false,
    before: text,
    after: previewed.text,
    edits: EDITS,
    changes: [CHANGE()],
    notes: [],
  };
}

/** A plan over a file that does not exist yet. */
function planNew(target: string, project: string): TogglePlan {
  const edits: Edit[] = [{ path: ['enabledPlugins'], value: { 'p@m': true } }];
  return {
    axis: PLUGIN_AXIS,
    project,
    target,
    creates: true,
    before: emptySettings(PLUGIN_AXIS.writtenKey),
    after: '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n',
    edits,
    changes: [CHANGE()],
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
    assert.deepEqual(result.record.changes, [
      { id: 'p@m', from: false, to: true, wasInFile: null, willBeInFile: true },
    ]);
    assert.equal(result.rebased, false, 'a quiet file should not report a rebase');
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
    assert.equal(readFileSync(result.backup, 'utf8'), emptySettings(PLUGIN_AXIS.writtenKey));
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
    rebased: false,
    record: {
      appliedAt: '',
      axis: plan.axis.name,
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
 * **Two windows, and QM-46 split them.** The plan no longer carries a stage, so the window
 * `applyStage` exists for is the microseconds inside `applyPlan` between `stageEdits` and
 * the rename -- opened here through `ApplyOptions.onStaged`, which is the only way to reach
 * it from outside and is why that seam exists. Both halves of the concurrency check are
 * separate rows through it: either alone is defeatable, a coarse filesystem timestamp hides
 * a fast write so the hash is what catches it, and the hash alone cannot distinguish a quiet
 * file from one being written.
 *
 * The *human's* window is the third row, and it is guarded semantically rather than by
 * bytes. A file whose unrelated keys moved while someone read the diff is re-based onto and
 * reported; a file whose **entry** moved is refused, because the change someone approved is
 * not the change that would be made. Refusing the first is the design this issue replaced;
 * failing to refuse the second is the hole that replacement could have left.
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
    // Written from inside the window: after the stage was taken, before the rename.
    const meanwhile = BEFORE.replace('"other@m": true', '"other@m": false');
    const o: ApplyOptions = {
      ...opts(s.state),
      onStaged: () => writeFileSync(s.target, meanwhile),
    };
    check('a file written since staging', s.target, meanwhile, apply(plan, o));
  }

  {
    const s = scratch('drift-hash');
    const plan = planOver(s.target, s.project);
    const meanwhile = BEFORE.replace('"other@m": true', '"other@m": false');
    // The mtime half satisfied on purpose, so only the content can notice.
    const o: ApplyOptions = {
      ...opts(s.state),
      onStaged: (stage) => {
        writeFileSync(s.target, meanwhile);
        utimesSync(s.target, new Date(stage.mtimeMs), new Date(stage.mtimeMs));
      },
    };
    check('a file whose content moved under an unchanged mtime', s.target, meanwhile, apply(plan, o));
  }

  {
    const s = scratch('drift-entry');
    const plan = planOver(s.target, s.project);
    // The human's window: the entry this plan is about was decided by someone else while
    // the diff was on screen. Nothing here is inside `applyStage`'s window.
    const theirs = BEFORE.replace('"other@m": true', '"other@m": true,\n    "p@m": false');
    writeFileSync(s.target, theirs);
    check('an entry decided since the diff was printed', s.target, theirs, apply(plan, opts(s.state)));
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

/**
 * A path the plan's own axis does not own.
 *
 * `settings.json` by name, because no axis may ever write it. `.claude.json` because a
 * *plugin* plan naming it is a plan naming another axis's file -- which is the check
 * QM-46 replaced the flat basename set with, and the one a flat set could not make once
 * one axis was allowed that name.
 */
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

  test('and settings.json is refused by name, ~/.claude.json by ownership', () => {
    assert.deepEqual([...FORBIDDEN_BASENAMES].sort(), ['settings.json']);
    // The MCP axis owns that basename and the plugin axis does not, which is the whole
    // difference between the old flat set and the registry check that replaced it.
    assert.equal(MCP_AXIS.owns('/h/.claude.json', '/p'), true);
    assert.equal(PLUGIN_AXIS.owns('/h/.claude.json', '/p'), false);
    assert.equal(PLUGIN_AXIS.owns('/p/.claude/settings.local.json', '/p'), true);
    const failures = forbiddenGate(applyPlan);
    assert.deepEqual(failures, [], report(failures));
  });

  /**
   * What the reviewed diff is binding on, now that it is not binding on every byte.
   *
   * The entry. A plan whose edits do not put `willBeInFile` where it says they will is
   * refused -- so a batch that has drifted from the change it was reviewed as making
   * cannot land, however the bytes around it look.
   */
  test('the entry staged must be the entry reviewed', () => {
    const s = scratch('diverged');
    const plan = planOver(s.target, s.project);
    const result = applyPlan(
      { ...plan, changes: [{ ...plan.changes[0]!, willBeInFile: false }] },
      opts(s.state),
    );
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'preview-diverged');
    assert.equal(readFileSync(s.target, 'utf8'), BEFORE);
  });

  /**
   * The other half of that, and the one the byte comparison used to refuse.
   *
   * An unrelated key written while the diff was on screen. The entry is untouched, so the
   * batch is re-applied to the bytes as they now are, both writes survive, and the run
   * says the file moved. On `settings.local.json` this is a courtesy; on the file that
   * moves every 11.5s it is the only way the command ever applies anything.
   */
  test('an unrelated key written since the review is re-based onto, and reported', () => {
    const s = scratch('rebased');
    const plan = planOver(s.target, s.project);
    const theirs = BEFORE.replace('"unmodelled": [1, 2]', '"unmodelled": [1, 2, 3]');
    writeFileSync(s.target, theirs);

    const result = applyPlan(plan, opts(s.state));
    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(result.rebased, true, 'a file that moved was not reported as re-based');
    const now = readFileSync(s.target, 'utf8');
    assert.ok(now.includes('"p@m": true'), 'the reviewed change did not land');
    assert.ok(now.includes('"unmodelled": [1, 2, 3]'), 'the concurrent write was clobbered');
    // The pre-image is the bytes actually replaced, not the ones someone read.
    assert.equal(readFileSync(result.backup, 'utf8'), theirs);
  });

  test('an applier that skips both gates is caught by both', () => {
    const drift = driftGate(naive);
    assert.ok(drift.length > 0, 'the drift gate passed a writer that checks nothing — that is a hole');
    assert.ok(
      drift.some((f) => /a file written since staging/.test(f)) &&
        drift.some((f) => /unchanged mtime/.test(f)) &&
        drift.some((f) => /an entry decided since the diff/.test(f)),
      `the drift gate failed, but not on all three windows: ${report(drift)}`,
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
    assert.equal(readFileSync(s.target, 'utf8'), '{\n  "enabledPlugins": {}\n}\n');
  });

  /**
   * The same round trip on the axis with no entries anywhere (QM-45).
   *
   * 0 of 35 settings files on the machine this was measured against carry
   * `skillOverrides`, so *every* real skills write creates its target -- which makes this
   * the common path here rather than the exception, and makes the seed's key the thing
   * undo hands back. Seeded with `enabledPlugins` instead, this restores a file whose
   * only content is a key the write never touched.
   */
  test('and a created skills target goes back to an empty skillOverrides', () => {
    const s = scratch('undo-created-skill');
    const plan: TogglePlan = {
      axis: SKILL_AXIS,
      project: s.project,
      target: s.target,
      creates: true,
      before: emptySettings(SKILL_AXIS.writtenKey),
      after: '{\n  "skillOverrides": {\n    "s-01": "name-only"\n  }\n}\n',
      edits: [{ path: ['skillOverrides'], value: { 's-01': 'name-only' } }],
      changes: [
        {
          id: 's-01',
          from: 'on',
          to: 'name-only',
          wasInFile: null,
          willBeInFile: 'name-only',
          effect: { ...effectStub(), change: { kind: 'skill' as const, id: 's-01' } },
        },
      ],
      notes: [],
    };

    const result = applyPlan(plan, opts(s.state));
    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(readFileSync(s.target, 'utf8'), plan.after);
    // The four-valued change survives the record, which is JSON on disk.
    assert.deepEqual(result.record.changes, [
      { id: 's-01', from: 'on', to: 'name-only', wasInFile: null, willBeInFile: 'name-only' },
    ]);

    assert.equal(undoLast(opts(s.state)).outcome, 'restored');
    assert.equal(readFileSync(s.target, 'utf8'), '{\n  "skillOverrides": {}\n}\n');
  });

  /**
   * The seed is this file's decision, and a plan cannot make it otherwise.
   *
   * `plan.before` and `emptySettings(plan.axis.settingsKey)` are equal by construction on
   * every plan `planToggles` builds, so seeding from the plan instead reads identically
   * and leaves the suite green -- measured, as a hand mutation, before this test existed.
   * The state that separates them is a plan whose `before` is *not* the seed, which no
   * planner produces and which is precisely what a caller building its own plan could
   * hand `applyPlan`.
   *
   * The property is that the reviewed `after` still lands. Seeded from `before`, the
   * edits go on top of the wrong bytes, the postcondition sees text that is not
   * `plan.after`, and the write is refused -- which is the safe failure, but a refusal is
   * not what this is supposed to do with a plan whose diff was correct.
   */
  test('the seed comes from the axis, not from the plan that asked for the file', () => {
    const s = scratch('seed-authority');
    const plan: TogglePlan = {
      axis: PLUGIN_AXIS,
      project: s.project,
      target: s.target,
      creates: true,
      // A pre-image no planner would build. `after` is still what a correct seed plus the
      // edits produces, so the reviewed diff is the one this must land.
      before: '{\n  "somethingElse": 1\n}\n',
      after: '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n',
      edits: [{ path: ['enabledPlugins'], value: { 'p@m': true } }],
      changes: [CHANGE()],
      notes: [],
    };

    const result = applyPlan(plan, opts(s.state));
    assert.equal(
      result.outcome,
      'written',
      `applyPlan refused a plan whose reviewed bytes were correct: ${JSON.stringify(result)}`,
    );
    assert.equal(readFileSync(s.target, 'utf8'), plan.after);
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

// ---------------------------------------------------------------------------
// The contended file (QM-46)
// ---------------------------------------------------------------------------

/**
 * `~/.claude.json`, in the shape and at the scale that made this axis different.
 *
 * `lastCost` and `lastSessionId` stand in for the telemetry every live session writes:
 * measured on the machine this was built against, that file changed **6 times in 72
 * seconds** with ordinary sessions running, a mean interval of 11.5s. Everything below
 * turns on one question -- whether a guard spans the human's decision or the
 * read-modify-write -- and these two keys are how a test can tell.
 */
function claudeJsonText(project: string, deny: string[], session: string): string {
  return `${JSON.stringify(
    {
      numStartups: 142,
      userID: 'u-0',
      mcpServers: { linear: { type: 'http' } },
      projects: {
        '/some/other/project': { lastCost: 9.99, disabledMcpServers: ['claude.ai Canva'] },
        [project]: {
          ...(deny.length ? { disabledMcpServers: deny } : {}),
          hasTrustDialogAccepted: true,
          lastCost: 0.5,
          lastSessionId: session,
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** A scratch `~/.claude.json` and the project whose entry it carries. */
function claudeScratch(label: string, deny: string[] = []): {
  project: string;
  target: string;
  state: string;
  text: string;
} {
  const s = scratch(label);
  const target = join(s.project, '.claude.json');
  const text = claudeJsonText(s.project, deny, 'session-a');
  writeFileSync(target, text);
  return { project: s.project, target, state: s.state, text };
}

/** A plan on the MCP axis, in the shape `planToggles` builds one. */
function planMcp(
  target: string,
  project: string,
  id: string,
  value: boolean,
  text: string,
): TogglePlan {
  const doc = JSON.parse(text);
  const wanted = new Map([[id, MCP_AXIS.entryFor(value)]]);
  const edits = MCP_AXIS.editsFor(doc, project, wanted)!;
  const previewed = applyEdits(text, edits);
  if (previewed.outcome === 'refused') throw new Error(`preview refused: ${previewed.refusal.detail}`);
  return {
    axis: MCP_AXIS,
    project,
    target,
    creates: false,
    before: text,
    after: previewed.text,
    edits,
    changes: [
      {
        id,
        from: !value,
        to: value,
        wasInFile: MCP_AXIS.entryIn(doc, project, id),
        willBeInFile: MCP_AXIS.entryIn(JSON.parse(previewed.text), project, id),
        effect: { ...effectStub(), change: { kind: 'mcp-server' as const, name: id } },
      },
    ],
    notes: [],
  };
}

const costOf = (target: string, project: string): unknown =>
  JSON.parse(readFileSync(target, 'utf8')).projects[project].lastCost;

describe('the axis that writes ~/.claude.json', () => {
  test('adds one deny-list entry and moves no other byte', () => {
    const c = claudeScratch('mcp-add');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);

    const result = applyPlan(plan, opts(c.state));
    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(result.record.axis, 'mcp');
    assert.equal(result.rebased, false);

    const now = readFileSync(c.target, 'utf8');
    assert.deepEqual(JSON.parse(now).projects[c.project].disabledMcpServers, ['claude.ai Linear']);
    // Everything else, verbatim: the 83-keys-nobody-modelled problem, as a property.
    // The added member is cut out by its own text, and what is left must be the original
    // byte for byte -- so a writer that re-serialised the document fails here even where
    // the parsed values would agree.
    const added = ',\n      "disabledMcpServers": [\n        "claude.ai Linear"\n      ]';
    assert.ok(now.includes(added), `the member did not land with the file's own layout:\n${now}`);
    assert.equal(now.replace(added, ''), c.text);
  });

  /**
   * The whole design, in one test.
   *
   * A session writes telemetry into the file *after* the diff was printed and *before* the
   * answer -- which on this file is the ordinary case, not a race anyone engineered. The
   * change lands, the telemetry survives, and the run says the file moved. Under the
   * stage-then-confirm-then-apply shape this issue replaced, this refuses, and at a mean
   * write interval of 11.5s it refuses on nearly every attempt.
   */
  test('survives a concurrent write to the file, and says that it did', () => {
    const c = claudeScratch('mcp-concurrent');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);

    // Between the printed diff and the answer.
    const meanwhile = claudeJsonText(c.project, [], 'session-b').replace('0.5', '1.25');
    writeFileSync(c.target, meanwhile);

    const result = applyPlan(plan, opts(c.state));
    assert.equal(result.outcome, 'written', `refused a write nothing was wrong with: ${JSON.stringify(result)}`);
    if (result.outcome !== 'written') return;
    assert.equal(result.rebased, true, 'the run did not report that the file had moved');

    const now = JSON.parse(readFileSync(c.target, 'utf8'));
    assert.deepEqual(now.projects[c.project].disabledMcpServers, ['claude.ai Linear']);
    assert.equal(now.projects[c.project].lastCost, 1.25, 'the concurrent write was clobbered');
    assert.equal(now.projects[c.project].lastSessionId, 'session-b');
  });

  /**
   * The mutation the brief names second: the re-read dropped.
   *
   * This is what `applyPlan` was before QM-46 -- a stage taken at plan time, carried
   * across the confirmation, and handed to `applyStage`. It is not *unsafe*; it is
   * *useless*, and that is the harder failure to see. On the quiet axes it is
   * indistinguishable from the real thing, so the case that separates them is a file that
   * moved for reasons that are nobody's business, and there the real one writes and this
   * one refuses. A test asserting only "the mutant does something different" would pass
   * on the wrong difference, so both halves are pinned.
   */
  test('and a stage carried across the confirmation refuses the same write', () => {
    const c = claudeScratch('mcp-stale');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    const staleStage = stageEdits(c.target, plan.edits);
    assert.equal(staleStage.outcome, 'staged');
    if (staleStage.outcome !== 'staged') return;

    writeFileSync(c.target, claudeJsonText(c.project, [], 'session-b'));

    const stale = applyStage(staleStage.stage);
    assert.equal(stale.outcome, 'refused', 'the stale stage applied — the mutation is not being modelled');
    if (stale.outcome !== 'refused') return;
    assert.equal(stale.refusal.reason, 'file-moved');

    assert.equal(applyPlan(plan, opts(c.state)).outcome, 'written');
  });

  /**
   * The mutation the brief names fourth: undo clobbering telemetry written since.
   *
   * `undoLast` on this axis puts back the *entries* and nothing else. The mutant is the
   * inherited operation -- restore the pre-image blob -- and what it costs is visible in
   * one number: every `lastCost` and `lastSessionId` written between the apply and the
   * undo. It also cannot run: the whole-file guard compares a hash that stops matching
   * within ~11.5s of the apply, so the operation that would discard the telemetry is the
   * one that would refuse to try.
   */
  test('undo puts back the entry and keeps the telemetry written since', () => {
    const c = claudeScratch('mcp-undo');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    const applied = applyPlan(plan, opts(c.state));
    assert.equal(applied.outcome, 'written');
    if (applied.outcome !== 'written') return;

    // A session runs, and the file gains telemetry the undo has no business discarding.
    const withCost = readFileSync(c.target, 'utf8').replace('"lastCost": 0.5', '"lastCost": 7.75');
    writeFileSync(c.target, withCost);

    const undone = undoLast(opts(c.state));
    assert.equal(undone.outcome, 'restored', `undo refused: ${JSON.stringify(undone)}`);
    const now = JSON.parse(readFileSync(c.target, 'utf8'));
    assert.deepEqual(now.projects[c.project].disabledMcpServers, [], 'the entry was not put back');
    assert.equal(now.projects[c.project].lastCost, 7.75, 'undo discarded telemetry written since');

    // The mutant, and both halves of what it costs.
    const clobbered = readFileSync(applied.backup, 'utf8');
    assert.equal(JSON.parse(clobbered).projects[c.project].lastCost, 0.5);
    assert.notEqual(
      costOf(c.target, c.project),
      JSON.parse(clobbered).projects[c.project].lastCost,
      'the pre-image and the live file agree, so this case cannot show the loss',
    );
    assert.notEqual(
      createHash('sha256').update(Buffer.from(withCost, 'utf8')).digest('hex'),
      applied.record.sha256After,
      'the whole-file guard would still have matched, so it would not have refused either',
    );
  });

  /**
   * The entry-level guard undo keeps, which is the intent of the whole-file one at the
   * granularity that can survive this file.
   */
  test('and refuses when the entry itself has changed since', () => {
    const c = claudeScratch('mcp-undo-changed');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    assert.equal(applyPlan(plan, opts(c.state)).outcome, 'written');

    // Someone denies a second server by hand. The entry this tool wrote is still there,
    // so this must still restore -- only *its* entry is its business.
    const theirs = readFileSync(c.target, 'utf8').replace(
      '"claude.ai Linear"',
      '"claude.ai Linear",\n          "claude.ai Canva"',
    );
    writeFileSync(c.target, theirs);
    assert.equal(undoLast(opts(c.state)).outcome, 'restored');
    assert.deepEqual(
      JSON.parse(readFileSync(c.target, 'utf8')).projects[c.project].disabledMcpServers,
      ['claude.ai Canva'],
      'undo removed an entry it did not write',
    );

    // And an entry someone reversed by hand is refused.
    const d = claudeScratch('mcp-undo-reversed');
    const p2 = planMcp(d.target, d.project, 'claude.ai Linear', false, d.text);
    assert.equal(applyPlan(p2, opts(d.state)).outcome, 'written');
    writeFileSync(d.target, claudeJsonText(d.project, [], 'session-b'));
    const result = undoLast(opts(d.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(result.code, 'target-changed');
  });

  test('a project entry that is not there is never invented', () => {
    const c = claudeScratch('mcp-no-entry');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    const orphan: TogglePlan = { ...plan, project: '/nowhere/at/all' };

    const result = applyPlan(orphan, opts(c.state));
    assert.equal(result.outcome, 'refused');
    if (result.outcome !== 'refused') return;
    assert.equal(readFileSync(c.target, 'utf8'), c.text);
  });

  /**
   * The ownership guard, on the axis that made it necessary.
   *
   * `FORBIDDEN_BASENAMES` used to carry `.claude.json` and that is how a plan naming it
   * was stopped. One axis owns that name now, so the flat set cannot make the check any
   * more, and what replaced it has to be tested from both sides: a plugin plan naming the
   * MCP axis's file, and an MCP plan naming anything else. Measured -- widening
   * `MCP_AXIS.owns` to accept every path left all 644 tests green until this existed.
   */
  test('an MCP plan naming any other file is refused, and the file is untouched', () => {
    const c = claudeScratch('mcp-owns');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    const elsewhere = join(c.project, '.claude', 'settings.local.json');
    writeFileSync(elsewhere, BEFORE);

    for (const target of [elsewhere, join(c.project, '.claude', 'settings.json')]) {
      writeFileSync(target, BEFORE);
      const result = applyPlan({ ...plan, target }, opts(c.state));
      assert.equal(result.outcome, 'refused', `${target}: applied instead of refusing`);
      if (result.outcome !== 'refused') return;
      assert.equal(result.code, 'forbidden-target');
      assert.equal(readFileSync(target, 'utf8'), BEFORE, `${target}: was written`);
    }
  });

  /** The backup of a file holding a userID is not published at 0644 by a default umask. */
  test('the pre-image is kept at the mode the original was read under', () => {
    const c = claudeScratch('mcp-backup-mode');
    const plan = planMcp(c.target, c.project, 'claude.ai Linear', false, c.text);
    const result = applyPlan(plan, opts(c.state));
    assert.equal(result.outcome, 'written');
    if (result.outcome !== 'written') return;
    assert.equal(statSync(result.backup).mode & 0o777, 0o600);
  });
});

/**
 * The promoted settings axis (QM-55).
 *
 * `qm set --promote` is the only way this repo writes a project's tracked `settings.json`,
 * and it exists because `project-optimizer` always did -- team config belongs in the file
 * the team clones. What has to stay true is that lifting the ban lifts it for exactly one
 * axis and exactly one path.
 *
 * Every test below is written so that the obvious wrong implementation fails it. The
 * mutation each one answers is named in place, and `promoteGate` is run against a
 * deliberately-broken applier at the end the way `forbiddenGate` is.
 */
describe('promotion', () => {
  /**
   * The barrier that must survive, stated as the mutation it catches.
   *
   * `promotes` clears the basename ban, so the danger is an axis that sets it and should
   * not -- `PLUGIN_AXIS.promotes = true` would let every ordinary `qm set` write the
   * tracked file. `owns` is the second, independent barrier, and it is the one that has to
   * hold when the first is gone: a promoted plan naming *another* project's tracked file
   * is still refused, because the path is not the one this axis builds for this project.
   */
  function promoteGate(apply: Applier): string[] {
    const failures: string[] = [];
    const axis = promote(PLUGIN_AXIS);

    // 1. An unpromoted axis is still refused the tracked file, ban intact.
    {
      const s = scratch('promote-unpromoted');
      const target = join(s.project, '.claude', PROMOTED_TARGET_FILENAME);
      writeFileSync(target, BEFORE);
      const plan: TogglePlan = { ...planOver(s.target, s.project), target };
      const r = apply(plan, opts(s.state));
      if (r.outcome !== 'refused') failures.push('unpromoted axis wrote settings.json');
      if (readFileSync(target, 'utf8') !== BEFORE) failures.push('unpromoted axis changed settings.json');
    }

    // 2. A promoted axis is refused ANOTHER project's tracked file. This is `owns`, and it
    //    is the only barrier left once `promotes` has cleared the other one.
    {
      const mine = scratch('promote-owns-mine');
      const theirs = scratch('promote-owns-theirs');
      const target = join(theirs.project, '.claude', PROMOTED_TARGET_FILENAME);
      writeFileSync(target, BEFORE);
      const plan: TogglePlan = { ...planOver(mine.target, mine.project), axis, target };
      const r = apply(plan, opts(mine.state));
      if (r.outcome !== 'refused') failures.push("promoted axis wrote another project's settings.json");
      if (readFileSync(target, 'utf8') !== BEFORE) failures.push("promoted axis changed another project's file");
    }

    // 3. And it DOES write its own, or the feature does not exist.
    {
      const s = scratch('promote-own');
      const target = join(s.project, '.claude', PROMOTED_TARGET_FILENAME);
      const plan: TogglePlan = { ...planOver(target, s.project), axis, target };
      const r = apply(plan, opts(s.state));
      if (r.outcome !== 'written') failures.push(`promoted axis refused its own target: ${r.outcome}`);
    }
    return failures;
  }

  test('lifts the ban for one axis and one path, and `owns` still holds', () => {
    const failures = promoteGate(applyPlan);
    assert.deepEqual(failures, [], report(failures));
  });

  /**
   * The four fields are one fact, so a promotion that moves three of them is broken in a
   * way no single-field assertion would catch. `validated` is the one most easily left
   * behind -- it reads a different member of the same record and still typechecks.
   */
  test('target, owns, validated and afterChain all move together', () => {
    const axis = promote(PLUGIN_AXIS);
    const project = '/p';
    const tracked = join(project, '.claude', PROMOTED_TARGET_FILENAME);
    const local = join(project, '.claude', TARGET_FILENAME);

    assert.equal(axis.target({} as never, project), tracked);
    assert.equal(axis.owns(tracked, project), true);
    assert.equal(axis.owns(local, project), false, 'a promoted axis still owns the local file');

    const record = {
      settings: { path: tracked } as never,
      localSettings: { path: local } as never,
    } as never;
    assert.equal((axis.validated(record) as { path: string }).path, tracked,
      'validated still reads the local file');

    // `resolve.ts` pushes settings.json at `project` scope. An afterChain saying `local`
    // would describe a chain the resolver never builds.
    const now = { value: false, origin: 'inherited', chain: [] } as never;
    assert.equal(axis.afterChain(now, tracked, true)[0]?.scope, 'project');
  });

  /** The MCP axis has no tracked sibling, and saying so beats writing somewhere odd. */
  test('refuses an axis with no tracked file to promote into', () => {
    assert.throws(() => promote(MCP_AXIS), /no tracked file/);
    for (const axis of [PLUGIN_AXIS, SKILL_AXIS]) {
      assert.equal(promote(axis).promotes, true, `${axis.name} did not promote`);
      assert.equal(axis.promotes, false, `${axis.name} was mutated in place`);
    }
  });

  /**
   * Containment. Every caller that resolves an axis by name -- `--axis`, the grid's POST
   * routes, `undo` reading a record -- goes through `AXES`, and none of them may get a
   * promoted axis by accident. Promotion is reachable only by calling `promote`.
   */
  test('no axis reachable by name promotes', () => {
    for (const [name, axis] of AXES) {
      assert.equal(axis.promotes, false, `AXES holds a promoted axis under ${name}`);
    }
  });
});
