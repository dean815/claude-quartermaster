/**
 * The settings-validity gate (DEA-147).
 *
 * A settings file that parses as JSON is not a settings file that applies. Claude Code
 * validates it against a schema first, and failing that schema costs it either one key
 * or the whole file. The resolver's precedence model was never wrong -- its notion of
 * which files *count* was, and 108 `enabledPlugins` entries were dead while the grid
 * reported them as decisive.
 *
 * ## What this is anchored on, and what it deliberately is not
 *
 * Not a schema. Hand-rolling Claude Code's settings rules and asserting a fixture
 * against them proves that our copy agrees with itself -- the DEA-133 defect, one level
 * removed -- and the copy starts drifting on the next release. So both halves of every
 * comparison here are first-party output, recorded once against **2.1.221** and
 * committed under `fixtures/doctor/`:
 *
 *   input       `claude doctor`, verbatim, one capture per settings file
 *   expectation `claude plugin list --json`, which reports `enabled` already resolved
 *               for its working directory
 *
 * Every case enables `context7@claude-plugins-official`, which the capturing machine's
 * `~/.claude/settings.json` sets to **false**. So `enabled` is not decoration: it says
 * which of the files Claude Code honoured, and it says it in Claude Code's own voice.
 *
 * ## The two families
 *
 * `checked` runs the real parser over the recorded `doctor` text and resolves with what
 * it produced. Its expectation is the recorded `enabled`, always.
 *
 * `unchecked` resolves the same files with every validity forced to `not-checked` --
 * which is what every file reads on any run without `--full`, because `doctor` validates
 * per working directory and checking N projects is N spawns. This family exists because
 * `not-checked` has a *cost*, and a gate that only asserted the happy direction would
 * hide it: on a file that is in fact discarded, not checking gives the wrong answer, and
 * the honest way to pin that is to assert the divergence rather than paper over it.
 *
 * Which family a case belongs to is decided by whether validity moves its answer at all,
 * computed once from the unmutated classifier -- so a mutation cannot also move the
 * goalposts. `valid-local-over-discarded` is the case that forced this: it holds a
 * discarded file whose removal changes nothing, because a valid `settings.local.json`
 * outranks it either way.
 *
 * ## Negative controls
 *
 * A gate that cannot fail is not a gate. The mutations are applied to the validity each
 * file carries, on its way into the resolver, which is where a wrong rule would live.
 * Two of them matter more than the rest and are named in `MUTATIONS`.
 *
 * Read-only and fixture-only. No `claude`, no `~/.claude.json`, no dependence on the
 * checkout path.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FIELD_IGNORED_NOTE,
  parseInstallationIssues,
  parseInvalidSettings,
  settingsFromDoctor,
  validityOf,
} from '../src/delegate/doctor.ts';
import {
  discardedSettings,
  settingsValidityTally,
  unclassifiedSettings,
} from '../src/detect.ts';
import { resolvePlugin } from '../src/resolve.ts';
import { loadWorkspace, readSettings } from '../src/surfaces/read.ts';
import type {
  ClaudeJson,
  SettingsCheck,
  SettingsError,
  SettingsValidity,
  Workspace,
} from '../src/surfaces/types.ts';
import { project } from './factories.ts';
import {
  CASES,
  FIXTURE_ROOT,
  MANIFEST,
  caseDir,
  covered,
  doctorText,
  localPath,
  settingsPath,
  type RecordedCase,
} from './fixtures/doctor/load.ts';

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const claudeJson = (path: string): ClaudeJson => ({
  path,
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
});

/**
 * Resolve the probed plugin for one case, with each file's validity supplied.
 *
 * The user scope is the recorded one and carries `not-checked` like every other file --
 * whether a `doctor` run inside a project reports on `~/.claude/settings.json` was never
 * established, and establishing it would mean corrupting the live user settings file.
 * A mutation therefore reaches it too, which is faithful: a wrong rule would not stop at
 * the project boundary.
 */
