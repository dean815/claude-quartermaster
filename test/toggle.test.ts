/**
 * The planning gate: what stops a write, and what a write would say.
 *
 * `planToggles` is the whole consent model. Everything hazardous about the bytes is in
 * `write.ts` and gated by `write.test.ts`; what is gated here is the set of situations in
 * which this tool declines to use it, because each of them is a write that would report
 * success and change nothing.
 *
 * ## The mutation harness
 *
 * `CHECKS` is a list rather than a chain of `if`s so that this file can drop exactly one
 * guard and run the same scenarios. Every check must cost a scenario when it is removed:
 * `dropping one check reddens the gate` loops over `CHECKS`, removes each in turn, and
 * asserts both *that* the gate fails and that the failure names the scenario that guard
 * exists for. A guard nobody can delete is a guard nobody has tested, and DEA-149's hole
 * was exactly a guard the suite happened to cover through something else.
 *
 * ## What it never touches
 *
 * No real project, no real settings file, and no `claude` spawn. Every scenario builds a
 * directory under `mkdtempSync` and a `Workspace` around it. The one recorded first-party
 * input is `test/fixtures/doctor/`, replayed through the real parser.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditContext } from '../src/detect.ts';
import type { PluginInventory } from '../src/inventory.ts';
import { NOT_CHECKED, readSettings } from '../src/surfaces/read.ts';
import type { ClaudeJson, SettingsCheck, Workspace } from '../src/surfaces/types.ts';
import { settingsFromDoctor } from '../src/delegate/doctor.ts';
import {
  CHECKS,
  EMPTY_SETTINGS,
  TARGET_FILENAME,
  WRITTEN_SETTINGS_KEY,
  describePlan,
  editsFor,
  gitIgnoreState,
  namesWrittenKey,
  planEffect,
  planToggles,
  targetFor,
  unifiedDiff,
  type PlanCheck,
  type PlanResult,
  type ToggleRefusalCode,
  type ToggleRequest,
} from '../src/toggle.ts';
import { project } from './factories.ts';
import { caseDir, doctorText, localPath, settingsPath } from './fixtures/doctor/load.ts';

// ---------------------------------------------------------------------------
// A world, on disk, with nothing real in it
// ---------------------------------------------------------------------------

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'qm-toggle-'));
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const claudeJson = (path: string): ClaudeJson => ({
  path,
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
});

const inventory = (id: string): PluginInventory => ({
  id,
  installPath: null,
  version: null,
  sha: null,
  manifestName: null,
  installed: null,
  // A source that enumerated it and found no MCP server: `reload`, by the catalog rather
  // than by an observation, so the effect line below is not an artefact of empty
  // transcripts.
  enumerated: [
    { source: 'catalog', names: [], skillNames: [], mcpServerNames: [], sha: null, version: null, fetchedAt: null },
  ],
});

interface World {
  dir: string;
  ctx: AuditContext;
  target: string;
}

/**
 * A project directory, its settings files, and the context around them.
 *
 * `home` is a directory of its own so that `home-collision` is reachable by pointing the
 * project at it, rather than by anything about the machine this runs on.
 */
