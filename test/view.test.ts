/**
 * The redaction boundary, and the guarantee that it is a projection rather than a
 * filter.
 *
 * Three things are being proved here, in ascending order of what they are worth:
 *
 *  1. Nothing sensitive reaches the wire on the workspace this machine actually has,
 *     and on the committed fixture, which is a real workspace with its names swapped.
 *     Measured over the whole output, not over the one cell that motivated the rule.
 *  2. Nothing sensitive reaches the wire when a field nobody here has heard of appears
 *     upstream. That is the case a strip list passes today and fails the day it
 *     matters, so it is the test that earns its keep. Its input is a settings file on
 *     disk carrying keys no reader names (QM-30), read through the real `readSettings` --
 *     so both barriers are in the picture, and the block gates each: the reader keeps
 *     nothing it does not name, and the projection publishes nothing it does not name.
 *  3. Every pair the resolver decides still appears, with the same value and the same
 *     origin. A redaction that quietly drops rows is not safer, it is wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  viewFrom,
  sourceDisplays,
  renderSource,
  projectId,
  type GridView,
} from '../src/view/model.ts';
import type { AuditContext } from '../src/detect.ts';
import { NOT_CHECKED, loadWorkspace, readSettings } from '../src/surfaces/read.ts';
import { measureProject } from '../src/cost/transcript.ts';
import { allPluginIds } from '../src/resolve.ts';
import { allMcpServerNames, buildMcpCatalog } from '../src/mcp.ts';
import { allSkillIds, buildSkillCatalog } from '../src/skills.ts';
import { resolveMcpServer, resolvePlugin, resolveSkill } from '../src/resolve.ts';
import type { Cell } from '../src/model.ts';
import type {
  ClaudeJson,
  McpServerSpec,
  ProjectRecord,
  SettingsFile,
  Workspace,
} from '../src/surfaces/types.ts';
import type { PluginCost } from '../src/cost/plugins.ts';
import { loadFixtureWorkspace } from './fixtures/differential/load.ts';

const settings = (path: string, body: Partial<SettingsFile> = {}): SettingsFile => ({
  path,
  // Nothing here is about validity, and `not-checked` is what resolves the way this
  // file resolved before DEA-147 existed. Never `accepted` -- these files were not checked.
  validity: 'not-checked',
  schemaErrors: [],
  droppedRuleElements: {},
  ...body,
});

// Duplicated on purpose (DEA-137): this copy feeds the fails-open allowlist sweep
// below, whose control is the per-file edit cost -- do not point it at ./factories.ts.
const project = (path: string, body: Partial<ProjectRecord> = {}): ProjectRecord => ({
  path,
  alive: true,
  registered: true,
  settings: null,
  localSettings: null,
  mcpJson: null,
  entry: null,
  rules: [],
  memory: null,
  claudeMd: null,
  ...body,
});

const claudeJson = (body: Partial<ClaudeJson> = {}): ClaudeJson => ({
  path: '/home/.claude.json',
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
  ...body,
});

function ctxOf(ws: Partial<Workspace>, extra: Partial<AuditContext> = {}): AuditContext {
  return {
    ws: {
      home: '/home',
      userSettings: null,
      userRules: [],
      personalSkills: [],
      claudeJson: claudeJson(),
      projects: [],
      ...ws,
    },
    measurements: [],
    pluginCosts: new Map(),
    inventories: new Map(),
    ...extra,
  };
}

/**
 * Every key the view is allowed to publish, written out here rather than imported.
 *
 * Imported, this asserts that the module agrees with itself. Written here, a field that
 * appears in the output without anyone deciding it should fails the suite, and adding
 * one legitimately costs an edit in a file called `view.test.ts`. That is the whole
 * mechanism: the allowlist is only worth something if widening it is deliberate.
 */
const ALLOWED_KEYS = new Set([
  // GridView
  'projects', 'plugins', 'mcpServers', 'skills',
  // ViewProject / ProjectCost / ViewDistribution
  'id', 'label', 'cost', 'sessions', 'baselineChars',
  'samples', 'min', 'p25', 'median', 'p75', 'p95', 'max',
  // ExtensionRow / ViewCell / ViewChainLink
  'kind', 'cells', 'project', 'value', 'origin', 'chain', 'scope', 'source',
  // ExtensionCost
  'alwaysOnTokens', 'components', 'name', 'count', 'mcpUncounted',
]);

