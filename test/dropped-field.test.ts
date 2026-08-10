/**
 * The dropped-settings-field detector (DEA-149).
 *
 * A file Claude Code *keeps* while throwing part of it away. `discardedSettings` reports
 * the file that is gone; this reports the one that applies with a hole in it, and the two
 * are different findings with different units, different severities and different
 * sentences. The seam is asserted from both sides: `test/discarded-settings.test.ts` goes
 * red if a `field-dropped` file is reported there, and this goes red if a `discarded` one
 * is reported here.
 *
 * ## What both halves of every case are
 *
 * The same recording `validity.test.ts` and `discarded-settings.test.ts` run on, through
 * the same `load.ts`: `claude doctor`, verbatim, against the settings files that produced
 * it, with `claude plugin list --json` recorded beside it saying the file still applies.
 * `EXPECTED` is read off the committed recording and the committed JSON **as literals** --
 * including the titles, in full, and the line accounting for what was lost. Rebuilding a
 * title with the same `plural()` the detector uses would agree with whatever it does, which
 * is the defect c29ef4a had to fix one level up.
 *
 * ## The four failures it is built to catch
 *
 * 1. **A `discarded` file reported here.** The whole file is gone; charging one key for it
 *    names the wrong cause and the wrong cost.
 * 2. **A `not-checked` file reported here.** `costOf` sends a message from neither family
 *    to `unknown` and `validityOf` sends the file to `not-checked`, on purpose: losing a
 *    detection beats fabricating one about live config. A detector that walked the errors
 *    without asking about the file would undo that quietly. That state had a recording
 *    until DEA-152 taught the classifier both messages that produced one; it is constructed
 *    now, under "the two silences", and labelled there.
 * 3. **The cost figure.** Three units, the file's own entry count is none of them, and one
 *    of the three has no figure at all because nobody measured it (DEA-152) -- so the
 *    failure to catch there is a number appearing, not a number being wrong.
 * 4. **The tripwire.** `effect.ts` answers `reload` for a deny rule in a `field-dropped`
 *    file, which is correct only while no partial acceptance can name a key it reasons
 *    about. That is a measurement of Claude Code's schema messages, not a property of this
 *    code, so it is watched rather than assumed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  ENTRY_IGNORED_NOTE,
  parseInvalidSettings,
  settingsFromDoctor,
  validityOf,
} from '../src/delegate/doctor.ts';
import {
  discardedSettings,
  droppedSettingsField,
  settingsFiles,
  settingsValidityTally,
  unclassifiedSettings,
  type AuditContext,
  type Finding,
} from '../src/detect.ts';
import { EFFECT_SETTINGS_KEYS, effectDependsOn } from '../src/effect.ts';
import { NOT_CHECKED, loadWorkspace } from '../src/surfaces/read.ts';
import type { SettingsCheck, SettingsError, Workspace } from '../src/surfaces/types.ts';
import {
  CASES,
  FIXTURE_ROOT,
  caseDir,
  checksFor,
  covered,
  doctorText,
  settingsPath,
  type RecordedCase,
} from './fixtures/doctor/load.ts';

// ---------------------------------------------------------------------------
// What the recording says, as literals
// ---------------------------------------------------------------------------

interface ExpectedFinding {
  /** Which of the case's two settings files. */
  file: 'settings.json' | 'settings.local.json';
  /** The key path `doctor` printed, verbatim. */
  key: string;
  /**
   * The title, in full.
   *
   * A literal and not a template. The one assertion that used to read a title in this repo
   * read a *number* back out of it, and an ungrammatical sentence shipped underneath a
   * green suite for a day (c29ef4a). Both units appear below, and the counted one appears
   * at one, two and three, because "1 value" and "3 values" are the same code path only
   * until they are not.
   */
  title: string;
  /**
   * The evidence line naming what was lost, verbatim.
   *
   * The unit lives here and nowhere else in the output: a whole-field drop and an entry
   * drop share a title, differing only in the key, so a gate reading titles alone cannot
   * tell them apart and a classifier folding one into the other would pass. `costLine` is
   * the half that says *what* went (DEA-152).
   */
  costLine: string;
  /**
   * Values Claude Code removed from the array, counted off the committed JSON, and rules
   * left in force. Absent for a whole-field drop, which has no number by construction --
   * `hooks: 42` had no entries to lose -- and for an entry drop, which has one nobody
   * measured.
   */
  removed?: number;
  kept?: number;
}

/**
 * The sentence a whole-field drop and an entry drop share, with the key varying.
 *
 * Shared here because it is shared in the source, and pinning one spelling twice would
 * only mean editing both. It is a literal in the sense that matters: nothing here is
 * rebuilt with the detector's own `plural()`, which is the defect c29ef4a had to fix.
 */
const IGNORES_TITLE = (key: string, file: string) =>
  `Claude Code ignores ${key} in ${file}, and applies the rest of the file`;

const WHOLE_FIELD = (key: string) => `${key}: the whole field is not in effect`;
const ONE_ENTRY = (key: string) =>
  `${key}: this entry is not in effect, and what it cost is not measured`;