function resolveWith(c: RecordedCase, validityOf_: (path: string) => SettingsValidity): boolean {
  const userPath = join(FIXTURE_ROOT, 'recorded-user-settings.json');
  const as = (path: string) => ({ validity: validityOf_(path), schemaErrors: [] });
  const record = project(caseDir(c), {
    settings: readSettings(settingsPath(c), as(settingsPath(c))),
    localSettings: readSettings(localPath(c), as(localPath(c))),
  });
  const ws: Workspace = {
    home: FIXTURE_ROOT,
    userSettings: {
      path: userPath,
      validity: validityOf_(userPath),
      schemaErrors: [],
      droppedRuleElements: {},
      enabledPlugins: MANIFEST.userScope,
      rest: {},
    },
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(join(FIXTURE_ROOT, 'recorded-claude.json')),
    projects: [record],
  };
  return resolvePlugin(ws, record, MANIFEST.plugin).value;
}

type Mutator = (v: SettingsValidity) => SettingsValidity;

const IDENTITY: Mutator = (v) => v;

/** What the real parser makes of this case, mutated on the way into the resolver. */
function checkedValue(c: RecordedCase, mutate: Mutator): boolean {
  const real = settingsFromDoctor(doctorText(c), covered(c));
  return resolveWith(c, (p) => mutate(real.get(p)?.validity ?? 'not-checked'));
}

/** The same files on a run that never asked -- every default run, in other words. */
function uncheckedValue(c: RecordedCase, mutate: Mutator): boolean {
  return resolveWith(c, () => mutate('not-checked'));
}

/**
 * Whether validity moves this case's answer, from the unmutated classifier.
 *
 * Computed once and outside the mutation, so that a mutation changes what the gate
 * *measures* and never which assertion it applies. Deriving it from the mutated run
 * would let a mutation excuse itself.
 */
const SENSITIVE = new Map(
  CASES.map((c) => [c.name, checkedValue(c, IDENTITY) !== uncheckedValue(c, IDENTITY)] as const),
);

function runGate(mutate: Mutator): string[] {
  const failures: string[] = [];

  for (const c of CASES) {
    const checked = checkedValue(c, mutate);
    if (checked !== c.enabled) {
      failures.push(
        `${c.name}: with doctor consulted, ${MANIFEST.plugin} resolved ${checked}; ` +
          `first-party reports ${c.enabled}`,
      );
    }

    const unchecked = uncheckedValue(c, mutate);
    if (SENSITIVE.get(c.name)) {
      // The case's answer depends on validity, so a run that checked nothing must land
      // somewhere else. Matching first-party here means a file nothing looked at was
      // dropped from the chain anyway -- which is the dangerous direction: it reports
      // overrides that are in effect as void, and it does so on every run.
      if (unchecked === c.enabled) {
        failures.push(
          `${c.name}: nothing was checked, yet it matched the first-party answer ` +
            `${c.enabled} — a settings file no check looked at was dropped from the chain`,
        );
      }
    } else if (unchecked !== c.enabled) {
      failures.push(
        `${c.name}: with nothing checked it resolved ${unchecked}; first-party reports ` +
          `${c.enabled} — an unchecked file stopped contributing to the chain`,
      );
    }
  }

  return failures;
}

const failureMessage = (f: readonly string[]) =>
  `\n  ${f.length} divergence(s):\n  ${f.join('\n  ')}`;

// ---------------------------------------------------------------------------
// The parser, against the verbatim text
// ---------------------------------------------------------------------------

/**
 * What `doctor` said, entry by entry. Literals, read off the committed recording.
 *
 * The point of writing them out rather than counting whatever the parser returns is that
 * a parser which found nothing would make every file `accepted`, and four of the six
 * cases resolve correctly under that. Two of them would not -- so the gate below would
 * still fail -- but it would fail without saying that the block had stopped parsing.
 */