interface Scan {
  strings: string[];
  keys: Set<string>;
}

/** Everything in the serialised payload, walked without knowing its shape. */
function scan(view: GridView): Scan {
  const out: Scan = { strings: [], keys: new Set() };

  const walk = (v: unknown): void => {
    if (typeof v === 'string') return void out.strings.push(v);
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        out.keys.add(k);
        walk(child);
      }
    }
  };

  // Through JSON deliberately: what a socket would send, not what the object holds.
  walk(JSON.parse(JSON.stringify(view)));
  return out;
}

/** Absolute-looking, on either the POSIX or the Windows spelling. */
function looksAbsolute(s: string): boolean {
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.includes('/Users/') || s.includes('/home/');
}

/** Credential-bearing values as they sit in the workspace, for a substring sweep. */
function secretValues(ws: Workspace): string[] {
  const out: string[] = [];
  const fromSpecs = (specs: Record<string, McpServerSpec>) => {
    for (const spec of Object.values(specs)) {
      out.push(...Object.values(spec.env ?? {}), ...Object.values(spec.headers ?? {}));
    }
  };
  fromSpecs(ws.claudeJson.mcpServers);
  for (const p of ws.projects) if (p.mcpJson) fromSpecs(p.mcpJson.mcpServers);
  // Short values are not credentials and match everything: `"1"` as an env value would
  // hit half the output on substring alone.
  return out.filter((v) => typeof v === 'string' && v.length >= 8);
}

/**
 * The keys `readSettings` models, written out here rather than imported (QM-30).
 *
 * Imported, the sweep below would ask the reader what "unknown" means, and a reader that
 * quietly stopped naming a key would take the sweep with it. Written here, the two halves
 * are independent -- and naming too *few* is the safe way to be wrong: the sweep then
 * covers a key the payload publishes legitimately and fails loudly, where naming too many
 * drops a key out of the sweep in silence.
 */
const MODELLED_SETTINGS_KEYS = new Set([
  'enabledPlugins',
  'skillOverrides',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'permissions',
]);

/**
 * Every key a settings file carries that no reader names, and every string under one.
 *
 * Read off the *file*, not off the `SettingsFile` built from it. Until QM-30 the reader
 * kept an unbounded `rest` bag and this swept that -- which is asking the reader what it
 * threw away, and a bag holds only what the thing filling it put in. The file is the other
 * half of the fact, and the half nothing in `src/` decides.
 */
function unmodelledKeysAndValues(paths: readonly string[]): { keys: string[]; values: string[] } {
  const keys: string[] = [];
  const values: string[] = [];

  const collect = (v: unknown): void => {
    if (typeof v === 'string') return void (v.length >= 8 && values.push(v));
    if (Array.isArray(v)) return void v.forEach(collect);
    if (v && typeof v === 'object') for (const child of Object.values(v)) collect(child);
  };

  for (const path of paths) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Unreadable or not JSON. `readSettings` returned null for it too, so it is not in
      // the model either, and there is nothing here for the payload to have leaked.
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    for (const [k, v] of Object.entries(raw)) {
      if (MODELLED_SETTINGS_KEYS.has(k)) continue;
      keys.push(k);
      collect(v);
    }
  }
  return { keys, values };
}

/** The path of every settings file a workspace read. */
function settingsPaths(ws: Workspace): string[] {
  return [ws.userSettings, ...ws.projects.flatMap((p) => [p.settings, p.localSettings])]
    .filter((f): f is SettingsFile => f !== null)
    .map((f) => f.path);
}

/**
 * Separator for the composite map keys below.
 *
 * The three parts are joined rather than nested because the comparison is a flat
 * set-equality over every pair, and the separator has to be a character no part can
 * contain -- an id holding it would collide two different pairs onto one key and hide
 * exactly the loss this file exists to catch.
 *
 * A literal NUL satisfied that and cost more than it was worth: grep, ripgrep and every
 * tool built on them classify a file containing one as binary and drop it from results
 * **without saying so**. This file was silently omitted from three separate sweeps in one
 * session -- see DEA-137 and DEA-141 -- each of which returned a clean, plausible,
 * incomplete answer. U+001F INFORMATION SEPARATOR ONE is the character the job asks for,
 * and written as an escape it keeps this file pure ASCII, so no tool has to have an
 * opinion about it.
 */