function world(
  name: string,
  files: {
    local?: string;
    localCheck?: SettingsCheck;
    projectSettings?: string;
    user?: Record<string, boolean>;
    asHome?: boolean;
    git?: boolean;
  } = {},
): World {
  const dir = join(root, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (files.local !== undefined) writeFileSync(join(dir, '.claude', TARGET_FILENAME), files.local);
  if (files.projectSettings !== undefined) {
    writeFileSync(join(dir, '.claude', 'settings.json'), files.projectSettings);
  }
  if (files.git) {
    execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  }

  const record = project(dir, {
    settings: readSettings(join(dir, '.claude', 'settings.json'), NOT_CHECKED),
    localSettings: readSettings(join(dir, '.claude', TARGET_FILENAME), files.localCheck ?? NOT_CHECKED),
  });
  const ws: Workspace = {
    home: files.asHome ? dir : join(root, '__home__'),
    userSettings: files.user
      ? {
          path: join(root, '__home__', '.claude', 'settings.json'),
          validity: 'accepted',
          schemaErrors: [],
          droppedRuleElements: {},
          enabledPlugins: files.user,
          rest: {},
        }
      : null,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(join(root, '__home__', '.claude.json')),
    projects: [record],
  };

  return {
    dir,
    target: targetFor(dir),
    ctx: {
      ws,
      measurements: [],
      pluginCosts: new Map(),
      inventories: new Map([['p@m', inventory('p@m')]]),
    },
  };
}

const on = (id = 'p@m'): ToggleRequest[] => [{ pluginId: id, enable: true }];
const off = (id = 'p@m'): ToggleRequest[] => [{ pluginId: id, enable: false }];

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/**
 * What must happen, per situation. Literals: an expectation recomputed by calling
 * `planToggles` a second way would agree with whatever it does.
 */
interface Scenario {
  label: string;
  /** The guard this scenario exists for, or `null` where a plan is the right answer. */
  guard: string | null;
  build(): World;
  requests: ToggleRequest[];
  expect: ToggleRefusalCode | 'planned';
}

const SCENARIOS: Scenario[] = [
  {
    label: 'a fresh project gets a new file',
    guard: null,
    build: () => world('fresh'),
    requests: on(),
    expect: 'planned',
  },
  {
    label: 'an existing local file gets one more entry',
    guard: null,
    build: () =>
      world('existing', { local: '{\n  "enabledPlugins": {\n    "other@m": true\n  }\n}\n' }),
    requests: on(),
    expect: 'planned',
  },
  {
    label: 'flipping a value the project already set the other way',
    guard: null,
    build: () =>
      world('flip', { local: '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n' }),
    requests: off(),
    expect: 'planned',
  },
  {
    label: 'the home directory, whose project scope is user scope',
    guard: 'home-collision',
    build: () => world('as-home', { asHome: true }),
    requests: on(),
    expect: 'home-collision',
  },
  {
    label: 'a directory the workspace does not carry',
    guard: null,
    build: () => {
      const w = world('unknown-dir');
      return { ...w, ctx: { ...w.ctx, ws: { ...w.ctx.ws, projects: [] } } };
    },
    requests: on(),
    expect: 'no-such-project',
  },
  {
    label: 'a target Claude Code refuses whole',
    guard: 'target-validity',
    build: () =>
      world('discarded', {
        local: '{\n  "permissions": 42\n}\n',
        localCheck: {
          validity: 'discarded',
          schemaErrors: [
            {
              path: 'x',
              key: 'permissions',
              message: 'Expected object, but received number',
              notes: [],
              costs: 'file',
            },
          ],
        },
      }),
    requests: on(),
    expect: 'target-discarded',
  },
  {
    label: 'a target doctor reported on in words this release cannot place',
    guard: 'target-validity',
    build: () =>
      world('unplaced', {
        local: '{\n  "enabledPlugins": {\n    "bogus@nowhere": 42\n  }\n}\n',
        localCheck: {
          validity: 'not-checked',
          schemaErrors: [
            {
              path: 'x',
              key: 'enabledPlugins.bogus@nowhere',
              message: 'Invalid input',
              notes: [],
              costs: 'unknown',
            },
          ],
        },
      }),
    requests: on(),
    expect: 'target-unplaced',
  },
  {
    /**
     * The state DEA-149 names and nothing here had reached: a file Claude Code keeps
     * while ignoring one key of it. Constructed, because no release has been measured
     * dropping `enabledPlugins` as a *field* -- every malformed shape of it measured on
     * 2.1.224 refuses the file instead. It is the tripwire, not a recording, and it says
     * so: the day a partial acceptance names this key, the write must already refuse.
     */
    label: 'a target that applies but ignores the key this writes',
    guard: 'target-validity',
    build: () =>
      world('key-ignored', {
        local: '{\n  "enabledPlugins": {}\n}\n',
        localCheck: {
          validity: 'field-dropped',
          schemaErrors: [
            {
              path: 'x',
              key: WRITTEN_SETTINGS_KEY,
              message: 'Expected record, but received number. This field was ignored.',
              notes: [],
              costs: 'field',
            },
          ],
        },
      }),
    requests: on(),
    expect: 'target-ignores-key',
  },
  {
    label: 'the value the target already sets',
    guard: 'no-change',
    build: () =>
      world('already-set', { local: '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n' }),
    requests: on(),
    expect: 'no-change',
  },
  {
    label: 'the value it would inherit anyway',
    guard: 'no-change',
    build: () => world('would-inherit', { user: { 'p@m': true } }),
    requests: on(),
    expect: 'no-change',
  },
];

/** Every scenario whose answer is not what it must be. */
function runGate(checks: readonly PlanCheck[]): string[] {
  const out: string[] = [];
  for (const s of SCENARIOS) {
    const w = s.build();
    const result = planToggles(w.ctx, w.dir, s.requests, checks);
    const got: string = result.outcome === 'planned' ? 'planned' : (result.refusals[0]?.code ?? 'none');
    if (got !== s.expect) out.push(`${s.label}: expected ${s.expect}, got ${got}`);
  }
  return out;
}

const report = (f: readonly string[]) => `\n  ${f.length} failure(s):\n  ${f.join('\n  ')}`;

describe('what stops a write', () => {
  test('every scenario answers the way it must', () => {
    const failures = runGate(CHECKS);
    console.log(`    toggle: ${SCENARIOS.length} scenarios over ${CHECKS.length} checks`);
    assert.deepEqual(failures, [], report(failures));
  });

  /**
   * The gate proving it can fail, once per guard.
   *
   * Not one mutant but `CHECKS.length` of them, built by deletion rather than by hand,
   * so a guard added later is covered the moment it joins the list -- and a guard that
   * nothing depends on shows up here as a deletion the suite does not notice.
   */
  test('dropping one check reddens the gate, naming the scenario it guards', () => {
    for (const dropped of CHECKS) {
      const failures = runGate(CHECKS.filter((c) => c !== dropped));
      assert.ok(
        failures.length > 0,
        `dropping "${dropped.name}" cost nothing — that is a hole in the gate, not a check to delete`,
      );
      const guarded = SCENARIOS.filter((s) => s.guard === dropped.name).map((s) => s.label);
      assert.ok(
        guarded.length > 0,
        `no scenario names "${dropped.name}" as its guard, so its removal is untested`,
      );
      assert.ok(
        guarded.some((label) => failures.some((f) => f.startsWith(`${label}:`))),
        `dropping "${dropped.name}" failed, but not on ${guarded.join(' / ')}: ${report(failures)}`,
      );
      console.log(`    dropping "${dropped.name}" costs ${failures.length}: ${failures[0]}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The recorded first-party message
// ---------------------------------------------------------------------------

/**
 * The refusals, driven by `claude doctor`'s own bytes rather than by a `SettingsCheck`
 * this file wrote.
 *
 * The scenarios above construct their validity, which is what makes them table-driven and
 * what makes them a restatement of the rule. These two are the recordings: the real parser
 * over the real output, and the refusal that follows. `unplaced-plugin-entry` is the one
 * that matters -- `Invalid input` is a message no release of this repo recognises, so the
 * file reads `not-checked` and `discarded`-only would have written into it. Measured on
 * 2.1.224 with `claude plugin list --json`: a file carrying that message does not apply.
 */
describe('and the same refusals from a recorded doctor run', () => {
  for (const [name, expected] of [
    ['discarded-permissions-deny', 'target-discarded'],
    ['unplaced-plugin-entry', 'target-unplaced'],
  ] as const) {
    test(`${name} refuses with ${expected}`, () => {
      const recorded = { name, note: '', enabled: false, files: [] };
      const checks = settingsFromDoctor(doctorText(recorded), [
        settingsPath(recorded),
        localPath(recorded),
      ]);
      // The recording names one of the two files; whichever it is becomes the target.
      const named = [...checks].find(([, c]) => c.schemaErrors.length)!;
      const w = world(`recorded-${name}`, {
        local: '{\n  "enabledPlugins": {}\n}\n',
        localCheck: named[1],
      });

      const result = planToggles(w.ctx, w.dir, on());
      assert.equal(result.outcome, 'refused');
      if (result.outcome !== 'refused') return;
      assert.equal(result.refusals[0]!.code, expected);
      // Verbatim, so a refusal can be acted on without re-running the command that
      // produced it -- DEA-148's rule, applied to a refusal instead of a finding.
      assert.match(result.refusals[0]!.evidence[0]!, /›/);
      assert.ok(
        doctorText(recorded).includes(named[1].schemaErrors[0]!.message),
        'the evidence quotes a message the recording does not contain',
      );
      console.log(`    ${name}: ${result.refusals[0]!.evidence[0]}`);
    });
  }

  test('the recording lives where the loader can rebase it', () => {
    assert.ok(caseDir({ name: 'unplaced-plugin-entry', note: '', enabled: false, files: [] }));
  });
});

// ---------------------------------------------------------------------------
// The plan itself
// ---------------------------------------------------------------------------

function planned(result: PlanResult) {
  if (result.outcome === 'refused') {
    throw new Error(`refused ${result.refusals.map((r) => r.code).join(', ')}`);
  }
  return result.plan;
}

describe('what a plan says', () => {
  /**
   * The seed, as a literal.
   *
   * Not `EMPTY_SETTINGS` compared against itself, and not `JSON.stringify({...}, null, 2)`
   * either -- the property is that the created file carries a layout `write.ts` can copy,
   * and rebuilding the expectation from the same stringify call would agree with a seed of
   * `{}` if someone changed it back.
   */
  test('a created file is seeded with a layout, not with {}', () => {
    assert.equal(EMPTY_SETTINGS, '{\n  "enabledPlugins": {}\n}\n');

    const w = world('seed');
    const plan = planned(planToggles(w.ctx, w.dir, on()));
    assert.equal(plan.creates, true);
    assert.equal(plan.before, EMPTY_SETTINGS);
    assert.equal(plan.after, '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n');
  });

  test('an existing file keeps every byte it had outside the entry', () => {
    const before = '{\n  "enabledPlugins": {\n    "other@m": true\n  },\n  "unmodelled": [1, 2]\n}\n';
    const w = world('surgical', { local: before });
    const plan = planned(planToggles(w.ctx, w.dir, on()));

    assert.equal(plan.creates, false);
    assert.equal(plan.before, before);
    assert.equal(
      plan.after,
      '{\n  "enabledPlugins": {\n    "other@m": true,\n    "p@m": true\n  },\n  "unmodelled": [1, 2]\n}\n',
    );
    // The array written inline stays inline: nothing outside the edited value is re-encoded.
    assert.ok(plan.after.includes('"unmodelled": [1, 2]'));
  });

  test('several targets are one plan, one diff and one file', () => {
    const w = world('batch');
    const plan = planned(
      planToggles(w.ctx, w.dir, [
        { pluginId: 'a@m', enable: true },
        { pluginId: 'b@m', enable: true },
      ]),
    );
    assert.equal(plan.changes.length, 2);
    assert.equal(
      plan.after,
      '{\n  "enabledPlugins": {\n    "a@m": true,\n    "b@m": true\n  }\n}\n',
    );
  });

  /**
   * The effect line is `classify`'s answer, and this is the gate the brief asks for.
   *
   * Two scenarios with different verdicts, and the assertion is that the printed line
   * *tracks* -- a describe that prints a fixed sentence passes on one of them and fails
   * on the other whichever sentence it picks.
   */
  test('and the effect printed is the verdict, not a sentence about sessions', () => {
    const withCatalog = world('effect-reload');
    const reload = planned(planToggles(withCatalog.ctx, withCatalog.dir, on()));
    assert.equal(planEffect(reload), 'reload');

    const uncatalogued = world('effect-unknown');
    const unknown = planned(planToggles(uncatalogued.ctx, uncatalogued.dir, on('nobody@m')));
    assert.equal(planEffect(unknown), 'unknown');

    for (const [plan, verdict] of [
      [reload, 'reload'],
      [unknown, 'unknown'],
    ] as const) {
      const lines = describePlan(plan);
      assert.ok(
        lines.some((l) => l.trim() === `effect: ${verdict}`),
        `the plan printed no "effect: ${verdict}" line: ${lines.join(' | ')}`,
      );
      // The classifier's own sentence, verbatim. A second copy of the rule here is a copy
      // that can be right while the classifier is wrong.
      assert.ok(
        lines.some((l) => l.includes(plan.changes[0]!.effect.reason)),
        'the reason printed is not the classification\'s own',
      );
    }

    // And nothing anywhere says the blanket thing, which is false for `reload`.
    for (const l of describePlan(reload)) {
      assert.doesNotMatch(l, /takes effect (on the )?next session/i);
    }
  });

  test('a plan for a project whose own settings.json overrides carries a note, not a refusal', () => {
    // user says true, the repo's tracked settings.json says false, and the local file is
    // asked for true. The resolved value moves -- false to true -- so this is a real
    // change; `resolveCell` still calls the entry `restated`, because it computes that
    // against the chain with *both* project-scope files removed. Reported, not refused.
    const w = world('restate', {
      user: { 'p@m': true },
      projectSettings: '{\n  "enabledPlugins": {\n    "p@m": false\n  }\n}\n',
    });
    const plan = planned(planToggles(w.ctx, w.dir, on()));
    assert.equal(plan.changes[0]!.from, false);
    assert.equal(plan.changes[0]!.to, true);
    assert.ok(
      plan.notes.some((n) => n.code === 'would-restate'),
      `no would-restate note: ${plan.notes.map((n) => n.code).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

describe('the pieces a plan is built from', () => {
  test('the target is settings.local.json under the project, and nothing else', () => {
    assert.equal(targetFor('/p'), '/p/.claude/settings.local.json');
    assert.equal(TARGET_FILENAME, 'settings.local.json');
  });

  test('a file with the key gets per-entry edits; one without gets a single insert', () => {
    const file = readSettings(join(root, 'nope.json'), NOT_CHECKED);
    assert.equal(file, null);
    assert.deepEqual(editsFor(null, [{ pluginId: 'a@m', enable: true }]), [
      { path: [WRITTEN_SETTINGS_KEY], value: { 'a@m': true } },
    ]);

    const w = world('edits', { local: '{\n  "enabledPlugins": {\n    "x@m": true\n  }\n}\n' });
    const withKey = w.ctx.ws.projects[0]!.localSettings;
    assert.deepEqual(editsFor(withKey, [{ pluginId: 'a@m', enable: false }]), [
      { path: [WRITTEN_SETTINGS_KEY, 'a@m'], value: false },
    ]);
  });

  test('the written key is matched downward, and not by prefix accident', () => {
    assert.equal(namesWrittenKey('enabledPlugins'), true);
    assert.equal(namesWrittenKey('enabledPlugins.a@m'), true);
    assert.equal(namesWrittenKey('enabledPluginsExtra'), false);
    assert.equal(namesWrittenKey('permissions.deny'), false);
  });

  test('the diff shows the change with context, and says nothing when there is none', () => {
    assert.deepEqual(unifiedDiff('a\nb\n', 'a\nb\n'), ['(no change)']);
    assert.deepEqual(unifiedDiff('{\n  "a": 1\n}\n', '{\n  "a": 2\n}\n'), [
      '--- before (3 lines)',
      '+++ after (3 lines)',
      '  {',
      '-   "a": 1',
      '+   "a": 2',
      '  }',
    ]);
  });

  /**
   * `git check-ignore`, and the cwd that made it lie.
   *
   * The target of a first write usually sits in a `.claude/` that does not exist yet, so
   * spawning with the target's parent as the working directory failed `ENOENT` -- the same
   * error a missing `git` gives -- and the note read "git is not on PATH" on exactly the
   * runs it exists for. The repository here sets its own `core.excludesFile` to nothing,
   * because on the machine this was written for `~/.config/git/ignore` covers the path and
   * would answer for every fixture.
   */
  test('git is asked from the project, about a path that need not exist', () => {
    const dir = join(root, 'repo');
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '.'], { cwd: dir });
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: dir });
    const target = targetFor(dir);

    assert.equal(gitIgnoreState(dir, target), 'tracked');
    writeFileSync(join(dir, '.gitignore'), '.claude/settings.local.json\n');
    assert.equal(gitIgnoreState(dir, target), 'ignored');

    const bare = join(root, 'not-a-repo');
    mkdirSync(bare, { recursive: true });
    assert.equal(gitIgnoreState(bare, targetFor(bare)), 'not-a-repo');
  });

  test('and a tracked target is a note rather than a refusal', () => {
    const w = world('tracked', { git: true });
    execFileSync('git', ['config', 'core.excludesFile', '/dev/null'], { cwd: w.dir });
    const plan = planned(planToggles(w.ctx, w.dir, on()));
    assert.ok(
      plan.notes.some((n) => n.code === 'tracked-path'),
      `no tracked-path note: ${plan.notes.map((n) => n.code).join(', ')}`,
    );
  });
});
