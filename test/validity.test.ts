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
import { resolvePlugin } from '../src/resolve.ts';
import { loadWorkspace, readSettings } from '../src/surfaces/read.ts';
import type { ClaudeJson, SettingsValidity, Workspace } from '../src/surfaces/types.ts';
import { project } from './factories.ts';

// ---------------------------------------------------------------------------
// The recording
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'doctor');

interface RecordedCase {
  name: string;
  note: string;
  /** `claude plugin list --json`, run in the probe directory holding exactly these files. */
  enabled: boolean;
  files: string[];
}

interface Manifest {
  capturedAt: string;
  claudeVersion: string;
  plugin: string;
  /** `~/.claude/settings.json` as it stood at capture time, for the probed plugin only. */
  userScope: Record<string, boolean>;
  /** The cwd `doctor` printed paths against. Rebased onto each case's own directory. */
  recordedProjectDir: string;
  cases: RecordedCase[];
}

const MANIFEST: Manifest = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
const CASES = MANIFEST.cases;

const caseDir = (c: RecordedCase) => join(FIXTURE_ROOT, c.name);
const settingsPath = (c: RecordedCase) => join(caseDir(c), '.claude', 'settings.json');
const localPath = (c: RecordedCase) => join(caseDir(c), '.claude', 'settings.local.json');

/**
 * The recorded `doctor` output, with the capture machine's probe path rebased onto this
 * case's own directory.
 *
 * The committed file is byte-verbatim; this is one substitution of one string the
 * manifest records, and it is the only thing standing between a recording made in a
 * scratch directory and a fixture that runs from any checkout. The messages themselves
 * are untouched, which is the half that matters -- the `›`, the trailing note, the
 * indented continuation.
 */
function doctorText(c: RecordedCase): string {
  const raw = readFileSync(join(caseDir(c), 'doctor.txt'), 'utf8');
  return raw.replaceAll(MANIFEST.recordedProjectDir, caseDir(c));
}

/** The files a run in this case's directory speaks for -- both, whether or not they exist. */
const covered = (c: RecordedCase) => [settingsPath(c), localPath(c)];

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
  const record = project(caseDir(c), {
    settings: readSettings(settingsPath(c), validityOf_(settingsPath(c))),
    localSettings: readSettings(localPath(c), validityOf_(localPath(c))),
  });
  const ws: Workspace = {
    home: FIXTURE_ROOT,
    userSettings: {
      path: userPath,
      validity: validityOf_(userPath),
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
  return resolveWith(c, (p) => mutate(real.get(p) ?? 'not-checked'));
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
const PARSED: Record<string, Array<{ key: string; fieldIgnored: boolean; notes: number }>> = {
  accepted: [],
  'discarded-marketplace-source': [
    { key: 'extraKnownMarketplaces.karpathy-skills.source', fieldIgnored: false, notes: 0 },
  ],
  'field-dropped-hooks': [{ key: 'hooks', fieldIgnored: true, notes: 0 }],
  'discarded-permissions-deny': [{ key: 'permissions.deny', fieldIgnored: false, notes: 1 }],
  'dropped-over-discarded': [
    { key: 'hooks', fieldIgnored: true, notes: 0 },
    { key: 'permissions.deny', fieldIgnored: false, notes: 1 },
  ],
  'valid-local-over-discarded': [{ key: 'permissions.deny', fieldIgnored: false, notes: 1 }],
};

describe('the Invalid settings block, as claude doctor writes it', () => {
  for (const c of CASES) {
    test(`${c.name}: ${c.note}`, () => {
      const errors = parseInvalidSettings(doctorText(c));
      assert.deepEqual(
        errors.map((e) => ({ key: e.key, fieldIgnored: e.fieldIgnored, notes: e.notes.length })),
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
   * The two facts the whole four-state model rests on, asserted against the recording
   * rather than described in prose.
   */
  test('the separator is U+203A and the discriminator is a trailing sentence', () => {
    const withErrors = CASES.filter((c) => PARSED[c.name]!.length > 0);
    assert.ok(withErrors.length >= 4, 'too few recorded failures to say anything');

    for (const c of withErrors) {
      assert.ok(doctorText(c).includes(' › '), `${c.name}: no U+203A in the block`);
    }

    const dropped = parseInvalidSettings(doctorText(CASES.find((c) => c.name === 'field-dropped-hooks')!));
    assert.ok(dropped[0]!.message.endsWith(FIELD_IGNORED_NOTE));
    const voided = parseInvalidSettings(doctorText(CASES.find((c) => c.name === 'discarded-permissions-deny')!));
    assert.ok(!voided[0]!.message.includes(FIELD_IGNORED_NOTE));
    // And the note is not hiding in the continuation line either, which is what would
    // make `includes` over the whole entry the right test instead of `endsWith`.
    assert.ok(!voided[0]!.notes.some((n) => n.includes(FIELD_IGNORED_NOTE)));
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

  test('an empty error list is accepted, and one note-less error voids the file', () => {
    assert.equal(validityOf([]), 'accepted');
    const one = (fieldIgnored: boolean) => ({
      path: '/s.json',
      key: 'k',
      message: 'm',
      notes: [],
      fieldIgnored,
    });
    assert.equal(validityOf([one(true)]), 'field-dropped');
    assert.equal(validityOf([one(false)]), 'discarded');
    // Mixed: one key survived being ignored, another did not, and the file goes with the
    // worse of the two. A file is discarded whole or not at all.
    assert.equal(validityOf([one(true), one(false)]), 'discarded');
  });

  test('a file the run did not cover and did not name is absent, never accepted', () => {
    const c = CASES.find((x) => x.name === 'accepted')!;
    const map = settingsFromDoctor(doctorText(c), covered(c));
    assert.equal(map.get(settingsPath(c)), 'accepted');
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
        .filter(([, v]) => v === 'discarded')
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
      [...settingsFromDoctor(doctorText(c), covered(c))].filter(([, v]) => v === 'field-dropped'),
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
    assert.equal(real.get(settingsPath(c)), 'field-dropped');
    assert.equal(real.get(localPath(c)), 'discarded');

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
function load(dir: string, settingsValidity?: (d: string) => ReadonlyMap<string, SettingsValidity>) {
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
  });

  /**
   * A checker that answers about only one of the two files must leave the other at
   * `not-checked`. Filling it in would be the whole defect in miniature.
   */
  test('and a file it does not answer about stays not-checked', () => {
    const ws = load(caseDir(c), (dir) => new Map([[join(dir, '.claude', 'settings.json'), 'discarded']]));
    assert.equal(ws.projects[0]!.settings!.validity, 'discarded');
    assert.equal(ws.projects[0]!.localSettings!.validity, 'not-checked');
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
      settingsValidity: () => new Map([[userPath, 'discarded']]),
    });
    assert.equal(ws.userSettings!.validity, 'discarded');
    // And the project's own files, which that run said nothing about, are unaffected.
    assert.equal(ws.projects[0]!.settings!.validity, 'not-checked');
  });
});