const KEY_SEP = '\u001F';

/** The pairs the resolver decides, derived without going through the view. */
function referencePairs(ctx: AuditContext): Map<string, Cell<unknown>> {
  const { ws } = ctx;
  const catalog = buildSkillCatalog(ws, ctx.measurements, ctx.inventories);
  const mcpCatalog = buildMcpCatalog(ws, ctx.inventories);
  const out = new Map<string, Cell<unknown>>();
  const live = ws.projects.filter((p) => p.alive);
  const add = (kind: string, id: string, p: ProjectRecord, cell: Cell<unknown>) =>
    out.set(`${kind}${KEY_SEP}${id}${KEY_SEP}${projectId(p.path)}`, cell);

  for (const p of live) {
    for (const id of allPluginIds(ws, ctx.inventories)) add('plugin', id, p, resolvePlugin(ws, p, id));
    for (const id of allMcpServerNames(mcpCatalog)) add('mcp', id, p, resolveMcpServer(ws, p, id));
    for (const id of allSkillIds(catalog)) add('skill', id, p, resolveSkill(ws, p, id));
  }
  return out;
}

function viewPairs(view: GridView): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of [...view.plugins, ...view.mcpServers, ...view.skills]) {
    for (const cell of row.cells) out.set(`${row.kind}${KEY_SEP}${row.id}${KEY_SEP}${cell.project}`, cell);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('source display form', () => {
  const home = '/Users/x';
  const userSettings = settings('/Users/x/.claude/settings.json');
  const repo = project('/Users/x/code/repo', {
    settings: settings('/Users/x/code/repo/.claude/settings.json'),
    localSettings: settings('/Users/x/code/repo/.claude/settings.local.json'),
    mcpJson: { path: '/Users/x/code/repo/.mcp.json', mcpServers: {} },
  });
  const ws: Workspace = {
    home,
    userSettings,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson({ path: '/Users/x/.claude.json' }),
    projects: [repo],
  };

  test('each file the resolver can name has a form, and it carries no prefix', () => {
    assert.deepEqual(
      [...sourceDisplays(ws, repo).values()],
      [
        '~/.claude/settings.json',
        // `~/.claude.json` holds project-scoped decisions. Writing it as `<project>/`
        // would hide the one surface easiest to forget is not in the project.
        '~/.claude.json',
        '<project>/.claude/settings.json',
        '<project>/.claude/settings.local.json',
        '<project>/.mcp.json',
      ],
    );
  });

  test('a project under the home directory does not spell out its path', () => {
    for (const display of sourceDisplays(ws, repo).values()) {
      assert.ok(!display.includes('code'), `intermediate directories are the leak: ${display}`);
      assert.ok(!display.startsWith('/'), display);
    }
  });

  test('the home project resolves its settings file to the user form', () => {
    // `~` is registered as a project and its `.claude/settings.json` *is* the user-scope
    // file. One file, two scopes -- and the user form is the true one.
    const homeProject = project(home, { settings: userSettings });
    assert.equal(
      sourceDisplays({ ...ws, projects: [homeProject] }, homeProject).get(userSettings.path),
      '~/.claude/settings.json',
    );
  });

  test('a file the table does not name prints no path at all', () => {
    const rendered = renderSource('/Library/Managed/managed-settings.json', new Map());
    assert.ok(!rendered.includes('/'), rendered);
    assert.ok(!rendered.includes('managed-settings'), rendered);
    // And the table is what decides, so an unnamed file is unnamed for every project.
    assert.equal(sourceDisplays(ws, repo).get('/Library/Managed/managed-settings.json'), undefined);
  });
});

describe('the home project does not publish the account name', () => {
  test('label is ~ rather than the home directory basename', () => {
    const view = viewFrom(ctxOf({ home: '/Users/someone', projects: [project('/Users/someone')] }));
    assert.deepEqual(view.projects.map((p) => p.label), ['~']);
  });

  test('and is recognised by its settings file when the paths were rebased', () => {
    // What a replayed fixture looks like: the recorded project path is not the directory
    // the files were read from, so the equality against `home` cannot fire.
    const userSettings = settings('/elsewhere/home/.claude/settings.json');
    const view = viewFrom(
      ctxOf({
        home: '/elsewhere/home',
        userSettings,
        projects: [project('/Users/recorded', { settings: userSettings })],
      }),
    );
    assert.deepEqual(view.projects.map((p) => p.label), ['~']);
  });
});

/**
 * The fails-open case. A key nobody named and a credential nobody named, planted where
 * the model keeps exactly those, and then the whole payload swept for them.
 *
 * **Where the settings half is planted, since QM-30.** It used to be a hand-built
 * `SettingsFile.rest`, and a hand-built bag can only hold what its type permits. It is a
 * committed settings file now, read through the real `readSettings`, which buys two things
 * the object literal could not. The keys are whatever JSON allows -- including `path`, one
 * of `SettingsFile`'s *own* field names, unplantable while the bag was typed. And the
 * reader is inside the test rather than upstream of it, so the two barriers are both in
 * frame and each has its own gate below: `readSettings` keeps nothing it does not name,
 * `viewFrom` publishes nothing it does not name. Either alone would hold today; the sweep
 * is over the composition, which is the property a browser actually gets.
 *
 * The credential half stays hand-built. `env` and `headers` are *modelled* fields -- the
 * reader is supposed to carry them, and does -- so a fixture would prove nothing extra.
 */
describe('a field nobody has heard of still does not reach the wire', () => {
  const FIXTURE = join(import.meta.dirname, 'fixtures', 'settings', 'unknown-keys');
  const CANARY_KEY = 'qmCanaryUnknownSetting';
  const CANARY_REST = 'CANARY-rest-value-8f21c0';
  const CANARY_ENV = 'sk-live-CANARY-env-4a77b1';
  const CANARY_HEADER = 'Bearer CANARY-header-93de55';
  const CANARY_NESTED = 'CANARY-nested-inside-an-object-0c19';
  /**
   * The shadowing keys are planted at *both* scopes, and the project copy has its own
   * values so a failure says which file leaked.
   *
   * Found by mutation, not by design. A projection that took `value` off the settings file
   * reads one file per column -- `record.settings`, never the user's -- so with the shadows
   * planted only at user scope the mutation picked up nothing and the sweep stayed green.
   * A canary that cannot be reached from where the bug would be is not a canary.
   */
  const CANARY_SHADOW_VALUE = 'CANARY-shadowing-value-at-project-scope-5e7a';
  const CANARY_SHADOW_SOURCE = '/home/work/repo/private/CANARY-shadowing-source-3f81.json';

  const fixtureSettings = (name: string): SettingsFile => {
    const file = readSettings(join(FIXTURE, name), NOT_CHECKED);
    assert.ok(file, `the canary fixture is unreadable: ${name}`);
    return file;
  };

  const user = fixtureSettings('user-settings.json');
  const repoSettings = fixtureSettings('project-settings.json');
  const planted = unmodelledKeysAndValues([user.path, repoSettings.path]);

  const repo = project('/home/work/repo', {
    settings: repoSettings,
    mcpJson: {
      path: '/home/work/repo/.mcp.json',
      mcpServers: {
        billing: {
          command: 'node',
          env: { API_TOKEN: CANARY_ENV },
          headers: { Authorization: CANARY_HEADER },
        },
      },
    },
  });

  const view = viewFrom(
    ctxOf({
      projects: [repo],
      userSettings: user,
      claudeJson: claudeJson({
        mcpServers: { hosted: { url: 'https://example.test', headers: { Authorization: CANARY_HEADER } } },
      }),
    }),
  );
  const found = scan(view);
  const serialised = JSON.stringify(view);

  /**
   * A canary nobody can see is a canary nobody notices losing.
   *
   * Every sweep below is a filter over a set, and a filter over an empty set passes. So
   * the shapes this block is worth running for are pinned as literals here, against a set
   * derived from the fixture on disk -- editing the fixture cannot quietly disarm the
   * sweeps, and the sweeps cover whatever else the fixture grows.
   */
  test('the fixture still plants what this block sweeps for', () => {
    for (const key of [CANARY_KEY, 'value', 'source', 'path']) {
      assert.ok(planted.keys.includes(key), `${key} is no longer planted: ${planted.keys.join(', ')}`);
    }
    for (const value of [CANARY_REST, CANARY_NESTED, CANARY_SHADOW_VALUE, CANARY_SHADOW_SOURCE]) {
      assert.ok(planted.values.includes(value), `${value} is no longer planted`);
    }
  });

  /**
   * The first barrier, which is the one QM-30 made load-bearing.
   *
   * While `rest` existed the reader carried every unknown key into the model on purpose,
   * and only the projection stood between one and a browser. The reader is a projection
   * too now, and this is its allowlist -- named here for `ALLOWED_KEYS`' reason, so a
   * field appearing on `SettingsFile` costs an edit in a file that explains the boundary.
   *
   * `path` is the sharp one: the fixture sets a top-level `path`, so a reader that spread
   * the raw document over its own fields would answer with the canary instead of the file
   * it was asked about -- which `sourceDisplays` looks up by identity and would silently
   * miss.
   */
  test('the reader keeps no key it does not name', () => {
    const modelled = new Set([
      'path', 'validity', 'schemaErrors', 'droppedRuleElements',
      ...MODELLED_SETTINGS_KEYS,
    ]);
    for (const file of [user, repoSettings]) {
      assert.deepEqual(Object.keys(file).filter((k) => !modelled.has(k)), [], file.path);
    }
    assert.equal(user.path, join(FIXTURE, 'user-settings.json'));
  });

  for (const canary of [CANARY_REST, CANARY_ENV, CANARY_HEADER, CANARY_NESTED]) {
    test(`the payload does not contain ${canary.slice(0, 14)}…`, () => {
      assert.ok(!serialised.includes(canary), serialised);
    });
  }

  test('nor anything else the fixture planted, by key or by value', () => {
    assert.ok(planted.values.length >= 3, 'the fixture planted nothing to sweep for');
    assert.deepEqual(planted.values.filter((v) => serialised.includes(v)), []);
    // Filtered against the allowlist because two of the planted keys collide with the
    // view's own field names on purpose: `value` and `source` are legitimate payload keys,
    // and what must not be theirs is the fixture's *values*, swept on the line above.
    assert.deepEqual(planted.keys.filter((k) => found.keys.has(k) && !ALLOWED_KEYS.has(k)), []);
  });

  test('the unrecognised key is not a key of the payload', () => {
    assert.ok(!found.keys.has(CANARY_KEY));
    assert.deepEqual([...found.keys].filter((k) => !ALLOWED_KEYS.has(k)), []);
  });

  test('no absolute path survives', () => {
    assert.deepEqual(found.strings.filter(looksAbsolute), []);
  });

  test('what the grid needs did survive', () => {
    // The point of projecting rather than filtering is that the useful half is intact.
    const row = view.plugins.find((r) => r.id === 'alpha@market');
    assert.ok(row, 'the plugin row is missing');
    const cell = row.cells[0]!;
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'overridden');
    assert.deepEqual(
      cell.chain.map((l) => l.source),
      ['~/.claude/settings.json', '<project>/.claude/settings.json'],
    );
    assert.deepEqual(cell.chain.map((l) => l.value), [true, false]);
    assert.deepEqual(view.mcpServers.map((r) => r.id).sort(), ['billing', 'hosted']);
  });
});