const EXPECTED: Record<string, ExpectedFinding[]> = {
  // Nothing wrong, so nothing said.
  accepted: [],
  // Gone whole. `discardedSettings` owns these; there is no field to report.
  'discarded-marketplace-source': [],
  'discarded-permissions-deny': [],
  'discarded-many-entries': [],
  'valid-local-over-discarded': [],
  // The whole-field drop, and the file still applies.
  'field-dropped-hooks': [
    {
      file: 'settings.json',
      key: 'hooks',
      title: IGNORES_TITLE('hooks', 'settings.json'),
      costLine: WHOLE_FIELD('hooks'),
    },
  ],
  // Two files, two validities, one run. The project file lost a field; the local file is
  // discarded and belongs to the other detector.
  'dropped-over-discarded': [
    {
      file: 'settings.json',
      key: 'hooks',
      title: IGNORES_TITLE('hooks', 'settings.json'),
      costLine: WHOLE_FIELD('hooks'),
    },
  ],
  // Elements, not a field: `[1, 2, "Bash"]` keeps "Bash".
  'deny-nonstring-elements': [
    {
      file: 'settings.json',
      key: 'permissions.deny',
      title:
        'Claude Code removes 2 values from permissions.deny in settings.json, ' +
        'leaving 1 rule in force',
      costLine: 'permissions.deny: 2 of 3 values removed, 1 still in force',
      removed: 2,
      kept: 1,
    },
  ],
  // The same shape at one, where the noun changes and the verb does not.
  'allow-nonstring-elements': [
    {
      file: 'settings.json',
      key: 'permissions.allow',
      title:
        'Claude Code removes 1 value from permissions.allow in settings.json, ' +
        'leaving 1 rule in force',
      costLine: 'permissions.allow: 1 of 2 values removed, 1 still in force',
      removed: 1,
      kept: 1,
    },
  ],
  // Both counted units in one file, in the order doctor printed them. The file decides 2
  // entries elsewhere and neither cost figure is 2.
  'dropped-field-and-elements': [
    {
      file: 'settings.json',
      key: 'permissions.deny',
      title:
        'Claude Code removes 3 values from permissions.deny in settings.json, ' +
        'leaving 1 rule in force',
      costLine: 'permissions.deny: 3 of 4 values removed, 1 still in force',
      removed: 3,
      kept: 1,
    },
    {
      file: 'settings.json',
      key: 'hooks',
      title: IGNORES_TITLE('hooks', 'settings.json'),
      costLine: WHOLE_FIELD('hooks'),
    },
  ],
  // `This entry was ignored.` -- one word off the sentence `FIELD_IGNORED_NOTE` pins, and
  // a third unit: one event of the `hooks` record is gone, its siblings and the file
  // apply, and what that cost is unmeasured (DEA-152). So the key is named and no number
  // is printed. It read `not-checked` and produced nothing at all until this release.
  'hook-entry-ignored': [
    {
      file: 'settings.json',
      key: 'hooks.PreToolUse',
      title: IGNORES_TITLE('hooks.PreToolUse', 'settings.json'),
      costLine: ONE_ENTRY('hooks.PreToolUse'),
    },
  ],
  // Two units in one file that first-party applies, in doctor's order: the whole `hooks`
  // field, and one entry of `extraKnownMarketplaces` -- DEA-147's own incident key, which
  // voided the whole file on 2.1.221 and drops one marketplace on 2.1.224. The key is
  // reported as `doctor` gives it; the failing sub-path is inside the message and stays
  // there.
  'mixed-known-and-unknown': [
    {
      file: 'settings.json',
      key: 'hooks',
      title: IGNORES_TITLE('hooks', 'settings.json'),
      costLine: WHOLE_FIELD('hooks'),
    },
    {
      file: 'settings.json',
      key: 'extraKnownMarketplaces.karpathy-skills',
      title: IGNORES_TITLE('extraKnownMarketplaces.karpathy-skills', 'settings.json'),
      costLine: ONE_ENTRY('extraKnownMarketplaces.karpathy-skills'),
    },
  ],
};

/** Entries a whole-file counter would charge the dropped key with, off the committed JSON. */
const FILE_ENTRIES: Record<string, number> = {
  'field-dropped-hooks': 1,
  'dropped-over-discarded': 1,
  'deny-nonstring-elements': 1,
  'allow-nonstring-elements': 1,
  'dropped-field-and-elements': 2,
  'hook-entry-ignored': 1,
  'mixed-known-and-unknown': 1,
};

const pathOf = (c: RecordedCase, e: ExpectedFinding) => join(caseDir(c), '.claude', e.file);

// ---------------------------------------------------------------------------
// Running the detector over one case
// ---------------------------------------------------------------------------

/**
 * A mutation, in the two places a wrong detector could live.
 *
 * `cost` substitutes the message-to-cost rule and lets the **real** `validityOf` recompute
 * the file from it, which is where DEA-151 lived and where every "reported the wrong class
 * of file" defect has to come from: the guard is two-part -- the file must be
 * `field-dropped` *and* the error must have a partial-acceptance cost -- so moving one
 * without the other proves nothing. `finding` rewrites what came out, which is the only
 * way to ask what a differently-counted cost figure would look like without keeping a
 * second copy of the detector in the test.
 */
