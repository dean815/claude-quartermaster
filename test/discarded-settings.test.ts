/**
 * The discarded-settings detector (DEA-148).
 *
 * A settings file Claude Code refuses is 108 dead `enabledPlugins` entries that read as
 * decisive in every view of them. `qm audit` said nothing about that until this existed,
 * and the differential gate caught 21 of the 108 by accident -- the other 87 happened to
 * agree with user scope, so comparing values could not see them.
 *
 * ## What both halves of every case are
 *
 * The same recording `validity.test.ts` runs on, loaded through the same `load.ts`:
 * `claude doctor`, verbatim, against the settings files that produced it. Nothing here
 * restates Claude Code's schema, and nothing here re-derives which files it discarded --
 * `EXPECTED` is read off the committed recording as literals, so a broken classifier
 * moves the detector's answer without moving the expectation. Reading both sides through
 * `settingsFromDoctor` would be the DEA-133 defect: a gate that agrees with itself.
 *
 * ## The three failures it is built to catch
 *
 * 1. **`not-checked` reported as anything else.** Validity costs one `doctor` spawn per
 *    project and lives behind `--full`, so on a default run *every* file is unchecked and
 *    this detector emits nothing. That silence is only honest while the run says it did
 *    not look, which is what `settingsValidityTally` is for. A rule that read an unchecked
 *    file as accepted would print "0 discarded" about a workspace nobody examined.
 * 2. **`field-dropped` reported as discarded.** Such a file is live config; only the one
 *    key fell out. Reporting it claims working overrides are void, and claims a cost
 *    figure covering the whole file when at most the dropped key is affected. That is the
 *    boundary between this issue and its follow-up, so the mutation naming it matters
 *    more than the rest.
 * 3. **The cost figure.** `discarded-many-entries` spends its six entries across four
 *    keys precisely so a counter that reads one of them cannot pass.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  discardedSettings,
  settingsFiles,
  settingsValidityTally,
  type AuditContext,
  type Finding,
} from '../src/detect.ts';
import { NOT_CHECKED, loadWorkspace, readSettings } from '../src/surfaces/read.ts';
import type { SettingsCheck, Workspace } from '../src/surfaces/types.ts';
import { project } from './factories.ts';
import {
  CASES,
  FIXTURE_ROOT,
  caseDir,
  checksFor,
  covered,
  settingsPath,
  type RecordedCase,
} from './fixtures/doctor/load.ts';

// ---------------------------------------------------------------------------
// What the recording says, as literals
// ---------------------------------------------------------------------------

interface ExpectedFinding {
  /** Which of the case's two settings files. */
  file: 'settings.json' | 'settings.local.json';
  /** The key path `doctor` printed, verbatim. The finding has to pass it through. */
  keys: string[];
  /**
   * Entries the file decides, per key, counted off the committed JSON.
   *
   * Literals rather than a walk of the same file: the walk is the thing under test, and
   * a count derived from it agrees with whatever it does.
   */
  byKey: Record<string, number>;
}

const EXPECTED: Record<string, ExpectedFinding[]> = {
  // Nothing is wrong with this file, so nothing is said about it.
  accepted: [],
  // The incident's own key. One plugin entry dies with the file.
  'discarded-marketplace-source': [
    {
      file: 'settings.json',
      keys: ['extraKnownMarketplaces.karpathy-skills.source'],
      byKey: { enabledPlugins: 1 },
    },
  ],
  // Live config. `hooks` fell out and `enabledPlugins` applies -- measured, not assumed.
  'field-dropped-hooks': [],
  // Also live config, and the pair that used to be reported here (DEA-151). `doctor`
  // reports both files and neither carries `This field was ignored.`, so the rule keyed
  // on that sentence called them discarded and this detector fired high severity about
  // entries that apply. First-party says `enabled: true` for both.
  'deny-nonstring-elements': [],
  'allow-nonstring-elements': [],
  'discarded-permissions-deny': [
    { file: 'settings.json', keys: ['permissions.deny'], byKey: { enabledPlugins: 1 } },
  ],
  // Two files, two validities, one run: the local file is discarded and the project file
  // is field-dropped. Exactly one finding, and it is about the local file.
  'dropped-over-discarded': [
    { file: 'settings.local.json', keys: ['permissions.deny'], byKey: { enabledPlugins: 1 } },
  ],
  // Six entries over four keys. The case that makes the cost figure falsifiable.
  'discarded-many-entries': [
    {
      file: 'settings.json',
      keys: ['extraKnownMarketplaces.karpathy-skills.source'],
      byKey: {
        enabledPlugins: 2,
        skillOverrides: 1,
        enabledMcpjsonServers: 2,
        disabledMcpjsonServers: 1,
      },
    },
  ],
  // A discarded file whose removal changes no resolved value still costs its entries, and
  // the user still wrote a file Claude Code is throwing away.
  'valid-local-over-discarded': [
    { file: 'settings.json', keys: ['permissions.deny'], byKey: { enabledPlugins: 1 } },
  ],
};