describe('which projects become columns', () => {
  const user = settings('/home/.claude/settings.json', { enabledPlugins: { a: true } });
  const live = project('/home/live');
  const dead = project('/home/gone', { alive: false });

  test('a directory that no longer exists gets no column', () => {
    const view = viewFrom(ctxOf({ userSettings: user, projects: [live, dead] }));
    assert.deepEqual(view.projects.map((p) => p.label), ['live']);
    assert.equal(view.plugins[0]!.cells.length, 1);
  });

  test('a scoped run projects its own project and no other', () => {
    const other = project('/home/other');
    const view = viewFrom(
      ctxOf({ userSettings: user, projects: [live, other] }, { scope: '/home/other' }),
    );
    assert.deepEqual(view.projects.map((p) => p.label), ['other']);
    assert.deepEqual(
      view.plugins[0]!.cells.map((c) => c.project),
      [projectId('/home/other')],
    );
  });
});

describe('both axes survive', () => {
  const SKILL = 'gsd-help';

  for (const value of ['on', 'name-only', 'user-invocable-only', 'off'] as const) {
    test(`${value} at project scope keeps its own value and its own origin`, () => {
      const user = settings('/home/.claude/settings.json', { skillOverrides: { [SKILL]: 'on' } });
      const p = project('/home/p', {
        settings: settings('/home/p/.claude/settings.json', { skillOverrides: { [SKILL]: value } }),
      });
      const view = viewFrom(ctxOf({ userSettings: user, projects: [p] }));
      const cell = view.skills.find((r) => r.id === SKILL)!.cells[0]!;

      assert.equal(cell.value, value);
      assert.equal(cell.origin, value === 'on' ? 'restated' : 'overridden');
      assert.deepEqual(cell.chain.map((l) => l.scope), ['user', 'project']);
    });
  }
});