interface Lens {
  cost?: (e: SettingsError) => SettingsError['costs'];
  finding?: (f: Finding, c: RecordedCase) => Finding;
}

const CLEAN: Lens = {};

function ctxFor(ws: Workspace): AuditContext {
  return { ws, measurements: [], pluginCosts: new Map(), inventories: new Map() };
}

function load(c: RecordedCase, checks: ReadonlyMap<string, SettingsCheck>): Workspace {
  return loadWorkspace({
    home: FIXTURE_ROOT,
    claudeJsonPath: join(FIXTURE_ROOT, 'no-such-claude.json'),
    userSettingsPath: join(FIXTURE_ROOT, 'no-such-user-settings.json'),
    extraProjectPaths: [caseDir(c)],
    settingsValidity: () => checks,
  });
}

/** The case as `--full` sees it, with the cost rule substituted on the way in. */
function checked(c: RecordedCase, lens: Lens): Workspace {
  const checks = new Map<string, SettingsCheck>();
  for (const [path, check] of checksFor(c)) {
    const errors = check.schemaErrors.map((e) => ({
      ...e,
      ...(lens.cost ? { costs: lens.cost(e) } : {}),
    }));
    checks.set(path, { validity: validityOf(errors), schemaErrors: errors });
  }
  return load(c, checks);
}

/** The case as every run without `--full` sees it: nothing asked, so nothing known. */
const unchecked = (c: RecordedCase): Workspace =>
  load(c, new Map(covered(c).map((p) => [p, NOT_CHECKED])));

const found = (c: RecordedCase, lens: Lens): Finding[] =>
  droppedSettingsField(ctxFor(checked(c, lens))).map((f) => (lens.finding ? lens.finding(f, c) : f));

/** The claimed cost, read back out of the title the way a reader would. */
const claimedRemoved = (f: Finding): number | null => {
  const m = /removes (\d+) (?:value|values) from/.exec(f.title);
  return m ? Number(m[1]) : null;
};
const claimedKept = (f: Finding): number | null => {
  if (/leaving none in force/.test(f.title)) return 0;
  const m = /leaving (\d+) (?:rule|rules) in force/.exec(f.title);
  return m ? Number(m[1]) : null;
};

function runGate(lens: Lens): string[] {
  const failures: string[] = [];

  for (const c of CASES) {
    const expected = EXPECTED[c.name] ?? [];
    const recorded = checksFor(c);
    const reported = found(c, lens);

    for (const f of reported) {
      const path = f.evidence[0] ?? '(no path in evidence)';
      const key = f.key?.split(' ').at(-1) ?? '(no key)';
      const want = expected.find((e) => pathOf(c, e) === path && e.key === key);
      if (!want) {
        failures.push(
          `${c.name}: reported ${key} in ${path}, which the recording leaves ` +
            `${recorded.get(path)?.validity ?? 'unnamed by doctor'} — nothing established ` +
            'that Claude Code kept the file and dropped that key',
        );
        continue;
      }

      if (f.severity !== 'medium') {
        failures.push(`${c.name}: ${want.key} reported at severity ${f.severity}, not medium`);
      }
      if (f.title !== want.title) {
        failures.push(
          `${c.name}: ${want.key} is titled\n      "${f.title}"\n    and the recording ` +
            `says\n      "${want.title}"`,
        );
      }
      if (claimedRemoved(f) !== (want.removed ?? null)) {
        failures.push(
          `${c.name}: ${want.key} claims ${claimedRemoved(f)} values removed; the file has ` +
            `${want.removed ?? 'no counted removal, being a whole field'} there, and ` +
            `${FILE_ENTRIES[c.name] ?? 0} entries in the file as a whole`,
        );
      }
      if (claimedKept(f) !== (want.kept ?? null)) {
        failures.push(
          `${c.name}: ${want.key} claims ${claimedKept(f)} rules still in force; the file ` +
            `keeps ${want.kept ?? 'no array of rules under that key'}`,
        );
      }
      if (!f.evidence.some((e) => e.startsWith(`${want.key}: `))) {
        failures.push(
          `${c.name}: ${want.key} is reported without doctor's own line for it — nothing ` +
            'in the finding says what was rejected',
        );
      }
      // The unit, which the title cannot carry: a whole field and one entry of a record
      // are the same sentence with a different key, so this is the only place a finding
      // says which of them happened, and the only assertion a classifier folding one into
      // the other would fail.
      if (!f.evidence.includes(want.costLine)) {
        failures.push(
          `${c.name}: ${want.key} accounts for its loss as\n      ` +
            `"${f.evidence.at(-1)}"\n    and the recording makes it\n      ` +
            `"${want.costLine}"`,
        );
      }
    }

    for (const e of expected) {
      if (!reported.some((f) => f.evidence[0] === pathOf(c, e) && f.key?.endsWith(` ${e.key}`))) {
        failures.push(
          `${c.name}: said nothing about ${e.key} in ${e.file}, which doctor reports and ` +
            'first-party still applies the file — the key is dead and reads as live',
        );
      }
    }

    // The default run: nothing was asked, so nothing may be claimed.
    if (droppedSettingsField(ctxFor(unchecked(c))).length) {
      failures.push(
        `${c.name}: with nothing checked, reported a dropped field — no check looked at ` +
          'that file',
      );
    }
  }

  return failures;
}

