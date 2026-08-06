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
 *     matters, so it is the test that earns its keep -- `rest` exists to hold exactly
 *     such fields.
 *  3. Every pair the resolver decides still appears, with the same value and the same
 *     origin. A redaction that quietly drops rows is not safer, it is wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
import { loadWorkspace } from '../src/surfaces/read.ts';
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
  rest: {},
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

/** Every unrecognised key any settings file carried, and every string under them. */
function restKeysAndValues(ws: Workspace): { keys: string[]; values: string[] } {
  const keys: string[] = [];
  const values: string[] = [];

  const collect = (v: unknown): void => {
    if (typeof v === 'string') return void (v.length >= 8 && values.push(v));
    if (Array.isArray(v)) return void v.forEach(collect);
    if (v && typeof v === 'object') for (const child of Object.values(v)) collect(child);
  };

  const files = [ws.userSettings, ...ws.projects.flatMap((p) => [p.settings, p.localSettings])];
  for (const f of files) {
    if (!f) continue;
    for (const [k, v] of Object.entries(f.rest)) {
      keys.push(k);
      collect(v);
    }
  }
  return { keys, values };
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
 */
describe('a field nobody has heard of still does not reach the wire', () => {
  const CANARY_KEY = 'qmCanaryUnknownSetting';
  const CANARY_REST = 'CANARY-rest-value-8f21c0';
  const CANARY_ENV = 'sk-live-CANARY-env-4a77b1';
  const CANARY_HEADER = 'Bearer CANARY-header-93de55';
  const CANARY_NESTED = 'CANARY-nested-inside-an-object-0c19';

  const user = settings('/home/.claude/settings.json', {
    enabledPlugins: { 'alpha@market': true },
    rest: {
      [CANARY_KEY]: CANARY_REST,
      // Keys that shadow the view's own field names. A projection is indifferent to
      // this; anything that merged `rest` in would publish them.
      value: CANARY_NESTED,
      source: '/home/somewhere/private/path.json',
    },
  });

  const repo = project('/home/work/repo', {
    settings: settings('/home/work/repo/.claude/settings.json', {
      enabledPlugins: { 'alpha@market': false },
      rest: { [CANARY_KEY]: { nested: { deeper: CANARY_NESTED } } },
    }),
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

  for (const canary of [CANARY_REST, CANARY_ENV, CANARY_HEADER, CANARY_NESTED]) {
    test(`the payload does not contain ${canary.slice(0, 14)}…`, () => {
      assert.ok(!serialised.includes(canary), serialised);
    });
  }

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

  test('nothing from rest appears, by key or by value', { skip: !available && 'no live workspace' }, () => {
    const { keys, values } = restKeysAndValues(ws!);
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