describe('per-extension cost is projected, not passed through', () => {
  const priced: PluginCost = {
    id: 'alpha@market',
    version: '1.2.3',
    // A locally-installed marketplace puts a filesystem path here.
    source: '/home/marketplaces/private-market',
    alwaysOnTokens: 2700,
    components: [{ name: 'thing', alwaysOn: 700, onInvoke: 0 }],
    counts: { Skills: 3, Hooks: 0 },
    mcpServers: ['billing'],
    mcpUncounted: true,
  };

  const view = viewFrom(
    ctxOf(
      {
        userSettings: settings('/home/.claude/settings.json', {
          enabledPlugins: { 'alpha@market': true },
        }),
        projects: [project('/home/p')],
      },
      { pluginCosts: new Map([['alpha@market', priced]]) },
    ),
  );

  test('the figures the grid needs are there', () => {
    const cost = view.plugins[0]!.cost!;
    assert.equal(cost.alwaysOnTokens, 2700);
    assert.equal(cost.mcpUncounted, true);
    assert.deepEqual(cost.components, [
      { name: 'Skills', count: 3 },
      { name: 'Hooks', count: 0 },
    ]);
  });

  test('the Source line, which can be a path, is not', () => {
    assert.ok(!JSON.stringify(view).includes('private-market'));
  });

  test('an unpriced plugin reads as unknown rather than free', () => {
    const unpriced = viewFrom(
      ctxOf({
        userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { b: true } }),
        projects: [project('/home/p')],
      }),
    );
    assert.equal(unpriced.plugins[0]!.cost, null);
  });
});