const failureMessage = (f: readonly string[]) =>
  `\n  ${f.length} divergence(s):\n  ${f.join('\n  ')}`;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('the detector reports the fields claude doctor drops, and only those', () => {
  test('every recorded case agrees', () => {
    const failures = runGate(CLEAN);
    const reported = CASES.reduce((n, c) => n + (EXPECTED[c.name] ?? []).length, 0);
    console.log(
      `    dropped-settings-field: ${CASES.length} recorded cases, ${reported} findings ` +
        `expected, ${CASES.filter((c) => !(EXPECTED[c.name] ?? []).length).length} silent`,
    );
    assert.deepEqual(failures, [], failureMessage(failures));
  });

  test('and the recording is not vacuous', () => {
    const all = CASES.flatMap((c) => EXPECTED[c.name] ?? []);
    assert.ok(all.length >= 4, 'too few findings expected to say anything');
    assert.ok(
      CASES.some((c) => !(EXPECTED[c.name] ?? []).length),
      'every case expects a finding, so a detector that always fires would pass',
    );

    // All three units are exercised, or one of the three cost models is untested. Read off
    // the cost lines rather than off `removed`, because two of the three have no number
    // and would be indistinguishable by its absence.
    assert.ok(
      all.some((e) => e.costLine.endsWith('the whole field is not in effect')),
      'no whole-field drop in the set',
    );
    assert.ok(
      all.some((e) => e.costLine.endsWith('what it cost is not measured')),
      'no entry drop in the set',
    );
    assert.ok(
      all.some((e) => /\d+ of \d+ values? removed/.test(e.costLine)),
      'no element removal in the set',
    );
    assert.ok(all.some((e) => e.removed !== undefined), 'no counted unit in the set');

    // And the counted unit varies, so a constant would not pass.
    const counts = new Set(all.filter((e) => e.removed !== undefined).map((e) => e.removed));
    assert.ok(counts.size >= 2, `every counted finding removes ${[...counts]} — a constant passes`);

    // The number is not the file's own entry count anywhere it could be confused for it.
    const confusable = CASES.filter((c) =>
      (EXPECTED[c.name] ?? []).some((e) => e.removed !== undefined && e.removed !== FILE_ENTRIES[c.name]),
    );
    assert.ok(
      confusable.length >= 2,
      'no case removes a different number of values than the file has entries, so a ' +
        'detector charging the whole file would pass',
    );
  });

  /**
   * The unit nobody measured ships no figure (DEA-152).
   *
   * An entry drop names the key and stops. The finding's value is the name -- `Claude Code
   * ignores hooks.PreToolUse in settings.json` is true and complete -- and a number beside
   * it would have to be the file's own entry count, which prices one dropped hook event at
   * whatever unrelated plugins the file happens to enable. That is DEA-147's generalisation
   * arriving a third time, and the issue that added these patterns says so in its own
   * description.
   *
   * Asserted on the title, because that is where a count would go and where the
   * whole-file mutation below puts one. The two counted findings are the control: this
   * would pass on a detector that never printed a number at all.
   */
  test('and an entry drop carries no count, while a counted unit still does', () => {
    const digitsIn = (name: string) =>
      found(CASES.find((x) => x.name === name)!, CLEAN).map((f) => /\d/.test(f.title));

    assert.deepEqual(digitsIn('hook-entry-ignored'), [false]);
    assert.deepEqual(digitsIn('mixed-known-and-unknown'), [false, false]);
    // …and the units that were measured print theirs, or this passes vacuously.
    assert.deepEqual(digitsIn('dropped-field-and-elements'), [true, false]);
  });

  /**
   * The seam, as a partition rather than as two separate claims.
   *
   * Every settings file in the recording belongs to at most one of the two detectors. A
   * file reported by both would mean one of them is reading a validity it has no business
   * with, and neither suite's own expectations would notice, because each checks only its
   * own list.
   */
  test('and no file is reported by both this detector and discardedSettings', () => {
    let dropped = 0;
    let discarded = 0;

    for (const c of CASES) {
      const ctx = ctxFor(checked(c, CLEAN));
      const here = new Set(droppedSettingsField(ctx).map((f) => f.evidence[0]));
      const there = new Set(discardedSettings(ctx).map((f) => f.evidence[0]));
      dropped += here.size;
      discarded += there.size;

      for (const path of here) {
        assert.ok(!there.has(path), `${c.name}: ${path} is reported by both detectors`);
      }
    }

    assert.ok(dropped > 0 && discarded > 0, 'one of the two detectors reported nothing at all');
  });
});