const PARSED: Record<string, Array<{ key: string; costs: SettingsError['costs']; notes: number }>> = {
  accepted: [],
  'discarded-marketplace-source': [
    { key: 'extraKnownMarketplaces.karpathy-skills.source', costs: 'file', notes: 0 },
  ],
  'field-dropped-hooks': [{ key: 'hooks', costs: 'field', notes: 0 }],
  'discarded-many-entries': [
    { key: 'extraKnownMarketplaces.karpathy-skills.source', costs: 'file', notes: 0 },
  ],
  'discarded-permissions-deny': [{ key: 'permissions.deny', costs: 'file', notes: 1 }],
  'dropped-over-discarded': [
    { key: 'hooks', costs: 'field', notes: 0 },
    { key: 'permissions.deny', costs: 'file', notes: 1 },
  ],
  // The two DEA-151 recordings: partial acceptance said without the trailing sentence.
  'deny-nonstring-elements': [{ key: 'permissions.deny', costs: 'elements', notes: 0 }],
  'allow-nonstring-elements': [{ key: 'permissions.allow', costs: 'elements', notes: 0 }],
  // Both partial-acceptance shapes in one file, in the order doctor printed them, and
  // the pair that pins the two apart: same validity, different cost (DEA-149).
  'dropped-field-and-elements': [
    { key: 'permissions.deny', costs: 'elements', notes: 0 },
    { key: 'hooks', costs: 'field', notes: 0 },
  ],
  // A partial acceptance in a phrasing neither family covers, so `unknown` (DEA-151) --
  // recorded from 2.1.224 rather than constructed.
  'hook-entry-ignored': [{ key: 'hooks.PreToolUse', costs: 'unknown', notes: 0 }],
  // One of each, in one file: the lattice takes it to `not-checked` while a recognised
  // `field` error is still sitting in it.
  'mixed-known-and-unknown': [
    { key: 'hooks', costs: 'field', notes: 0 },
    { key: 'extraKnownMarketplaces.karpathy-skills', costs: 'unknown', notes: 0 },
  ],
  'valid-local-over-discarded': [{ key: 'permissions.deny', costs: 'file', notes: 1 }],
};