/**
 * The fixture is a real workspace with its names swapped, committed so this runs
 * everywhere. 66 project entries, and the pair count is the whole point of asserting
 * over it rather than over three hand-written projects.
 */
describe('the committed workspace fixture', () => {
  const ws = loadFixtureWorkspace();
  const fixtureCtx = ctxOf(ws);
  const view = viewFrom(fixtureCtx);
  const found = scan(view);

  test('every resolved pair is present, with the same value and origin', () => {
    const expected = referencePairs(fixtureCtx);
    const actual = viewPairs(view);

    assert.ok(expected.size > 0, 'the fixture resolved no pairs');
    assert.equal(actual.size, expected.size, 'the view lost or invented pairs');

    for (const [key, cell] of expected) {
      const got = actual.get(key) as { value: unknown; origin: string; chain: unknown[] } | undefined;
      assert.ok(got, `missing pair: ${key.replaceAll(KEY_SEP, ' ')}`);
      assert.equal(got.value, cell.value, key);
      assert.equal(got.origin, cell.origin, key);
      assert.equal(got.chain.length, cell.chain.length, key);
    }
  });

  test('the chain keeps its scopes in order and loses only the prefix', () => {
    const ws2 = loadFixtureWorkspace();
    const live = ws2.projects.filter((p) => p.alive);
    let checked = 0;
    for (const row of view.plugins) {
      for (const p of live) {
        const model = resolvePlugin(ws2, p, row.id);
        const cell = row.cells.find((c) => c.project === projectId(p.path))!;
        assert.deepEqual(cell.chain.map((l) => l.scope), model.chain.map((l) => l.scope));
        for (const [i, link] of cell.chain.entries()) {
          assert.equal(link.value, model.chain[i]!.value);
          assert.ok(!looksAbsolute(link.source), link.source);
          // The filename survives; the directories above it do not.
          assert.ok(link.source.endsWith(model.chain[i]!.source.split('/').at(-1)!), link.source);
          checked++;
        }
      }
    }
    assert.ok(checked > 0, 'no chain links to check');
  });

  test('no absolute path, and no fixture home, anywhere in the payload', () => {
    assert.deepEqual(found.strings.filter(looksAbsolute), []);
    assert.deepEqual(found.strings.filter((s) => s.includes('testuser')), []);
  });

  test('every key is one this file names', () => {
    assert.deepEqual([...found.keys].filter((k) => !ALLOWED_KEYS.has(k)), []);
  });
});