// ---------------------------------------------------------------------------
// The two silences (DEA-151, inherited)
// ---------------------------------------------------------------------------

/**
 * This detector is silent for two different reasons and only one of them is a failure.
 *
 * No dropped field is nothing to say. A dropped field whose message matched neither family
 * is a *lost detection*: `costOf` returns `unknown`, `validityOf` returns `not-checked`,
 * the file never reaches the detector, and the run behaves exactly as it did before any of
 * this existed. That trade is deliberate -- a wrong `discarded` fabricates a high-severity
 * finding about working config -- but it is only defensible while someone can see it being
 * made, so the second silence has to be visible in the run's own output.
 *
 * Answered by `unclassifiedSettings`, which already exists, rather than by a third
 * recogniser here. What this owes is the proof that the two are distinguishable.
 *
 * **The unrecognised half is constructed again, and that is the shape of the trade
 * (DEA-152).** `hook-entry-ignored` was a *recording* of it -- 2.1.224 prints
 * `This entry was ignored.` for a malformed hook event, one word off the sentence
 * `FIELD_IGNORED_NOTE` pins -- and so was the marketplace entry in
 * `mixed-known-and-unknown`. Teaching the classifier both spent the only live evidence
 * that the default works: no recording produces `unknown` any more, which is where DEA-151
 * started. Both recordings are unchanged and both are still first-party; what moved is
 * this release's reading of them.
 *
 * So the block below is half recorded and half invented. The recognised error is lifted
 * verbatim out of `field-dropped-hooks`, and the message beside it is one nobody has ever
 * printed -- which is the right anchor regardless, because the claim is about a phrasing
 * that has *not* been seen, and a recording can only ever stand for one that has.
 */
describe('the two silences are told apart', () => {
  /** Obviously not first-party. Shared with `validity.test.ts`'s constructed block. */
  const INVENTED = 'Rule 3 was quarantined pending review';

  /**
   * One recorded partial acceptance and one message from nowhere, against one file.
   *
   * `validityOf` is a lattice, so the file is `not-checked` while a recognised `field`
   * error sits in it -- the one state in which a detector guarding on the error alone,
   * and not on the file, reports a file whose fate was never established.
   */
  const MIXED = CASES.find((x) => x.name === 'field-dropped-hooks')!;

  function mixedBlock(): string {
    const recorded = doctorText(MIXED)
      .split('\n')
      .find((l) => l.startsWith('- '))!;
    return `Invalid settings\n${recorded}\n- ${settingsPath(MIXED)} › permissions.deny: ${INVENTED}\n`;
  }

  /** The constructed case, with an optional substitute for the cost of one message. */
  function mixedWorkspace(cost?: (e: SettingsError) => SettingsError['costs']): Workspace {
    const checks = new Map<string, SettingsCheck>();
    for (const [path, check] of settingsFromDoctor(mixedBlock(), covered(MIXED))) {
      const errors = check.schemaErrors.map((e) => ({ ...e, ...(cost ? { costs: cost(e) } : {}) }));
      checks.set(path, { validity: validityOf(errors), schemaErrors: errors });
    }
    return load(MIXED, checks);
  }

  const silent = (name: string) => {
    const c = CASES.find((x) => x.name === name)!;
    const ws = checked(c, CLEAN);
    assert.deepEqual(droppedSettingsField(ctxFor(ws)), [], `${name}: expected no finding`);
    return ws;
  };

  test('a file with nothing dropped is silent, and the run says nothing about it', () => {
    const ws = silent('accepted');
    assert.equal(settingsValidityTally(ws).accepted, 1);
    assert.deepEqual(unclassifiedSettings(ws), []);
  });

  test('and a file doctor reported in words nobody recognised is silent, and named', () => {
    const ws = mixedWorkspace();
    assert.equal(settingsValidityTally(ws)['not-checked'], 1);
    assert.equal(settingsValidityTally(ws).accepted, 0);
    assert.equal(settingsValidityTally(ws)['field-dropped'], 0);

    // Nothing is claimed about it, though one of its two errors is perfectly well
    // understood. That is the file-level guard, and it is the whole of this test.
    assert.deepEqual(droppedSettingsField(ctxFor(ws)), []);

    const unclassified = unclassifiedSettings(ws);
    assert.equal(
      unclassified.length,
      1,
      'the run cannot say that first-party reported this file in words it could not place',
    );
    assert.equal(unclassified[0]!.path, settingsPath(MIXED));
    assert.deepEqual(
      unclassified[0]!.schemaErrors.map((e) => `${e.key}: ${e.message}`),
      [
        'hooks: "hooks" must be an object mapping event names to matcher arrays; ' +
          'received number. This field was ignored.',
        `permissions.deny: ${INVENTED}`,
      ],
    );
  });

  /**
   * And the mutation, which moved here when its recording was consumed.
   *
   * It used to run inside `runGate` off `hook-entry-ignored`: round the unrecognised
   * message into the nearest known class and the detector reports a file nothing
   * established. No recording produces `unknown` now, so the case it needs is the
   * constructed one -- but the claim is unchanged, and so is the failure it names.
   *
   * What it proves is that the *file-level* guard is load-bearing. The recognised `hooks`
   * error has cost `field` in both runs, so a detector guarding only on the error reports
   * it in both; only `validity !== 'field-dropped'` tells them apart.
   */
  test('and rounding that message into a known class is what reports it', () => {
    const rounded = mixedWorkspace((e) => (e.costs === 'unknown' ? 'field' : e.costs));
    assert.equal(rounded.projects[0]!.settings!.validity, 'field-dropped');

    const found = droppedSettingsField(ctxFor(rounded));
    assert.deepEqual(
      found.map((f) => f.key),
      [
        `dropped-settings-field ${settingsPath(MIXED)} hooks`,
        `dropped-settings-field ${settingsPath(MIXED)} permissions.deny`,
      ],
      'rounding an unrecognised message to a dropped field reported neither key — the ' +
        'mutation no longer reaches the detector, so it is not proving the guard',
    );
    assert.deepEqual(unclassifiedSettings(rounded), [], 'and the run no longer says it guessed');
  });

  /**
   * And the two are not the same in the run's output, which is the whole claim. A default
   * run leaves every file `not-checked` with no errors, and that must not read like a
   * first-party message nobody could place.
   */
  test('and neither reads like the other', () => {
    const quiet = CASES.find((x) => x.name === 'accepted')!;

    assert.notDeepEqual(
      settingsValidityTally(checked(quiet, CLEAN)),
      settingsValidityTally(mixedWorkspace()),
      'a file reported in unknown words tallies the same as one that passed',
    );
    assert.equal(
      unclassifiedSettings(unchecked(MIXED)).length,
      0,
      'a run that asked nothing named a file',
    );
  });
});