describe('the Invalid settings block, as claude doctor writes it', () => {
  for (const c of CASES) {
    test(`${c.name}: ${c.note}`, () => {
      const errors = parseInvalidSettings(doctorText(c));
      assert.deepEqual(
        errors.map((e) => ({ key: e.key, costs: e.costs, notes: e.notes.length })),
        PARSED[c.name],
      );

      // Each entry names a real file of this case, so a parser mangling the path -- and
      // so classifying a file nobody has -- shows here rather than as a silent `accepted`.
      for (const e of errors) {
        assert.ok(
          [settingsPath(c), localPath(c)].includes(e.path),
          `parsed a path that is neither of this case's settings files: ${e.path}`,
        );
      }
    });
  }

  /**
   * The facts the four-state model rests on, asserted against the recording rather than
   * described in prose.
   *
   * The second half is DEA-151's whole point: `field-dropped-hooks` says the file
   * survived *with* the trailing sentence and `deny-nonstring-elements` says it survived
   * *without* one, so any rule keyed on that sentence alone is refuted by the recording
   * itself rather than by an argument about it.
   */
  test('the separator is U+203A, and partial acceptance is said in more than one way', () => {
    const withErrors = CASES.filter((c) => PARSED[c.name]!.length > 0);
    assert.ok(withErrors.length >= 4, 'too few recorded failures to say anything');

    for (const c of withErrors) {
      assert.ok(doctorText(c).includes(' › '), `${c.name}: no U+203A in the block`);
    }

    const errorsOf = (name: string) =>
      parseInvalidSettings(doctorText(CASES.find((c) => c.name === name)!));

    const dropped = errorsOf('field-dropped-hooks');
    assert.ok(dropped[0]!.message.endsWith(FIELD_IGNORED_NOTE));
    assert.equal(dropped[0]!.costs, 'field');

    // The file first-party keeps, saying so in words the sentence-matcher never sees.
    // Classified `elements` rather than `field` (DEA-149): same validity, and a different
    // cost, because what came out was some of an array and not the key.
    for (const name of ['deny-nonstring-elements', 'allow-nonstring-elements']) {
      const kept = errorsOf(name);
      assert.ok(
        !kept[0]!.message.includes(FIELD_IGNORED_NOTE),
        `${name}: the recording carries the note after all, so it cannot pin this`,
      );
      assert.equal(
        kept[0]!.costs,
        'elements',
        `${name}: classified as anything but removed elements — first-party reports the ` +
          'file applies, and says an array lost values rather than a key being ignored',
      );
    }

    const voided = errorsOf('discarded-permissions-deny');
    assert.ok(!voided[0]!.message.includes(FIELD_IGNORED_NOTE));
    assert.equal(voided[0]!.costs, 'file');
    // And the note is not hiding in the continuation line either, which is what would
    // make `includes` over the whole entry the right test instead of `endsWith`.
    assert.ok(!voided[0]!.notes.some((n) => n.includes(FIELD_IGNORED_NOTE)));
  });

  /**
   * The state that had no recording, and now has two (DEA-151, DEA-149).
   *
   * When this was written every message form three sessions of probing had found was
   * recognised, so nothing first-party produced `unknown` and the message below was
   * invented on purpose. 2.1.224 produces it twice over -- `hook-entry-ignored` and
   * `mixed-known-and-unknown` are recordings of it -- and this stays constructed anyway,
   * because what it asserts is which way the classifier errs on a phrasing *nobody has
   * seen yet*, and a recording can only ever stand for one that has been.
   */
  test('a message from no known family is not-checked, never discarded', () => {
    const err = (message: string): SettingsError => ({
      path: '/s.json',
      key: 'permissions.deny',
      message,
      notes: [],
      costs: 'unknown',
    });
    const invented = 'Rule 3 was quarantined pending review';
    assert.deepEqual(parseInvalidSettings(`Invalid settings\n- /s.json › k: ${invented}\n`), [
      { path: '/s.json', key: 'k', message: invented, notes: [], costs: 'unknown' },
    ]);

    assert.equal(validityOf([err(invented)]), 'not-checked');
    // Beside a recognised kept field it still cannot say the file survived...
    assert.equal(
      validityOf([{ ...err('x'), costs: 'field' }, err(invented)]),
      'not-checked',
    );
    // ...but a confirmed whole-file failure settles it, because the file is gone whatever
    // else was said about it.
    assert.equal(validityOf([{ ...err('x'), costs: 'file' }, err(invented)]), 'discarded');
  });

  /**
   * `No installation issues found.` prints anyway, and the entries begin with `- `, so
   * the pre-existing parser matches none of them. That is why the block was invisible
   * for as long as it was, and it is a property of Claude Code's output rather than of
   * our code -- so it is pinned against the recording.
   */
  test('and the installation-health parser sees none of it', () => {
    for (const c of CASES) {
      const text = doctorText(c);
      assert.ok(text.includes('No installation issues found.'), `${c.name}: no healthy line`);
      assert.deepEqual(parseInstallationIssues(text), [], `${c.name}: leaked into installation health`);
    }
  });

  test('an empty error list is accepted, and one refusal voids the file', () => {
    assert.equal(validityOf([]), 'accepted');
    const one = (costs: SettingsError['costs']) => ({
      path: '/s.json',
      key: 'k',
      message: 'm',
      notes: [],
      costs,
    });
    assert.equal(validityOf([one('field')]), 'field-dropped');
    // Both partial-acceptance costs mean the same thing to validity and different things
    // to a report (DEA-149), so a third cost added to `costOf` and forgotten in
    // `PARTIAL_ACCEPTANCE` would take a live file to `not-checked`.
    assert.equal(validityOf([one('elements')]), 'field-dropped');
    assert.equal(validityOf([one('field'), one('elements')]), 'field-dropped');
    assert.equal(validityOf([one('file')]), 'discarded');
    // Mixed: one key survived, another did not, and the file goes with the worse of the
    // two. A file is discarded whole or not at all.
    assert.equal(validityOf([one('field'), one('file')]), 'discarded');
  });

  test('a file the run did not cover and did not name is absent, never accepted', () => {
    const c = CASES.find((x) => x.name === 'accepted')!;
    const map = settingsFromDoctor(doctorText(c), covered(c));
    assert.deepEqual(map.get(settingsPath(c)), { validity: 'accepted', schemaErrors: [] });
    assert.equal(map.get('/somewhere/else/.claude/settings.json'), undefined);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('resolution matches first-party once validity is consulted', () => {
  test('every recorded case agrees', () => {
    const failures = runGate(IDENTITY);
    const sensitive = CASES.filter((c) => SENSITIVE.get(c.name)).map((c) => c.name);
    console.log(
      `    validity: ${CASES.length} cases recorded against ${MANIFEST.claudeVersion}, ` +
        `${sensitive.length} of them decided by validity`,
    );
    assert.deepEqual(failures, [], failureMessage(failures));
  });

  /**
   * The comparison is not vacuous, in the three ways it could be.
   *
   * `enabled` is a boolean, so a recording in which every case answered the same way
   * would pass against a resolver deleted outright. And if no case were sensitive to
   * validity, this file would be a slow re-run of `resolve.test.ts`.
   */
  /**
   * Every file the capture wrote is still on disk.
   *
   * Not paranoia -- it already happened once in this repo. A global gitignore excluding
   * `**​/.claude/settings.local.json` is common enough that this fixture was built on a
   * machine with one, and the two cases that pair two files with two validities keep
   * their *discarded* half in the local file. Skipped, both degrade into single-file
   * cases that pass, and the fixture's whole reason for existing leaves with them.
   * `.gitignore` carries the negation; this is what notices when it stops working.
   */
  test('and every file the capture recorded is actually here', () => {
    for (const c of CASES) {
      for (const name of c.files) {
        const path = join(caseDir(c), '.claude', name);
        assert.ok(
          existsSync(path),
          `${c.name}: the manifest records ${name} and it is not on disk -- if git is ` +
            'skipping it, the fixture is silently smaller than it reads',
        );
      }
    }
    const withTwo = CASES.filter((c) => c.files.length === 2);
    assert.ok(withTwo.length >= 2, 'no case pairs two settings files any more');
  });

  test('and the recording can tell a working model from a deleted one', () => {
    const outcomes = new Set(CASES.map((c) => c.enabled));
    assert.deepEqual([...outcomes].sort(), [false, true], 'the recording answers one way only');

    const sensitive = CASES.filter((c) => SENSITIVE.get(c.name));
    assert.ok(sensitive.length >= 2, `only ${sensitive.length} case(s) are decided by validity`);

    // Both file surfaces carry a discarded file somewhere in the set: a model that
    // dropped links at project scope alone, or at local scope alone, would pass on a
    // recording that only exercised the other.
    const discardedPaths = CASES.flatMap((c) =>
      [...settingsFromDoctor(doctorText(c), covered(c))]
        .filter(([, check]) => check.validity === 'discarded')
        .map(([p]) => p),
    );
    assert.ok(discardedPaths.some((p) => p.endsWith('settings.json')), 'no discarded settings.json');
    assert.ok(
      discardedPaths.some((p) => p.endsWith('settings.local.json')),
      'no discarded settings.local.json',
    );

    // And a field-dropped file exists, or the constraint that separates DEA-147 from its
    // own issue title is untested.
    const dropped = CASES.flatMap((c) =>
      [...settingsFromDoctor(doctorText(c), covered(c))].filter(
        ([, check]) => check.validity === 'field-dropped',
      ),
    );
    assert.ok(dropped.length > 0, 'no case exercises field-dropped, which is the whole correction');
  });

  /**
   * The single sharpest case, asserted on its own so it cannot be lost in a loop.
   *
   * One `doctor` run, two settings files, two different validities. `settings.json` is
   * field-dropped and says `true`; `settings.local.json` is discarded and says `false`,
   * and it is the higher-precedence file. First-party answers **true**, which is only
   * reachable by honouring the first and dropping the second -- voiding `settings.json`
   * gives false, and honouring the local file gives false.
   */
  test('a field-dropped file outlives a discarded one above it', () => {
    const c = CASES.find((x) => x.name === 'dropped-over-discarded')!;
    const real = settingsFromDoctor(doctorText(c), covered(c));
    assert.equal(real.get(settingsPath(c))?.validity, 'field-dropped');
    assert.equal(real.get(localPath(c))?.validity, 'discarded');

    assert.equal(c.enabled, true, 'the recording no longer pins this case');
    assert.equal(checkedValue(c, IDENTITY), true);
    // Without the check, the discarded local file wins and the answer inverts.
    assert.equal(uncheckedValue(c, IDENTITY), false);
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

interface Mutation {
  name: string;
  mutate: Mutator;
  /**
   * What the divergences must say -- **every** entry has to be matched by some failure,
   * so a gate failing for another reason shows, and so a mutation that used to be caught
   * two ways cannot quietly degrade to one.
   */
  names: RegExp[];
}

const MUTATIONS: Mutation[] = [
  {
    /**
     * **The one that matters.** `not-checked` collapsed into `discarded`.
     *
     * It is the state nearly every file is in -- validity costs one spawn per project
     * and sits behind `--full` -- so this rule drops almost every settings file on the
     * machine out of the model, reports live overrides as void, and looks like caution
     * while doing it. DEA-123 rejected the same move on the effect axis for the same
     * reason: defaulting to the scarier verdict where nothing was measured is the
     * cry-wolf behaviour, arriving here from the opposite side.
     *
     * It has to be caught both ways round, which is why two patterns are required. On a
     * file that really is fine, dropping it changes the answer and the gate says so. On
     * a file that really is discarded, dropping it lands on the *right* answer for the
     * wrong reason -- and that is the one worth naming, because a rule that guesses its
     * way to a correct-looking grid is the hardest kind to notice.
     */
    name: 'a file nothing checked is treated as discarded',
    mutate: (v) => (v === 'not-checked' ? 'discarded' : v),
    names: [
      /^(accepted|field-dropped-hooks|valid-local-over-discarded): with nothing checked it resolved false; first-party reports true — an unchecked file stopped contributing to the chain$/,
      /^(discarded-marketplace-source|discarded-permissions-deny): nothing was checked, yet it matched the first-party answer false — a settings file no check looked at was dropped from the chain$/,
    ],
  },
  {
    /**
     * The issue's own title, taken literally: any schema error voids the file. It is
     * what the incident looked like from the outside, and it is wrong for `hooks: 42` --
     * measured, that file's `enabledPlugins` applies.
     */
    name: 'a field-dropped file is treated as discarded',
    mutate: (v) => (v === 'field-dropped' ? 'discarded' : v),
    names: [/^(field-dropped-hooks|dropped-over-discarded): with doctor consulted, .* resolved false; first-party reports true$/],
  },
  {
    /**
     * The original incident, reintroduced: a discarded file still counts. This is the
     * state of the resolver before DEA-147 -- parse it, believe it -- and it is what
     * reported 108 dead `enabledPlugins` entries as decisive.
     */
    name: 'a discarded file is treated as accepted',
    mutate: (v) => (v === 'discarded' ? 'accepted' : v),
    names: [/^(discarded-marketplace-source|discarded-permissions-deny|dropped-over-discarded): with doctor consulted/],
  },
  {
    /**
     * The lazy collapse: three states flattened to "valid or not". It reads as a
     * simplification and it is both previous mutations at once.
     */
    name: 'anything not accepted is discarded',
    mutate: (v) => (v === 'accepted' ? v : 'discarded'),
    names: [/with doctor consulted/, /nothing was checked/],
  },
  {
    /** And the other flattening: nothing is ever dropped, which is the state before this. */
    name: 'nothing is ever discarded',
    mutate: () => 'accepted',
    names: [/^(discarded-marketplace-source|discarded-permissions-deny): with doctor consulted, .* resolved true; first-party reports false$/],
  },
];

// ---------------------------------------------------------------------------
// The classifier, one layer below the validity mutations (DEA-151)
// ---------------------------------------------------------------------------

/**
 * The mutations above move a `SettingsValidity` on its way into the resolver, which is
 * the right place for a wrong *precedence* rule and the wrong place for a wrong *reading
 * of doctor's prose*. This gate substitutes the message-to-cost rule instead, which is
 * where DEA-151 lived: the file was classified from a sentence it does not contain.
 *
 * The anchor is the recorded `enabled`, as everywhere else here -- not the unmutated
 * classifier's own answer, which would be a gate agreeing with itself.
 */
/** `null` leaves the real classifier's answer in place. */
type CostRule = ((message: string) => SettingsError['costs']) | null;

function classifierGate(rule: CostRule): string[] {
  const failures: string[] = [];

  for (const c of CASES) {
    const reclassified = new Map<string, SettingsCheck>();
    for (const [path, check] of settingsFromDoctor(doctorText(c), covered(c))) {
      const errors = check.schemaErrors.map((e) => ({ ...e, ...(rule ? { costs: rule(e.message) } : {}) }));
      reclassified.set(path, { validity: validityOf(errors), schemaErrors: errors });
    }

    const value = resolveWith(c, (p) => reclassified.get(p)?.validity ?? 'not-checked');
    if (value === c.enabled) continue;

    for (const [path, check] of reclassified) {
      if (!check.schemaErrors.length) continue;
      failures.push(
        `${c.name}: doctor said "${check.schemaErrors[0]!.message}" about ` +
          `${path.split('/').at(-1)}, this called the file ${check.validity}, and ` +
          `first-party applies it — a file Claude Code keeps was dropped from the chain`,
      );
    }
  }

  return failures;
}

describe('the classifier reads doctor by message family, not by one sentence', () => {
  test('every recorded case still resolves to the first-party answer', () => {
    assert.deepEqual(classifierGate(null), []);
  });

  /**
   * **DEA-151, reintroduced.** The rule as DEA-147 shipped it: partial acceptance is the
   * trailing sentence and nothing else, so every other message voids the file.
   *
   * It has to go red naming *this* divergence -- a file first-party applies, classified
   * `discarded` -- and not merely a changed count, because the count moves for a dozen
   * reasons and only one of them is this one.
   */
  test('the trailing sentence alone is not the discriminator', () => {
    const failures = classifierGate((m) => (m.endsWith(FIELD_IGNORED_NOTE) ? 'field' : 'file'));
    assert.ok(
      failures.length > 0,
      'reverting to the one-sentence rule did not fail the gate -- that is a hole in the ' +
        'gate, not a mutation to delete',
    );
    for (const name of ['deny-nonstring-elements', 'allow-nonstring-elements']) {
      assert.ok(
        failures.some((f) =>
          new RegExp(
            `^${name}: doctor said "Non-string value in \\w+ array was removed" about ` +
              'settings\\.json, this called the file discarded, and first-party applies it ' +
              '— a file Claude Code keeps was dropped from the chain$',
          ).test(f),
        ),
        `the gate failed, but nothing named ${name}: ${failureMessage(failures)}`,
      );
    }
    console.log(`    caught "the one-sentence rule" (${failures.length}): ${failures[0]}`);
  });

  /**
   * And the other direction: the unrecognised message rounded back to `discarded`, which
   * is the default DEA-151 inverted. No recording produces it -- every message form found
   * is recognised -- so the mutation is applied to the recognised ones instead, which is
   * the same collapse reaching the same verdict.
   */
  test('and an unrecognised message may not be rounded to discarded', () => {
    const failures = classifierGate((m) => (m === '' ? 'field' : 'file'));
    assert.ok(failures.length > 0, 'collapsing everything to a refusal did not fail the gate');
    assert.ok(
      failures.some((f) => /field-dropped-hooks: .*called the file discarded/.test(f)),
      failureMessage(failures),
    );
  });
});

describe('the gate fails when the validity rule is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const failures = runGate(mutation.mutate);
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
    assert.deepEqual(runGate(IDENTITY), []);
  });
});

// ---------------------------------------------------------------------------
// The plumbing: validity has to reach the file it is about
// ---------------------------------------------------------------------------

/**
 * `loadWorkspace` with no `~/.claude.json` behind it: the case directory is named
 * outright, which is the "brand-new project" route and needs no registry entry.
 */
function load(dir: string, settingsValidity?: (d: string) => ReadonlyMap<string, SettingsCheck>) {
  return loadWorkspace({
    home: FIXTURE_ROOT,
    claudeJsonPath: join(FIXTURE_ROOT, 'no-such-claude.json'),
    userSettingsPath: join(FIXTURE_ROOT, 'no-such-user-settings.json'),
    extraProjectPaths: [dir],
    ...(settingsValidity ? { settingsValidity } : {}),
  });
}

describe('loadWorkspace carries validity onto the file it belongs to', () => {
  const c = CASES.find((x) => x.name === 'dropped-over-discarded')!;

  test('with nothing to ask, every file reads not-checked', () => {
    const ws = load(caseDir(c));
    assert.equal(ws.projects[0]!.settings!.validity, 'not-checked');
    assert.equal(ws.projects[0]!.localSettings!.validity, 'not-checked');
  });

  test('and with something to ask, each file gets its own answer', () => {
    const ws = load(caseDir(c), (dir) =>
      settingsFromDoctor(doctorText(c), [
        join(dir, '.claude', 'settings.json'),
        join(dir, '.claude', 'settings.local.json'),
      ]),
    );
    assert.equal(ws.projects[0]!.settings!.validity, 'field-dropped');
    assert.equal(ws.projects[0]!.localSettings!.validity, 'discarded');

    // And the key travels with the verdict (DEA-148). A file that arrives classified but
    // with nothing to show for it can be reported and not explained, which sends the
    // reader back to the command whose output produced the classification.
    assert.deepEqual(
      ws.projects[0]!.settings!.schemaErrors.map((e) => e.key),
      ['hooks'],
    );
    assert.deepEqual(
      ws.projects[0]!.localSettings!.schemaErrors.map((e) => e.key),
      ['permissions.deny'],
    );
  });

  /**
   * The unrecognised message is visible, or the choice to lose a detection is unaccountable.
   *
   * `costOf` errs towards `not-checked` because fabricating `discarded` on a live file is
   * the worse mistake -- but that trade is only defensible while someone can see it being
   * made. `not-checked` **carrying schema errors** is the state nothing else produces, and
   * it is what separates "we did not look" from "we looked and it meant nothing to us".
   *
   * Driven end to end from a constructed `doctor` block rather than from a hand-built
   * `SettingsCheck`, so the parser, the classifier and the walk are all in the path. The
   * message is invented, which it no longer has to be -- 2.1.224 emits two this release
   * does not recognise, and `test/dropped-field.test.ts` runs this same separation off one
   * of the recordings. Kept invented here for that test's reason: this one is about the
   * phrasing nobody has seen.
   */
  test('a file doctor reported in unknown words is separable from one nobody checked', () => {
    const valid = CASES.find((x) => x.name === 'accepted')!;
    const path = settingsPath(valid);
    const invented = 'Rule 3 was quarantined pending review';

    const ws = loadWorkspace({
      home: FIXTURE_ROOT,
      claudeJsonPath: join(FIXTURE_ROOT, 'no-such-claude.json'),
      userSettingsPath: join(FIXTURE_ROOT, 'no-such-user-settings.json'),
      extraProjectPaths: [caseDir(valid)],
      settingsValidity: () =>
        settingsFromDoctor(`Invalid settings\n- ${path} › permissions.deny: ${invented}\n`, [path]),
    });

    assert.equal(ws.projects[0]!.settings!.validity, 'not-checked');
    assert.equal(settingsValidityTally(ws)['not-checked'], 1);
    assert.deepEqual(discardedSettings({ ws, measurements: [], pluginCosts: new Map(), inventories: new Map() }), []);

    const unclassified = unclassifiedSettings(ws);
    assert.equal(unclassified.length, 1, 'the run cannot say a new first-party message arrived');
    assert.equal(unclassified[0]!.path, path);
    assert.deepEqual(
      unclassified[0]!.schemaErrors.map((e) => e.message),
      [invented],
    );

    // And a file nothing was asked about is *not* in that list, or the signal means
    // nothing: on a run without --full every file is not-checked and this would name
    // all of them.
    const blind = loadWorkspace({
      home: FIXTURE_ROOT,
      claudeJsonPath: join(FIXTURE_ROOT, 'no-such-claude.json'),
      userSettingsPath: join(FIXTURE_ROOT, 'no-such-user-settings.json'),
      extraProjectPaths: [caseDir(valid)],
    });
    assert.equal(blind.projects[0]!.settings!.validity, 'not-checked');
    assert.deepEqual(unclassifiedSettings(blind), []);
  });

  /**
   * A checker that answers about only one of the two files must leave the other at
   * `not-checked`. Filling it in would be the whole defect in miniature.
   */
  test('and a file it does not answer about stays not-checked', () => {
    const ws = load(
      caseDir(c),
      (dir) =>
        new Map<string, SettingsCheck>([
          [join(dir, '.claude', 'settings.json'), { validity: 'discarded', schemaErrors: [] }],
        ]),
    );
    assert.equal(ws.projects[0]!.settings!.validity, 'discarded');
    assert.equal(ws.projects[0]!.localSettings!.validity, 'not-checked');
    assert.deepEqual(ws.projects[0]!.localSettings!.schemaErrors, []);
  });

  /**
   * The user-scope file is classified only when a project run happens to name it --
   * one `doctor` invocation reports every settings file in scope, and that is the sole
   * route by which `~/.claude/settings.json` is ever more than `not-checked` here.
   */
  test('and a path the run names outside the project still lands', () => {
    const userPath = settingsPath(CASES.find((x) => x.name === 'accepted')!);
    const ws = loadWorkspace({
      home: FIXTURE_ROOT,
      claudeJsonPath: join(FIXTURE_ROOT, 'no-such-claude.json'),
      userSettingsPath: userPath,
      extraProjectPaths: [caseDir(c)],
      settingsValidity: () =>
        new Map<string, SettingsCheck>([[userPath, { validity: 'discarded', schemaErrors: [] }]]),
    });
    assert.equal(ws.userSettings!.validity, 'discarded');
    // And the project's own files, which that run said nothing about, are unaffected.
    assert.equal(ws.projects[0]!.settings!.validity, 'not-checked');
  });
});