/**
 * The workspace this machine actually has.
 *
 * The fixture was anonymised by hand once; only real config carries the shapes nobody
 * thought to write down. Skipped where there is none -- CI has no `~/.claude.json` --
 * which is why the fixture block above is not conditional.
 */
describe('the live workspace', () => {
  const home = homedir();
  const available = existsSync(join(home, '.claude.json'));
  const ws = available ? loadWorkspace() : null;

  const liveCtx = ws
    ? ctxOf(ws, {
        measurements: ws.projects
          .filter((p) => p.alive)
          .flatMap((p) => measureProject(home, p.path)),
      })
    : null;
  const built = liveCtx ? viewFrom(liveCtx) : null;
  const found = built ? scan(built) : null;

  test('the scan is not vacuous', { skip: !available && 'no live workspace' }, () => {
    const cells = [...built!.plugins, ...built!.mcpServers, ...built!.skills].reduce(
      (n, r) => n + r.cells.length,
      0,
    );
    assert.ok(built!.projects.length > 0, 'no live projects');
    assert.ok(cells > 0, 'no cells');
    assert.ok(found!.strings.length > 0, 'no strings scanned');
  });

  test('no string in the payload is an absolute path', { skip: !available && 'no live workspace' }, () => {
    assert.deepEqual(found!.strings.filter(looksAbsolute), []);
  });

  test('the home directory appears nowhere', { skip: !available && 'no live workspace' }, () => {
    // Substring, not prefix: a path can be embedded in a longer string.
    assert.deepEqual(found!.strings.filter((s) => s.includes(home)), []);
  });

  test('no env or header value appears', { skip: !available && 'no live workspace' }, () => {
    const secrets = secretValues(ws!);
    const leaked = secrets.filter((v) => found!.strings.some((s) => s.includes(v)));
    assert.deepEqual(leaked, []);
  });

  // The sweep is a filter over a set the *test* assembles now (QM-30), where it used to
  // read a field off the workspace -- so an empty set is a new way for this to pass
  // without looking. Measured by mutation: pointing it at no paths left all 37 green.
  test('no key a settings file carries that no reader names appears, by key or by value', { skip: !available && 'no live workspace' }, (t) => {
    const paths = settingsPaths(ws!);
    if (!paths.length) return t.skip('no settings files on this machine');
    const { keys, values } = unmodelledKeysAndValues(paths);
    assert.deepEqual(keys.filter((k) => found!.keys.has(k) && !ALLOWED_KEYS.has(k)), []);
    assert.deepEqual(values.filter((v) => found!.strings.some((s) => s.includes(v))), []);
  });

  test('every key is one this file names', { skip: !available && 'no live workspace' }, () => {
    assert.deepEqual([...found!.keys].filter((k) => !ALLOWED_KEYS.has(k)), []);
  });

  test('every resolved pair survives', { skip: !available && 'no live workspace' }, () => {
    const expected = referencePairs(liveCtx!);
    const actual = viewPairs(built!);
    assert.equal(actual.size, expected.size);
    for (const [key, cell] of expected) {
      const got = actual.get(key) as { value: unknown; origin: string } | undefined;
      assert.ok(got, `missing pair: ${key.replaceAll(KEY_SEP, ' ')}`);
      assert.equal(got.value, cell.value, key);
      assert.equal(got.origin, cell.origin, key);
    }
  });

  test('measured sessions land on the project they belong to', { skip: !available && 'no live workspace' }, (t) => {
    const withSessions = built!.projects.filter((p) => p.cost.sessions > 0);
    if (!withSessions.length) return t.skip('no measured sessions on this machine');
    // The slug join is the only place a path is used as a key; if it were wrong every
    // project would read zero.
    assert.ok(withSessions.some((p) => p.cost.baselineChars.samples === p.cost.sessions));
  });
});