// ---------------------------------------------------------------------------
// The tripwire (DEA-149's defect 2, which is not a defect)
// ---------------------------------------------------------------------------

/**
 * `qm effect` answers `reload` for a deny rule in a `field-dropped` file, and that is
 * correct rather than lucky -- but only for a reason nothing in this repo controls.
 *
 * The issue said it was a live wrong answer: a `field-dropped` file whose dropped field is
 * `permissions` has deny rules that are not in force while `effect.ts` still says
 * `reload`. Measured across thirteen malformed shapes on 2.1.222 and again on 2.1.224,
 * there is no such file. Every malformed `permissions` shape refuses the file whole
 * (`permissions: 42`, `permissions.deny` as a string, a number or an object,
 * `permissions.allow: 7`, `permissions.defaultMode: 7`,
 * `permissions.additionalDirectories: 5`), and the one partial acceptance it has removes
 * non-string *elements* and leaves the surviving rules in force -- which `readSettings`
 * already drops (DEA-150), so `reload` is right for what remains.
 *
 * So the narrowing is not written. What is written is the condition it depended on, as
 * something that can go red: **no drop that takes a key out of force may name a key
 * `effect.ts` reasons about.** A release that makes one droppable reintroduces the defect
 * silently, and this is what notices.
 *
 * Two of the three partial-acceptance units qualify (DEA-152). A whole field is gone and
 * an entry of a record is gone, and in both cases nothing under that key is in force --
 * so an entry drop naming `permissions.deny` would put `effect.ts` back to answering
 * `reload` about rules that do not apply, which is exactly the case this watches. It is
 * deliberately still not a claim about `elements`: `permissions.deny` loses values there
 * today, correctly, and its survivors stay in force.
 */