const total = (e: ExpectedFinding) => Object.values(e.byKey).reduce((a, b) => a + b, 0);
const pathOf = (c: RecordedCase, e: ExpectedFinding) => join(caseDir(c), '.claude', e.file);

// ---------------------------------------------------------------------------
// Running the detector over one case
// ---------------------------------------------------------------------------

type Mutator = (check: SettingsCheck) => SettingsCheck;
const IDENTITY: Mutator = (c) => c;

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

/** The case as `--full` sees it: the real parser's answer, mutated on the way in. */
function checked(c: RecordedCase, mutate: Mutator): Workspace {
  return load(c, new Map([...checksFor(c)].map(([p, check]) => [p, mutate(check)])));
}

/** The case as every run without `--full` sees it: nothing was asked, so nothing is known. */
function unchecked(c: RecordedCase, mutate: Mutator): Workspace {
  return load(c, new Map(covered(c).map((p) => [p, mutate(NOT_CHECKED)])));
}

/** The claimed cost, read back out of the finding the way a reader would. */
function claimedEntries(f: Finding): number | null {
  const m = /(\d+) (?:entry|entries)/.exec(f.title);
  return m ? Number(m[1]) : null;
}

function runGate(mutate: Mutator): string[] {
  const failures: string[] = [];

  for (const c of CASES) {
    const expected = EXPECTED[c.name] ?? [];
    const found = discardedSettings(ctxFor(checked(c, mutate)));
    const recorded = checksFor(c);

    for (const f of found) {
      const path = f.evidence[0] ?? '(no path in evidence)';
      const want = expected.find((e) => pathOf(c, e) === path);
      if (!want) {
        failures.push(
          `${c.name}: reported ${path}, which the recording leaves ` +
            `${recorded.get(path)?.validity ?? 'unnamed by doctor'}, claiming ` +
            `${claimedEntries(f) ?? 'an unreadable number of'} of its entries never apply — ` +
            'the rest of that file is live config',
        );
        continue;
      }

      if (f.severity !== 'high') {
        failures.push(`${c.name}: ${want.file} reported at severity ${f.severity}, not high`);
      }
      const claimed = claimedEntries(f);
      if (claimed !== total(want)) {
        failures.push(
          `${c.name}: ${want.file} claims ${claimed} of its entries never apply; the file ` +
            `decides ${total(want)}`,
        );
      }
      for (const key of want.keys) {
        if (!f.evidence.some((e) => e.startsWith(`${key}: `))) {
          failures.push(
            `${c.name}: ${want.file} is reported without the key doctor named (${key}) — ` +
              'nothing in the finding says what to go and fix',
          );
        }
      }
      for (const [key, n] of Object.entries(want.byKey)) {
        if (!f.evidence.some((e) => e.startsWith(`${key}: ${n} `))) {
          failures.push(`${c.name}: ${want.file} does not account for ${n} ${key} entries`);
        }
      }
    }

    for (const e of expected) {
      if (!found.some((f) => f.evidence[0] === pathOf(c, e))) {
        failures.push(
          `${c.name}: said nothing about ${e.file}, which doctor discards whole — ` +
            `${total(e)} entries in it are dead and the report calls the project clean`,
        );
      }
    }

    // The default run. Nothing was asked, so nothing may be claimed -- and the run has to
    // say it did not ask, or the silence reads as a clean bill.
    const blind = unchecked(c, mutate);
    const silent = discardedSettings(ctxFor(blind));
    if (silent.length) {
      failures.push(
        `${c.name}: with nothing checked, reported ${silent.length} file(s) — a file no ` +
          'check looked at was called discarded',
      );
    }
    const tally = settingsValidityTally(blind);
    const files = settingsFiles(blind).length;
    if (tally['not-checked'] !== files) {
      failures.push(
        `${c.name}: with nothing checked, the run reports ${tally['not-checked']} of ` +
          `${files} settings file(s) as unchecked (accepted ${tally.accepted}, ` +
          `field-dropped ${tally['field-dropped']}, discarded ${tally.discarded}) — ` +
          'a file nobody validated is being reported as one that was',
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

describe('the detector reports the files claude doctor discards, and only those', () => {
  test('every recorded case agrees', () => {
    const failures = runGate(IDENTITY);
    const reported = CASES.reduce((n, c) => n + (EXPECTED[c.name] ?? []).length, 0);
    console.log(
      `    discarded-settings: ${CASES.length} recorded cases, ${reported} findings expected, ` +
        `${CASES.filter((c) => !(EXPECTED[c.name] ?? []).length).length} silent`,
    );
    assert.deepEqual(failures, [], failureMessage(failures));
  });

  /**
   * The recording can tell a working detector from a broken one, in the four ways it
   * could quietly fail to.
   */
  test('and the recording is not vacuous', () => {
    const expectations = CASES.flatMap((c) => EXPECTED[c.name] ?? []);
    assert.ok(expectations.length >= 4, 'too few findings expected to say anything');
    assert.ok(
      CASES.some((c) => !(EXPECTED[c.name] ?? []).length),
      'every case expects a finding, so a detector that always fires would pass',
    );

    // Both file surfaces: a detector walking only project settings, or only the local
    // override, would pass on a set exercising one of them.
    assert.ok(expectations.some((e) => e.file === 'settings.json'), 'no discarded settings.json');
    assert.ok(
      expectations.some((e) => e.file === 'settings.local.json'),
      'no discarded settings.local.json',
    );

    // And the cost figure is falsifiable: one case spends its entries over more than two
    // keys, and the totals are not all the same number.
    assert.ok(
      expectations.some((e) => Object.keys(e.byKey).length >= 3),
      'no case spreads its entries over three keys, so a counter reading one would pass',
    );
    assert.ok(
      new Set(expectations.map(total)).size >= 2,
      'every expected finding costs the same, so a constant would pass',
    );
  });

  /**
   * The single sharpest case, asserted on its own so it cannot be lost in a loop.
   *
   * One `doctor` run, two files, two validities. The local file is discarded and the
   * project file is field-dropped -- live config with one key missing. Exactly one
   * finding, about the local file, and nothing at all about the other.
   */
  test('a field-dropped file beside a discarded one produces one finding, not two', () => {
    const c = CASES.find((x) => x.name === 'dropped-over-discarded')!;
    const ws = checked(c, IDENTITY);
    assert.equal(ws.projects[0]!.settings!.validity, 'field-dropped');
    assert.equal(ws.projects[0]!.localSettings!.validity, 'discarded');

    const found = discardedSettings(ctxFor(ws));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.evidence[0], ws.projects[0]!.localSettings!.path);
    assert.equal(found[0]!.project, caseDir(c));
  });

  /**
   * `doctor`'s own words reach the reader, including the continuation line it writes for
   * some keys. The fix points back at the command that found it -- the
   * `orphanedProjectConfig`/`claude project purge` arrangement -- because repair advice
   * for a schema this repo does not own is a second opinion waiting to drift.
   */
  test('and the finding quotes doctor rather than paraphrasing it', () => {
    const c = CASES.find((x) => x.name === 'discarded-permissions-deny')!;
    const found = discardedSettings(ctxFor(checked(c, IDENTITY)));
    assert.equal(found.length, 1);

    const evidence = found[0]!.evidence.join('\n');
    assert.match(evidence, /permissions\.deny: Expected array, but received string/);
    assert.match(evidence, /Suggested fix: Permission rules must be in an array\./);
    assert.match(found[0]!.fix ?? '', /claude doctor/);
  });

  /**
   * `~` is a registered project whose `.claude/settings.json` *is* the user-scope file,
   * and CLAUDE.md records it breaking two different layers already. Counted twice, one
   * voided file is two findings and twice its entries.
   */
  test('and one file serving two scopes is one finding', () => {
    const c = CASES.find((x) => x.name === 'discarded-many-entries')!;
    const path = settingsPath(c);
    const file = readSettings(path, checksFor(c).get(path) ?? NOT_CHECKED)!;
    const ws: Workspace = {
      home: caseDir(c),
      userSettings: file,
      userRules: [],
      personalSkills: [],
      claudeJson: {
        path: '/nope.json',
        mcpServers: {},
        projects: {},
        claudeAiMcpEverConnected: [],
        skillUsage: {},
        pluginUsage: {},
      },
      // The home directory, as a project, holding the very same file.
      projects: [project(caseDir(c), { settings: file })],
    };

    const found = discardedSettings(ctxFor(ws));
    assert.equal(found.length, 1, 'the shared file was reported once per scope');
    assert.equal(claimedEntries(found[0]!), 6);
    assert.equal(found[0]!.project, undefined, 'the shared file belongs to user scope');
    assert.equal(settingsValidityTally(ws).discarded, 1);
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

interface Mutation {
  name: string;
  mutate: Mutator;
  /** Every pattern has to be matched by some failure, so a gate failing elsewhere shows. */
  names: RegExp[];
}

const as = (validity: SettingsCheck['validity']): Mutator => (c) => ({ ...c, validity });

const MUTATIONS: Mutation[] = [
  {
    /**
     * **The loud one.** A file nothing checked, reported as one that passed.
     *
     * It is the state every settings file on the machine is in on a default run, so the
     * rule that reads it as `accepted` turns a workspace nobody examined into a clean
     * one -- and does it silently, on the command people actually run. This is the
     * `usageCount` rule and `SkillPresence` and `keyBasis`, arriving on a fourth axis:
     * an absent measurement is not a zero.
     */
    name: 'a file nothing checked is reported as accepted',
    mutate: (c) => (c.validity === 'not-checked' ? { ...c, validity: 'accepted' } : c),
    names: [
      /^\w[\w-]*: with nothing checked, the run reports 0 of \d+ settings file\(s\) as unchecked .*a file nobody validated is being reported as one that was$/,
    ],
  },
  {
    /**
     * **The boundary with the follow-up issue.** A `field-dropped` file is live config
     * with one key missing; reporting it as discarded calls the whole file void and
     * charges it the whole file's entries. Both halves show in the message, because the
     * cost figure is the half that makes the claim look measured.
     *
     * The second pattern is DEA-151's half of the same boundary, and it is separate
     * rather than folded into the first alternation on purpose: `some()` is satisfied by
     * one match, so widening an alternation adds nothing, and the file that reached
     * `field-dropped` *without* the trailing sentence is exactly the one that used to
     * cross this line. Requiring it by name is what notices if it ever crosses back.
     */
    name: 'a field-dropped file is reported as discarded',
    mutate: (c) => (c.validity === 'field-dropped' ? { ...c, validity: 'discarded' } : c),
    names: [
      /^(field-dropped-hooks|dropped-over-discarded): reported .*settings\.json, which the recording leaves field-dropped, claiming 1 of its entries never apply — the rest of that file is live config$/,
      /^deny-nonstring-elements: reported .*settings\.json, which the recording leaves field-dropped, claiming 1 of its entries never apply — the rest of that file is live config$/,
    ],
  },
  {
    /** The original incident: a discarded file believed. This is the state before DEA-147. */
    name: 'a discarded file is treated as accepted',
    mutate: (c) => (c.validity === 'discarded' ? { ...c, validity: 'accepted' } : c),
    names: [
      /^discarded-many-entries: said nothing about settings\.json, which doctor discards whole — 6 entries in it are dead/,
    ],
  },
  {
    /** The lazy collapse to "valid or not", which is the previous two at once. */
    name: 'anything not accepted is reported as discarded',
    mutate: (c) => (c.validity === 'accepted' ? c : { ...c, validity: 'discarded' }),
    names: [/which the recording leaves field-dropped/, /with nothing checked, reported \d+ file\(s\)/],
  },
  {
    /** And the flattening in the other direction: nothing is ever refused. */
    name: 'nothing is ever discarded',
    mutate: as('accepted'),
    names: [/^discarded-marketplace-source: said nothing about settings\.json/],
  },
];

describe('the gate fails when the detector is wrong', () => {
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
