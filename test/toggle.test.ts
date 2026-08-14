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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditContext } from '../src/detect.ts';
import type { PluginInventory } from '../src/inventory.ts';
import { NOT_CHECKED, readSettings } from '../src/surfaces/read.ts';
import type {
  ClaudeJson,
  McpServerSpec,
  ProjectEntry,
  SettingsCheck,
  Workspace,
} from '../src/surfaces/types.ts';
import { settingsFromDoctor } from '../src/delegate/doctor.ts';
import {
  AXES,
  CHECKS,
  MCP_AXIS,
  PLUGIN_AXIS,
  SKILL_AXIS,
  TARGET_FILENAME,
  describePlan,
  editsFor,
  emptySettings,
  gitIgnoreState,
  namesWrittenKey,
  planEffect,
  planToggles,
  showValue,
  targetFor,
  unifiedDiff,
  type Axis,
  type EntryValue,
  type PlanCheck,
  type PlanResult,
  type ToggleRefusalCode,
  type ToggleRequest,
} from '../src/toggle.ts';
import { SKILL_VALUES, type SkillValue } from '../src/model.ts';
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

const claudeJson = (path: string, body: Partial<ClaudeJson> = {}): ClaudeJson => ({
  path,
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
  ...body,
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
  /** The MCP axis's target -- the fake home's `.claude.json`, on disk. */
  claudeJson: string;
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
    /** User-scope keys, per axis. Both may be set; a scenario reads only its own. */
    user?: { enabledPlugins?: Record<string, boolean>; skillOverrides?: Record<string, SkillValue> };
    asHome?: boolean;
    git?: boolean;
    /**
     * The MCP axis's world: what `~/.claude.json` says, and what it holds for this
     * project. Written to disk as well as modelled, because that file *is* the target and
     * `planToggles` reads its bytes.
     */
    mcp?: {
      mcpServers?: Record<string, McpServerSpec>;
      everConnected?: string[];
      /** `null` leaves the project out of `projects` entirely -- an unregistered one. */
      entry?: ProjectEntry | null;
      mcpJson?: Record<string, McpServerSpec>;
    };
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

  const home = files.asHome ? dir : join(root, '__home__');
  mkdirSync(home, { recursive: true });
  const claudeJsonPath = join(home, `.claude.json`);
  const entry = files.mcp?.entry;
  const registered = entry !== null;
  const doc = claudeJson(claudeJsonPath, {
    mcpServers: files.mcp?.mcpServers ?? {},
    claudeAiMcpEverConnected: files.mcp?.everConnected ?? [],
    projects: registered ? { [dir]: entry ?? {} } : {},
  });
  // The real bytes, two-space indented the way Claude Code writes them, so the edits
  // splice into a document with a layout to copy rather than one this file invented.
  // `lastCost` stands in for the telemetry every live session writes into this file.
  writeFileSync(
    claudeJsonPath,
    `${JSON.stringify(
      {
        numStartups: 3,
        mcpServers: doc.mcpServers,
        claudeAiMcpEverConnected: doc.claudeAiMcpEverConnected,
        projects: doc.projects,
        lastCost: 0.5,
      },
      null,
      2,
    )}\n`,
  );

  const record = project(dir, {
    registered,
    entry: entry ?? null,
    ...(files.mcp?.mcpJson
      ? { mcpJson: { path: join(dir, '.mcp.json'), mcpServers: files.mcp.mcpJson } }
      : {}),
    settings: readSettings(join(dir, '.claude', 'settings.json'), NOT_CHECKED),
    localSettings: readSettings(join(dir, '.claude', TARGET_FILENAME), files.localCheck ?? NOT_CHECKED),
  });
  const ws: Workspace = {
    home,
    userSettings: files.user
      ? {
          path: join(root, '__home__', '.claude', 'settings.json'),
          validity: 'accepted',
          schemaErrors: [],
          droppedRuleElements: {},
          ...files.user,
          rest: {},
        }
      : null,
    userRules: [],
    personalSkills: [],
    claudeJson: doc,
    projects: [record],
  };

  return {
    dir,
    target: targetFor(dir),
    claudeJson: claudeJsonPath,
    ctx: {
      ws,
      measurements: [],
      pluginCosts: new Map(),
      inventories: new Map([['p@m', inventory('p@m')]]),
    },
  };
}

const on = (id = 'p@m'): ToggleRequest[] => [{ id, value: true }];
const off = (id = 'p@m'): ToggleRequest[] => [{ id, value: false }];
/** One skill request, at whichever of the four states the scenario is about. */
const skill = (value: SkillValue, id = 's-01'): ToggleRequest[] => [{ id, value }];
/** One MCP request. `false` denies, `true` un-denies -- the container is inverted. */
const mcp = (id: string, value: boolean): ToggleRequest[] => [{ id, value }];

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/**
 * What must happen, per situation. Literals: an expectation recomputed by calling
 * `planToggles` a second way would agree with whatever it does.
 *
 * `axis` defaults to the plugin one so every pre-QM-45 row reads unchanged and the skill
 * rows are visibly the additions. It is not a second table: the point of the axis being a
 * value is that one table exercises both, and `dropping one check reddens the gate` below
 * therefore proves each guard on whichever axis reaches it.
 */
interface Scenario {
  label: string;
  /** The guard this scenario exists for, or `null` where a plan is the right answer. */
  guard: string | null;
  axis?: Axis;
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
    /**
     * A project whose *name* is the home directory's, one level down.
     *
     * Here because the collision is a path and not a name: a guard comparing basenames
     * answers this one `home-collision`, and every other scenario in the table agrees
     * with it. Added after a hand mutation that did exactly that left the suite green.
     */
    label: 'a project sharing the home directory\'s name but not its path',
    guard: null,
    build: () => world('nested/__home__'),
    requests: on(),
    expect: 'planned',
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
              key: PLUGIN_AXIS.writtenKey,
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
    build: () => world('would-inherit', { user: { enabledPlugins: { 'p@m': true } } }),
    requests: on(),
    expect: 'no-change',
  },

  // -------------------------------------------------------------------------
  // The skill axis (QM-45). Same table, same guards, four values.
  // -------------------------------------------------------------------------

  {
    label: 'a skill written into a fresh project',
    guard: null,
    axis: SKILL_AXIS,
    build: () => world('skill-fresh'),
    requests: skill('off'),
    expect: 'planned',
  },
  {
    /**
     * The refusal that would go missing if `noChange` compared against `false` rather
     * than against the axis's own fallback. A skill nothing mentions is `on`, so asking
     * for `on` moves nothing -- where the plugin-shaped comparison (`value !== enable`
     * over booleans) would find `'on' !== true` and plan a write.
     */
    label: 'a skill asked for the value an unmentioned skill already has',
    guard: 'no-change',
    axis: SKILL_AXIS,
    build: () => world('skill-default'),
    requests: skill('on'),
    expect: 'no-change',
  },
  {
    label: 'a skill asked for the state the target already sets',
    guard: 'no-change',
    axis: SKILL_AXIS,
    build: () =>
      world('skill-already', { local: '{\n  "skillOverrides": {\n    "s-01": "name-only"\n  }\n}\n' }),
    requests: skill('name-only'),
    expect: 'no-change',
  },
  {
    /**
     * The row that separates four values from two, and the reason `noChange` compares
     * with `Object.is` over the whole domain.
     *
     * `name-only` and `user-invocable-only` are both "not fully on" and both "not off",
     * so every boolean-shaped comparison -- truthiness, `!== 'off'`, `=== fallback` --
     * calls this a no-op and refuses a write that really does move the resolved value.
     * A refusal is the quiet half of the collapse: nothing is written and nothing says
     * the tool got the question wrong.
     */
    label: 'a skill moved between two non-default states',
    guard: null,
    axis: SKILL_AXIS,
    build: () =>
      world('skill-between', { local: '{\n  "skillOverrides": {\n    "s-01": "name-only"\n  }\n}\n' }),
    requests: skill('user-invocable-only'),
    expect: 'planned',
  },
  {
    label: 'a skill written into a target Claude Code refuses whole',
    guard: 'target-validity',
    axis: SKILL_AXIS,
    build: () =>
      world('skill-discarded', {
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
    requests: skill('off'),
    expect: 'target-discarded',
  },
  {
    /**
     * `namesWrittenKey` asked about the axis it was given, not about `enabledPlugins`.
     *
     * Its mirror image is the row below: the same file, the same dropped key, and a
     * *plugin* write that must go through. Together they are the whole of why the axis
     * is a required parameter there -- one of them fails whichever way a default is
     * wrong, and neither fails on its own.
     */
    label: 'a skill written where doctor dropped skillOverrides',
    guard: 'target-validity',
    axis: SKILL_AXIS,
    build: () => world('skill-key-ignored', droppedSkillOverrides()),
    requests: skill('off'),
    expect: 'target-ignores-key',
  },
  {
    label: 'a plugin written where doctor dropped skillOverrides and nothing else',
    guard: null,
    build: () => world('plugin-past-skill-drop', droppedSkillOverrides()),
    requests: on(),
    expect: 'planned',
  },

  // -------------------------------------------------------------------------
  // The MCP axis (QM-46). Same table, same guards, a shared file and a deny-list.
  // -------------------------------------------------------------------------

  {
    /**
     * The commonest real write on this axis, and the one a plugin-shaped `noChange`
     * refuses.
     *
     * A claude.ai connector nothing on disk mentions resolves `false` here -- `mcp.ts`
     * says that means *no file decided this*, not *it does not load* -- so comparing the
     * request against the resolved value calls this a no-op. 22 of the 34 distinct names
     * in this machine's deny-lists are exactly this shape, every one of them added while
     * in exactly this state. `Axis.fallbackDecides` is what keeps it planned.
     */
    label: 'a connector nothing declares, denied',
    guard: null,
    axis: MCP_AXIS,
    build: () => world('mcp-connector', { mcp: { everConnected: ['claude.ai Linear'], entry: {} } }),
    requests: mcp('claude.ai Linear', false),
    expect: 'planned',
  },
  {
    label: 'a user-scope server denied for this project',
    guard: null,
    axis: MCP_AXIS,
    build: () => world('mcp-user-scope', { mcp: { mcpServers: { linear: {} }, entry: {} } }),
    requests: mcp('linear', false),
    expect: 'planned',
  },
  {
    label: 'a denied server let back through',
    guard: null,
    axis: MCP_AXIS,
    build: () =>
      world('mcp-undeny', {
        mcp: { mcpServers: { linear: {} }, entry: { disabledMcpServers: ['linear'] } },
      }),
    requests: mcp('linear', true),
    expect: 'planned',
  },
  {
    label: 'a server the deny-list already names, denied again',
    guard: 'no-change',
    axis: MCP_AXIS,
    build: () =>
      world('mcp-already', { mcp: { entry: { disabledMcpServers: ['claude.ai Linear'] } } }),
    requests: mcp('claude.ai Linear', false),
    expect: 'no-change',
  },
  {
    /**
     * The shape only an inverted container reaches: `on` against a name nothing denies.
     *
     * There is no entry to remove, so the batch is empty -- and no comparison of the
     * resolved value notices, because `false` and the requested `true` differ. Without the
     * empty-batch clause this plans a write of zero edits and reports success.
     */
    label: 'a server nothing denies, turned on',
    guard: 'no-change',
    axis: MCP_AXIS,
    build: () => world('mcp-nothing-to-remove', { mcp: { mcpServers: { linear: {} }, entry: {} } }),
    requests: mcp('linear', true),
    expect: 'no-change',
  },
  {
    label: 'a project ~/.claude.json has never recorded',
    guard: 'unregistered-project',
    axis: MCP_AXIS,
    build: () => world('mcp-unregistered', { mcp: { entry: null } }),
    requests: mcp('linear', false),
    expect: 'unregistered-project',
  },
  {
    /**
     * A deny beside an allow. `resolveMcpServer` pushes both at `project` scope out of the
     * same file, so which wins is decided by the order this repo happens to push them in
     * -- reverse-engineered and never measured -- and a write whose effect cannot be
     * stated is the "reported success, changed nothing" failure with extra steps.
     */
    label: 'a deny written beside an allow for the same server',
    guard: 'contested-entry',
    axis: MCP_AXIS,
    build: () =>
      world('mcp-contested', {
        mcp: { mcpServers: { linear: {} }, entry: { enabledMcpServers: ['linear'] } },
      }),
    requests: mcp('linear', false),
    expect: 'contested-entry',
  },
  {
    /**
     * The DEA-145 tripwire, and it fires on nothing today.
     *
     * Measured across the live catalog: 7 rows read `manifest`, 55 carry no plugin, and
     * **0** read `marketplace-id`. It is constructed here for the same reason the dropped
     * -`enabledPlugins` row above is -- 2 of the 42 installed manifests on this machine
     * are unreadable, so the day one of those plugins enumerates an MCP server is the day
     * a write would mint `plugin:<marketplace id>:<server>` into a deny-list and report
     * success against a key no config file matches.
     */
    label: 'a plugin server whose name was built from the marketplace id',
    guard: 'key-provenance',
    axis: MCP_AXIS,
    build: () => unreadableManifest(),
    requests: mcp('plugin:notion:notion', false),
    expect: 'key-guessed',
  },
  {
    label: 'the home directory, whose deny-list is an ordinary projects entry',
    guard: null,
    axis: MCP_AXIS,
    build: () => world('mcp-as-home', { asHome: true, mcp: { entry: {} } }),
    requests: mcp('claude.ai Linear', false),
    expect: 'planned',
  },
];

/**
 * A workspace whose one enabled plugin has no readable manifest name (QM-46).
 *
 * `pluginNamespace` then falls back to the marketplace id and `keyBasis` reads
 * `marketplace-id`, which is the state `attestMcpName` refuses. Built by handing the
 * inventory `manifestName: null` and an enumerated MCP server -- the same two facts
 * `readInventories` would report for a plugin whose `.claude-plugin/plugin.json` could not
 * be read.
 */
function unreadableManifest(): World {
  const w = world('mcp-guessed-key', {
    local: '{\n  "enabledPlugins": {\n    "notion@m": true\n  }\n}\n',
    mcp: { entry: {} },
  });
  const inv: PluginInventory = {
    ...inventory('notion@m'),
    manifestName: null,
    enumerated: [
      {
        source: 'catalog',
        names: [],
        skillNames: [],
        mcpServerNames: ['notion'],
        sha: null,
        version: null,
        fetchedAt: null,
      },
    ],
  };
  return { ...w, ctx: { ...w.ctx, inventories: new Map([['notion@m', inv]]) } };
}

/**
 * A file Claude Code keeps while ignoring its `skillOverrides` key.
 *
 * Constructed, and it says so: no release measured here drops either written key as a
 * *field* -- every malformed `enabledPlugins` shape on 2.1.224 refuses the file entire,
 * and `skillOverrides` has not been probed at all. It is a tripwire for the day one
 * does, and it is shared by the two scenarios above so that they differ in exactly one
 * thing: which axis is being written.
 */
function droppedSkillOverrides(): Parameters<typeof world>[1] {
  return {
    local: '{\n  "enabledPlugins": {},\n  "skillOverrides": {}\n}\n',
    localCheck: {
      validity: 'field-dropped',
      schemaErrors: [
        {
          path: 'x',
          key: SKILL_AXIS.writtenKey,
          message: 'Expected record, but received number. This field was ignored.',
          notes: [],
          costs: 'field',
        },
      ],
    },
  };
}

/**
 * Every scenario whose answer is not what it must be.
 *
 * `axisFor` is the mutation seam (QM-45): the gate can be re-run with an axis swapped for
 * a broken one, and every scenario on that axis must answer the same way it always did or
 * the mutation is caught. It is a function of the scenario's own axis rather than a
 * single override, so a mutation to `SKILL_AXIS` leaves the plugin rows alone -- which is
 * how the failure list can name the divergence instead of listing the whole table.
 */
function runGate(checks: readonly PlanCheck[], mutation?: AxisMutation): string[] {
  const out: string[] = [];
  for (const s of SCENARIOS) {
    const w = s.build();
    const scenarioAxis = s.axis ?? PLUGIN_AXIS;
    const hit = mutation?.target === scenarioAxis;
    const result = planToggles(
      w.ctx,
      hit ? mutation!.axis : scenarioAxis,
      w.dir,
      hit ? s.requests.map((r) => ({ ...r, value: mutation!.value(r.value) })) : s.requests,
      checks,
    );
    const got: string = result.outcome === 'planned' ? 'planned' : (result.refusals[0]?.code ?? 'none');
    if (got !== s.expect) out.push(`${s.label}: expected ${s.expect}, got ${got}`);
  }
  return out;
}

/**
 * One axis replaced by a wrong one, requests and all.
 *
 * The requests are mapped too, because that is the path a real defect takes: the CLI
 * parses `<id>=<value>` through `axis.spellings`, so an axis whose spellings are booleans
 * hands `planToggles` a boolean and there is nowhere downstream for the state to come
 * back. Mutating only the axis and leaving four-valued requests in place models a
 * half-collapse nobody could write, and it reddens the gate on the wrong rows -- measured
 * before this parameter existed.
 */
interface AxisMutation {
  /** The axis to replace. Scenarios on any other axis run untouched. */
  target: Axis;
  axis: Axis;
  value(v: EntryValue): EntryValue;
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
 * over the real output, and the refusal that follows.
 *
 * **`unplaced-plugin-entry` changed branch and not outcome (DEA-153), which is the point of
 * having it here.** It read `not-checked` when DEA-112 recorded it, and refused because
 * `targetValidity` keys on the *state* -- `not-checked` carrying schema errors -- rather
 * than on any message. DEA-153 then placed `Invalid input` under `enabledPlugins.` as a
 * refusal, so the same bytes now read `discarded` and refuse one branch earlier. A write
 * tool that only refused on `discarded` would have written into this file for the whole
 * window between those two issues; one that only refused on `not-checked`-with-errors would
 * start writing into it today. Both branches are load-bearing, and this case has now been
 * on each side of that line.
 */
describe('and the same refusals from a recorded doctor run', () => {
  for (const [name, expected] of [
    ['discarded-permissions-deny', 'target-discarded'],
    ['unplaced-plugin-entry', 'target-discarded'],
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

      const result = planToggles(w.ctx, PLUGIN_AXIS, w.dir, on());
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
   * Not `emptySettings` compared against itself, and not `JSON.stringify({...}, null, 2)`
   * either -- the property is that the created file carries a layout `write.ts` can copy,
   * and rebuilding the expectation from the same stringify call would agree with a seed of
   * `{}` if someone changed it back.
   *
   * Both axes, because the seed names the key it is about to write into (QM-45): a skills
   * write seeded with `enabledPlugins` would create a file whose only content is a key it
   * never touches, and `undo` would then restore *that*.
   */
  test('a created file is seeded with a layout, not with {}', () => {
    assert.equal(emptySettings('enabledPlugins'), '{\n  "enabledPlugins": {}\n}\n');
    assert.equal(emptySettings('skillOverrides'), '{\n  "skillOverrides": {}\n}\n');

    const w = world('seed');
    const plan = planned(planToggles(w.ctx, PLUGIN_AXIS, w.dir, on()));
    assert.equal(plan.creates, true);
    assert.equal(plan.before, '{\n  "enabledPlugins": {}\n}\n');
    assert.equal(plan.after, '{\n  "enabledPlugins": {\n    "p@m": true\n  }\n}\n');

    const s = world('seed-skill');
    const skillPlan = planned(planToggles(s.ctx, SKILL_AXIS, s.dir, skill('off')));
    assert.equal(skillPlan.creates, true);
    assert.equal(skillPlan.before, '{\n  "skillOverrides": {}\n}\n');
    assert.equal(skillPlan.after, '{\n  "skillOverrides": {\n    "s-01": "off"\n  }\n}\n');
  });

  test('an existing file keeps every byte it had outside the entry', () => {
    const before = '{\n  "enabledPlugins": {\n    "other@m": true\n  },\n  "unmodelled": [1, 2]\n}\n';
    const w = world('surgical', { local: before });
    const plan = planned(planToggles(w.ctx, PLUGIN_AXIS, w.dir, on()));

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
      planToggles(w.ctx, PLUGIN_AXIS, w.dir, [
        { id: 'a@m', value: true },
        { id: 'b@m', value: true },
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
    const reload = planned(planToggles(withCatalog.ctx, PLUGIN_AXIS, withCatalog.dir, on()));
    assert.equal(planEffect(reload), 'reload');

    const uncatalogued = world('effect-unknown');
    const unknown = planned(planToggles(uncatalogued.ctx, PLUGIN_AXIS, uncatalogued.dir, on('nobody@m')));
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
      user: { enabledPlugins: { 'p@m': true } },
      projectSettings: '{\n  "enabledPlugins": {\n    "p@m": false\n  }\n}\n',
    });
    const plan = planned(planToggles(w.ctx, PLUGIN_AXIS, w.dir, on()));
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
    assert.deepEqual(editsFor(PLUGIN_AXIS, {}, '/p', [{ id: 'a@m', value: true }]), [
      { path: ['enabledPlugins'], value: { 'a@m': true } },
    ]);

    const withKey = { enabledPlugins: { 'x@m': true } };
    assert.deepEqual(editsFor(PLUGIN_AXIS, withKey, '/p', [{ id: 'a@m', value: false }]), [
      { path: ['enabledPlugins', 'a@m'], value: false },
    ]);
  });

  /**
   * The inverted container, which is where the shape stops being a settings block (QM-46).
   *
   * `off` appends one element and moves no other byte -- the index is the array's own
   * length, so `write.ts` copies the separator the file already uses. `on` has no such
   * shape: JSON has no way to splice an element *out*, so the array is rewritten without
   * it, and that is the one place this axis re-encodes anything it was not asked about.
   * A `disabledMcpServers` that is not there yet is created whole, and a `projects` entry
   * that is not there is never created at all -- `unregisteredProject` refuses first.
   */
  test('the deny-list appends to add and rewrites to remove', () => {
    const doc = { projects: { '/p': { disabledMcpServers: ['a', 'b'] } } };
    assert.deepEqual(editsFor(MCP_AXIS, doc, '/p', [{ id: 'c', value: false }]), [
      { path: ['projects', '/p', 'disabledMcpServers', 2], value: 'c' },
    ]);
    assert.deepEqual(editsFor(MCP_AXIS, doc, '/p', [{ id: 'a', value: true }]), [
      { path: ['projects', '/p', 'disabledMcpServers'], value: ['b'] },
    ]);
    assert.deepEqual(editsFor(MCP_AXIS, { projects: { '/p': {} } }, '/p', [{ id: 'a', value: false }]), [
      { path: ['projects', '/p', 'disabledMcpServers'], value: ['a'] },
    ]);
    // Presence is the value, so `entryIn` has two states and `entryFor` inverts.
    assert.equal(MCP_AXIS.entryIn(doc, '/p', 'a'), false);
    assert.equal(MCP_AXIS.entryIn(doc, '/p', 'zz'), null);
    assert.equal(MCP_AXIS.entryFor(false), false);
    assert.equal(MCP_AXIS.entryFor(true), null);
    // And the settings axes cannot express "no entry", which is why undo there is the file.
    assert.equal(PLUGIN_AXIS.editsFor({}, '/p', new Map([['a@m', null]])), null);
    assert.equal(PLUGIN_AXIS.undo, 'file');
    assert.equal(MCP_AXIS.undo, 'entries');
  });

  /**
   * The same file, asked about by each axis (QM-45).
   *
   * A file carrying `enabledPlugins` and no `skillOverrides` takes the *insert* shape for
   * a skills write and the *per-entry* shape for a plugin one -- so `editsFor` reading
   * the wrong axis's block would write `skillOverrides` entries one at a time into a key
   * that is not there, which `write.ts` refuses, or splice a whole `enabledPlugins`
   * object over one that already exists.
   */
  test('and which shape it takes is decided per axis, on one file', () => {
    const w = world('edits-two-axes', {
      local: '{\n  "enabledPlugins": {\n    "x@m": true\n  }\n}\n',
    });
    const file = JSON.parse(readFileSync(join(w.dir, '.claude', TARGET_FILENAME), 'utf8'));
    assert.deepEqual(editsFor(SKILL_AXIS, file, w.dir, [{ id: 's-01', value: 'name-only' }]), [
      { path: ['skillOverrides'], value: { 's-01': 'name-only' } },
    ]);
    assert.deepEqual(editsFor(PLUGIN_AXIS, file, w.dir, [{ id: 'x@m', value: false }]), [
      { path: ['enabledPlugins', 'x@m'], value: false },
    ]);
  });

  /**
   * Downward matching, and the axis it is asked about.
   *
   * The cross pairs are the point: `enabledPlugins` is not the skill axis's key and
   * `skillOverrides` is not the plugin axis's, so a `namesWrittenKey` that had kept a
   * hardcoded constant would answer `true` on one of these four and refuse a live write
   * -- or `false`, and make one.
   */
  test('the written key is matched downward, per axis, and not by prefix accident', () => {
    assert.equal(namesWrittenKey(PLUGIN_AXIS, 'enabledPlugins'), true);
    assert.equal(namesWrittenKey(PLUGIN_AXIS, 'enabledPlugins.a@m'), true);
    assert.equal(namesWrittenKey(PLUGIN_AXIS, 'enabledPluginsExtra'), false);
    assert.equal(namesWrittenKey(PLUGIN_AXIS, 'permissions.deny'), false);
    assert.equal(namesWrittenKey(PLUGIN_AXIS, 'skillOverrides'), false);

    assert.equal(namesWrittenKey(SKILL_AXIS, 'skillOverrides'), true);
    assert.equal(namesWrittenKey(SKILL_AXIS, 'skillOverrides.deploy'), true);
    assert.equal(namesWrittenKey(SKILL_AXIS, 'skillOverridesExtra'), false);
    assert.equal(namesWrittenKey(SKILL_AXIS, 'enabledPlugins'), false);
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
    const plan = planned(planToggles(w.ctx, PLUGIN_AXIS, w.dir, on()));
    assert.ok(
      plan.notes.some((n) => n.code === 'tracked-path'),
      `no tracked-path note: ${plan.notes.map((n) => n.code).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Four values, and everything that could turn them into two (QM-45)
// ---------------------------------------------------------------------------

/**
 * The states, written out.
 *
 * A literal and not `SKILL_VALUES.map(...)`: an expectation rebuilt from the constant
 * under test agrees with whatever that constant becomes, which is the `memorySlug` defect
 * this repo has already paid for once. The constant is asserted *against* this list
 * below, in one place, so a fifth state is one edit here and a red test everywhere it
 * matters rather than a silent widening.
 */
const FOUR_STATES: readonly SkillValue[] = ['on', 'name-only', 'user-invocable-only', 'off'];

describe('the skill axis is four-valued in the grammar', () => {
  test('the spellings are exactly the four states, and no boolean is among them', () => {
    assert.deepEqual([...SKILL_AXIS.spellings.keys()], [...FOUR_STATES]);
    assert.deepEqual([...SKILL_AXIS.spellings.values()], [...FOUR_STATES]);
    assert.deepEqual([...SKILL_VALUES], [...FOUR_STATES]);

    // The collapse, stated as the absence it is. `true`/`false` are the plugin axis's
    // spellings and mean something there; accepting either here would mean choosing which
    // of `on` and `name-only` a `true` was, and there is no answer to that.
    for (const boolish of ['true', 'false']) {
      assert.equal(
        SKILL_AXIS.spellings.has(boolish),
        false,
        `--axis skill accepted ${boolish}, which has to be mapped onto one of four states`,
      );
    }
    assert.equal(PLUGIN_AXIS.spellings.get('true'), true);
    assert.equal(PLUGIN_AXIS.spellings.get('false'), false);
  });

  test('and the registry offers both axes under the names --axis takes', () => {
    assert.deepEqual([...AXES.keys()], ['plugin', 'skill', 'mcp']);
    assert.equal(AXES.get('plugin'), PLUGIN_AXIS);
    assert.equal(AXES.get('skill'), SKILL_AXIS);
    assert.equal(AXES.get('mcp'), MCP_AXIS);
    // The map key and the axis's own name are the same string, because `UndoRecord`
    // stores one and `undoLast` looks the other up (QM-46).
    for (const [name, axis] of AXES) assert.equal(axis.name, name);
  });
});

describe('all four values reach the file as themselves', () => {
  /**
   * Every state, written and read back through the bytes.
   *
   * The expectation is the JSON literal rather than anything derived from the request, so
   * a write that mapped `user-invocable-only` onto `true` -- or onto `"off"`, or onto the
   * fallback -- fails here naming the state it lost. All four are asserted and not just
   * the two the plugin axis has analogues for: the pair that has no boolean image is the
   * pair a collapse destroys.
   *
   * Each starts from a user-scope value the request moves away from. Without one, `on` is
   * what an unmentioned skill already resolves to and `noChange` refuses it -- correctly,
   * and it is worth saying that this test learned that the hard way rather than reasoning
   * it out: the fallback is a real state and asking for it is a real no-op.
   */
  for (const value of FOUR_STATES) {
    const standing: SkillValue = value === 'off' ? 'on' : 'off';
    test(`a fresh project written to ${value}, from a user scope saying ${standing}`, () => {
      const w = world(`four-${value}`, { user: { skillOverrides: { 's-01': standing } } });
      const plan = planned(planToggles(w.ctx, SKILL_AXIS, w.dir, skill(value)));
      assert.equal(plan.changes[0]!.from, standing);
      assert.equal(plan.changes[0]!.to, value);

      assert.equal(plan.after, `{\n  "skillOverrides": {\n    "s-01": ${JSON.stringify(value)}\n  }\n}\n`);
      // Re-read through the real parser, so the claim is about the file and not about the
      // string this test just built.
      writeFileSync(join(w.dir, '.claude', TARGET_FILENAME), plan.after);
      const reread = readSettings(join(w.dir, '.claude', TARGET_FILENAME), NOT_CHECKED);
      assert.equal(reread?.skillOverrides?.['s-01'], value);
    });
  }

  test('and an existing block takes the new state without re-encoding its neighbours', () => {
    const before =
      '{\n  "skillOverrides": {\n    "other": "off"\n  },\n  "unmodelled": [1, 2]\n}\n';
    const w = world('four-surgical', { local: before });
    const plan = planned(planToggles(w.ctx, SKILL_AXIS, w.dir, skill('user-invocable-only')));

    assert.equal(
      plan.after,
      '{\n  "skillOverrides": {\n    "other": "off",\n    "s-01": "user-invocable-only"\n  },\n' +
        '  "unmodelled": [1, 2]\n}\n',
    );
  });

  /**
   * The printed line names the state, not a switch.
   *
   * `name-only -> user-invocable-only` is the pair with no boolean rendering at all, so a
   * change line built from `Boolean(value)` prints `false -> false` here and passes every
   * on/off case. The header carries the key for the same reason: `on` and `true` are
   * different words for different axes and the reader needs to know which file key they
   * are reading.
   */
  test('the diff and the change line say which of four states', () => {
    const w = world('four-printed', {
      local: '{\n  "skillOverrides": {\n    "s-01": "name-only"\n  }\n}\n',
    });
    const plan = planned(planToggles(w.ctx, SKILL_AXIS, w.dir, skill('user-invocable-only')));
    const lines = describePlan(plan);

    assert.ok(
      lines.some((l) => l.trim() === 's-01: name-only -> user-invocable-only'),
      `no four-valued change line: ${lines.join(' | ')}`,
    );
    assert.ok(
      lines[0]!.includes('skillOverrides'),
      `the header does not name the key being written: ${lines[0]}`,
    );
    assert.ok(
      lines.some((l) => l.includes('+     "s-01": "user-invocable-only"')),
      `the diff does not carry the new state: ${lines.join(' | ')}`,
    );
    // The effect is `classify`'s own, on this axis too -- a skill is cache-safe.
    assert.equal(planEffect(plan), 'reload');

    /*
     * And the classification was handed the file it is about to write.
     *
     * Asserted rather than left implicit, because it is a hand mutation the rest of the
     * suite does not catch: dropping the `target` for skills leaves 631 tests green.
     * `targetValidity` refuses a discarded target before `classify` is reached, so the
     * two guards never disagree today -- which is exactly why the second one has to be
     * checked here. It is the standing half of "one mechanism, not two", and without it
     * the skill axis silently stops depending on the target's validity the next time
     * that refusal is narrowed.
     */
    const staged = plan.changes[0]!.effect.change;
    assert.equal(staged.kind, 'skill');
    assert.ok(
      staged.kind === 'skill' && staged.target?.source === plan.target,
      `the skill change named no target: ${JSON.stringify(staged)}`,
    );

    // And the plugin axis still prints its own domain rather than the skill words.
    const p = world('four-printed-plugin');
    const pluginPlan = planned(planToggles(p.ctx, PLUGIN_AXIS, p.dir, on()));
    assert.ok(
      describePlan(pluginPlan).some((l) => l.trim() === 'p@m: false -> true'),
      `the plugin change line changed shape: ${describePlan(pluginPlan).join(' | ')}`,
    );
    assert.equal(showValue(true), 'true');
    assert.equal(showValue('name-only'), 'name-only');
  });
});

/**
 * QM-43's `round-trip`, reached by the write this axis makes first.
 *
 * `qm set` targets `settings.local.json`, so setting a skill against a value the repo's
 * tracked `settings.json` already sets produces exactly the chain `skill-04` carries in
 * the differential fixture: `project = off`, `local = on`, no user link. The resolved
 * value lands on the `on` fallback and the local entry is the entire reason it does.
 *
 * A note and not a refusal, and its last clause **names the link** rather than describing
 * it (QM-46). It used to end "because the repo's tracked settings.json says so", which
 * QM-45 checked and found true on the settings axes -- `contributingFiles` admits exactly
 * two project-scope files -- and which is false on the MCP axis, where the disagreeing link
 * is a `.mcp.json` declaration. So the note reads the source off the chain, and the
 * assertions below pin the path rather than the phrase.
 */
describe('a skills write over the repo\'s own settings.json', () => {
  test('carries the round-trip note, and the note names the skill axis', () => {
    const w = world('skill-round-trip', {
      projectSettings: '{\n  "skillOverrides": {\n    "s-01": "off"\n  }\n}\n',
    });
    const plan = planned(planToggles(w.ctx, SKILL_AXIS, w.dir, skill('on')));

    assert.equal(plan.changes[0]!.from, 'off');
    assert.equal(plan.changes[0]!.to, 'on');

    const note = plan.notes.find((n) => n.code === 'would-restate');
    assert.ok(note, `no would-restate note: ${plan.notes.map((n) => n.code).join(', ')}`);
    assert.match(note.message, /without it the skill resolves off/);
    assert.ok(
      note.message.endsWith(`because ${join(w.dir, '.claude', 'settings.json')} says so.`),
      `the note did not name the link that disagrees: ${note.message}`,
    );
    assert.doesNotMatch(note.message, /plugin/);
  });

  test('and the same shape on the plugin axis still says plugin', () => {
    const w = world('plugin-round-trip', {
      user: { enabledPlugins: { 'p@m': true } },
      projectSettings: '{\n  "enabledPlugins": {\n    "p@m": false\n  }\n}\n',
    });
    const plan = planned(planToggles(w.ctx, PLUGIN_AXIS, w.dir, on()));
    const note = plan.notes.find((n) => n.code === 'would-restate');
    assert.ok(note, 'no would-restate note on the plugin axis');
    assert.match(note.message, /without it the plugin resolves false/);
  });
});

// ---------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------

/**
 * `on` and everything else, which is what a boolean axis can say about four states.
 *
 * The collapse is written as a real (wrong) axis rather than as an edit to `src/`, so it
 * ships: the gate runs the whole scenario table against it and every skill row must still
 * answer what it answers today, or the mutation is caught.
 */
const booleanised = (value: EntryValue): EntryValue => value === 'on' || value === true;

const COLLAPSED_SKILL_AXIS: Axis = {
  ...SKILL_AXIS,
  fallback: booleanised(SKILL_AXIS.fallback),
  resolve: (ws, p, id) => {
    const cell = SKILL_AXIS.resolve(ws, p, id);
    return {
      value: booleanised(cell.value),
      origin: cell.origin,
      chain: cell.chain.map((l) => ({ ...l, value: booleanised(l.value) })),
    };
  },
  spellings: new Map<string, EntryValue>(
    [...SKILL_AXIS.spellings].map(([k, v]) => [k, booleanised(v)]),
  ),
};

/**
 * `noChange`, asked the wrong question.
 *
 * Each is a whole replacement check rather than a flag, because that is the shape the
 * defect would really take -- somebody rewriting the comparison, not toggling one. The
 * regex is what makes each one a gate rather than a coin flip: a mutation that reddens
 * the table for some other reason has not proved the guard it claims to.
 */
interface CheckMutation {
  name: string;
  check: PlanCheck;
  names: RegExp;
}

const CHECK_MUTATIONS: CheckMutation[] = [
  {
    /**
     * The pair swapped for the one that is equal by construction. `after` is resolved
     * from a chain whose winning link *is* the request, so this refuses every write on
     * both axes -- the loudest possible version of the defect and the one a reviewer
     * would catch by hand. It is here so the harness is known to fire at all.
     */
    name: 'compare the requested value against the value it would resolve to after',
    check: {
      name: 'no-change',
      run: ({ requests, resolved }) =>
        requests
          .filter((r) => Object.is(resolved.get(r.id)?.after.value, r.value))
          .map((r) => ({ code: 'no-change' as const, message: `${r.id}`, evidence: [] })),
    },
    names: /^a skill moved between two non-default states: expected planned, got no-change$/,
  },
  {
    /**
     * "Is it already the default." True of a `name-only` skill being set to `off` -- both
     * are not-`on` -- and false of one being set from `off` to `on`, so it refuses
     * exactly the writes that move between two configured states while letting the
     * uninteresting ones through.
     */
    name: 'compare the requested value against the axis fallback',
    check: {
      name: 'no-change',
      run: ({ axis, requests }) =>
        requests
          .filter((r) => Object.is(r.value, axis.fallback))
          .map((r) => ({ code: 'no-change' as const, message: `${r.id}`, evidence: [] })),
    },
    // Named on the skill row and not on the plugin one it also reddens: this mutation is
    // about the *four* states, and a regex a boolean row could satisfy would pass on a
    // build where only the plugin axis had regressed.
    names: /^a skill asked for the state the target already sets: expected no-change, got planned$/,
  },
  {
    /**
     * The comparison as it would be written by someone who had generalised the types and
     * not the question: `!==` against a boolean, which is what `state.now.value !== req.enable`
     * becomes when `enable` grows a string domain. Every skill value is `!==` every
     * boolean, so no skill write is ever refused.
     */
    name: 'compare the resolved value against a boolean reading of the request',
    check: {
      name: 'no-change',
      run: ({ requests, resolved, target }) =>
        requests
          .filter((r) => resolved.get(r.id)?.now.value === (r.value === 'on' || r.value === true))
          .map((r) => ({
            code: 'no-change' as const,
            message: `${r.id}`,
            evidence: [target],
          })),
    },
    names: /^a skill asked for the (value an unmentioned skill already has|state the target already sets): expected no-change, got planned$/,
  },
];

describe('the gate fails when four values become two', () => {
  test('the whole table still answers the way it must', () => {
    const failures = runGate(CHECKS);
    assert.deepEqual(failures, [], report(failures));
    console.log(
      `    toggle: ${SCENARIOS.length} scenarios over ${CHECKS.length} checks, ` +
        `${SCENARIOS.filter((s) => s.axis === SKILL_AXIS).length} of them on the skill axis`,
    );
  });

  test('collapsing the skill axis onto a boolean reddens the gate', () => {
    const failures = runGate(CHECKS, {
      target: SKILL_AXIS,
      axis: COLLAPSED_SKILL_AXIS,
      value: booleanised,
    });
    assert.ok(
      failures.length > 0,
      'a boolean skill axis cost nothing — that is a hole in the gate, not a mutation to delete',
    );
    assert.ok(
      failures.some((f) =>
        /^a skill moved between two non-default states: expected planned, got no-change$/.test(f),
      ),
      `the gate failed, but not on the pair with no boolean image: ${report(failures)}`,
    );
    // And the plugin rows are untouched, so the failure is about the mutation and not
    // about the harness having swapped something global.
    assert.equal(
      failures.some((f) => f.startsWith('a fresh project gets a new file')),
      false,
      `the collapse leaked onto the plugin axis: ${report(failures)}`,
    );
    console.log(`    caught the collapse (${failures.length}): ${failures[0]}`);
  });

  for (const mutation of CHECK_MUTATIONS) {
    test(`no-change: ${mutation.name}`, () => {
      const failures = runGate(CHECKS.map((c) => (c.name === 'no-change' ? mutation.check : c)));
      assert.ok(
        failures.length > 0,
        `"${mutation.name}" cost nothing — that is a hole in the gate, not a mutation to delete`,
      );
      assert.ok(
        failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${report(failures)}`,
      );
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }
});