describe('no partial acceptance names a key qm effect reasons about', () => {
  /** Drops that remove a key from force and overlap one `classify` reads. Two callers. */
  const OUT_OF_FORCE: ReadonlySet<SettingsError['costs']> = new Set(['field', 'entry']);
  const offenders = (text: string, label: string) =>
    parseInvalidSettings(text)
      .filter((e) => OUT_OF_FORCE.has(e.costs) && effectDependsOn(e.key))
      .map((e) => `${label}: ${e.key} was dropped whole — "${e.message}"`);

  test('across every recorded doctor run', () => {
    const found = CASES.flatMap((c) => offenders(doctorText(c), c.name));
    assert.deepEqual(
      found,
      [],
      'a field qm effect reasons about is now droppable, so a deny rule under it is not ' +
        'in force while src/effect.ts still answers reload for it. DEA-149 measured this ' +
        'as unreachable on 2.1.222 and 2.1.224; it no longer is.' +
        failureMessage(found),
    );

    // Not vacuous: both out-of-force units exist in the set, and the predicate can say
    // yes. A filter covering only one of them would run on the recordings either way.
    const recorded = CASES.flatMap((c) => parseInvalidSettings(doctorText(c)));
    assert.ok(
      recorded.filter((e) => e.costs === 'field').length >= 2,
      'no recorded whole-field drop, so half the filter runs on nothing',
    );
    assert.ok(
      recorded.filter((e) => e.costs === 'entry').length >= 2,
      'no recorded entry drop, so half the filter runs on nothing',
    );
    assert.deepEqual(EFFECT_SETTINGS_KEYS, ['permissions.deny']);
    assert.ok(effectDependsOn('permissions.deny'), 'the predicate does not match its own key');
    assert.ok(effectDependsOn('permissions'), 'a dropped parent does not match its child');
    assert.ok(!effectDependsOn('hooks'), 'the predicate matches a key effect.ts never reads');
    assert.ok(!effectDependsOn('permissionsX'), 'the predicate matches on a prefix of a name');
  });

  /**
   * And it fires. The message is **constructed** and says so: no release has produced one,
   * which is the finding, so there is nothing to record. It is `hooks`' recorded sentence
   * with the key changed to the one that would matter.
   */
  test('and it goes red when one does', () => {
    const block =
      'Invalid settings\n' +
      '- /p/.claude/settings.json › permissions: "permissions" must be an object; ' +
      'received number. This field was ignored.\n';
    const found = offenders(block, 'constructed');
    assert.equal(found.length, 1, 'the tripwire cannot see the case it exists for');
    assert.match(found[0]!, /^constructed: permissions was dropped whole/);

    // The consequence, spelled out where the tripwire is: with the file `field-dropped`,
    // `classify` reads the rules as in force. `effect.test.ts` pins the verdict itself.
    assert.equal(validityOf(parseInvalidSettings(block)), 'field-dropped');
  });

  /**
   * And it goes red for the second unit, which is the half DEA-152 added.
   *
   * Also constructed, and doubly so: no release has dropped a `permissions` key as an
   * entry, and none has printed `This entry was ignored.` about one. The sentence is
   * 2.1.224's, recorded on `hooks.PreToolUse`; the key is the one that would matter. A
   * filter still reading `field` alone leaves this silent while the file resolves
   * `field-dropped` and `classify` reads the rules as live.
   */
  test('and for an entry drop, which takes its key out of force the same way', () => {
    const block =
      'Invalid settings\n' +
      `- /p/.claude/settings.json › permissions.deny: Deny rules must be an array of ` +
      `strings; received number. ${ENTRY_IGNORED_NOTE}\n`;
    const found = offenders(block, 'constructed');
    assert.equal(found.length, 1, 'the tripwire sees a whole field and not an entry');
    assert.match(found[0]!, /^constructed: permissions\.deny was dropped whole/);
    assert.equal(parseInvalidSettings(block)[0]!.costs, 'entry');
    assert.equal(validityOf(parseInvalidSettings(block)), 'field-dropped');
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

interface Mutation {
  name: string;
  lens: Lens;
  /** Every pattern has to be matched by some failure, so a gate failing elsewhere shows. */
  names: RegExp[];
}

/** The entries a file decides, as a whole-file counter would count them. */
const wholeFileCost = (f: Finding, c: RecordedCase): Finding => {
  const n = FILE_ENTRIES[c.name] ?? 0;
  return {
    ...f,
    title: /removes \d+ /.test(f.title)
      ? f.title.replace(/removes \d+ (?:values|value)/, `removes ${n} ${n === 1 ? 'value' : 'values'}`)
      : `Claude Code ignores ${f.key?.split(' ').at(-1)} in settings.json, so ${n} ` +
        `${n === 1 ? 'entry' : 'entries'} in it never ${n === 1 ? 'applies' : 'apply'}`,
  };
};

const MUTATIONS: Mutation[] = [
  {
    /**
     * **The seam, crossed the other way.** A whole-file refusal read as a partial
     * acceptance: the file is gone, and this reports one key of it as the loss while the
     * other 100% of it goes unmentioned. It is DEA-147's original bug inverted, and the
     * mirror of the mutation `discarded-settings.test.ts` runs.
     */
    name: 'a discarded file is reported as a dropped field',
    lens: { cost: (e) => (e.costs === 'file' ? 'field' : e.costs) },
    names: [
      /^discarded-marketplace-source: reported extraKnownMarketplaces\.karpathy-skills\.source in .*settings\.json, which the recording leaves discarded — nothing established that Claude Code kept the file and dropped that key$/,
      /^discarded-permissions-deny: reported permissions\.deny in .*settings\.json, which the recording leaves discarded/,
    ],
  },
  {
    /**
     * **The first of the two patterns DEA-152 added, removed again.** `This entry was
     * ignored.` is one word off the sentence `FIELD_IGNORED_NOTE` pins, and until 2.1.224
     * nothing said it. Unrecognised, the message goes to `unknown`, the file goes to
     * `not-checked`, and the key that Claude Code is ignoring reads as live configuration
     * to everyone who opens the file -- which is the state this issue was filed about, not
     * a crash. `unclassifiedSettings` is what keeps it visible, and it is not this
     * detector's output.
     */
    name: 'the hook-event sentence is not recognised',
    lens: { cost: (e) => (e.message.endsWith(ENTRY_IGNORED_NOTE) ? 'unknown' : e.costs) },
    names: [
      /^hook-entry-ignored: said nothing about hooks\.PreToolUse in settings\.json, which doctor reports and first-party still applies the file — the key is dead and reads as live$/,
    ],
  },
  {
    /**
     * **The second, and it costs more than its own finding.** The marketplace message is
     * DEA-147's incident key in its 2.1.224 phrasing. Unrecognised it takes the whole file
     * to `not-checked` -- `validityOf` is a lattice, and one error that cannot say the file
     * survived is enough -- so the recognised `hooks` drop beside it goes unreported too.
     * Both are required by name: a mutation caught only on its own key would not show that
     * an unread message silences the ones around it.
     */
    name: 'the marketplace message is not recognised',
    lens: {
      cost: (e) => (/^Invalid marketplace entry was ignored: /.test(e.message) ? 'unknown' : e.costs),
    },
    names: [
      /^mixed-known-and-unknown: said nothing about extraKnownMarketplaces\.karpathy-skills in settings\.json, which doctor reports and first-party still applies the file — the key is dead and reads as live$/,
      /^mixed-known-and-unknown: said nothing about hooks in settings\.json, which doctor reports and first-party still applies the file — the key is dead and reads as live$/,
    ],
  },
  {
    /**
     * **The third unit folded into the first.** Both leave the file applying and both
     * print the same title, so the only place they differ is what the finding says was
     * lost -- and a whole field is gone by construction where an entry's cost was never
     * measured. Folding them reports the second as the first, which is a measurement the
     * evidence line does not have behind it.
     */
    name: 'an entry drop is charged as a whole field',
    lens: { cost: (e) => (e.costs === 'entry' ? 'field' : e.costs) },
    names: [
      /^hook-entry-ignored: hooks\.PreToolUse accounts for its loss as\n.*the whole field is not in effect.*and the recording makes it\n.*this entry is not in effect, and what it cost is not measured/s,
      /^mixed-known-and-unknown: extraKnownMarketplaces\.karpathy-skills accounts for its loss as/,
    ],
  },
  {
    /**
     * **The cost figure, charged to the file.** The number a dropped key is worth is not
     * the number of entries the file happens to hold, and folding the units into one
     * leaves nothing else to count. It is required on the *unmeasured* unit by name
     * (DEA-152): an entry drop prints no figure at all, so the failure this has to catch
     * is not a wrong number but a number, and a gate reading only the counted unit would
     * pass a detector that invented one for the other two.
     */
    name: 'the cost figure counts the whole file',
    lens: { finding: wholeFileCost },
    names: [
      /^dropped-field-and-elements: permissions\.deny claims 2 values removed; the file has 3 there, and 2 entries in the file as a whole$/,
      /^dropped-field-and-elements: hooks is titled\n .*so 2 entries in it never apply/s,
      /^deny-nonstring-elements: permissions\.deny claims 1 values removed; the file has 2 there/,
      /^hook-entry-ignored: hooks\.PreToolUse is titled\n .*so 1 entry in it never applies/s,
    ],
  },
  {
    /**
     * Everything is a dropped field, which is several of the above at once.
     *
     * The second pattern used to require `not-checked`, off the one recording that
     * produced it. DEA-152 taught the classifier that message, so the state is no longer
     * reachable from the recordings and the constructed case in "the two silences" carries
     * it instead. What is required here now is the unit fold, which this mutation also
     * performs and which no recording can lose.
     */
    name: 'every error is read as a dropped field',
    lens: { cost: () => 'field' },
    names: [/which the recording leaves discarded/, /accounts for its loss as/],
  },
  {
    /** And the flattening in the other direction: nothing is ever dropped. */
    name: 'nothing is ever a dropped field',
    lens: { cost: () => 'file' },
    names: [
      /^field-dropped-hooks: said nothing about hooks in settings\.json, which doctor reports and first-party still applies the file — the key is dead and reads as live$/,
      /^dropped-field-and-elements: said nothing about permissions\.deny in settings\.json/,
    ],
  },
];

describe('the gate fails when the detector is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const failures = runGate(mutation.lens);
      assert.ok(
        failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate -- that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      for (const pattern of mutation.names) {
        assert.ok(
          failures.some((f) => pattern.test(f)),
          `the gate failed, but nothing said ${pattern}: ${failureMessage(failures)}`,
        );
      }
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  test('and passes when it is not', () => {
    assert.deepEqual(runGate(CLEAN), []);
  });

  /**
   * The workspace walk is the same one `discardedSettings` uses, so the `~`-dedup comes
   * with it: `~/.claude/settings.json` is also a registered project's file, and a walk
   * that did not deduplicate by path would report one dropped field twice.
   */
  test('and one file serving two scopes is one finding', () => {
    const c = CASES.find((x) => x.name === 'dropped-field-and-elements')!;
    const ws = checked(c, CLEAN);
    const file = ws.projects[0]!.settings!;
    const shared: Workspace = { ...ws, userSettings: file, home: caseDir(c) };

    assert.equal(settingsFiles(shared).length, settingsFiles(ws).length);
    assert.equal(droppedSettingsField(ctxFor(shared)).length, 2);
  });
});
