/**
 * The MCP axis.
 *
 * The bug these guard against is the one DEA-134 removed from the skill axis, arriving
 * a second time on a different surface: `allMcpServerNames` enumerated the deny-list, so
 * a server became a row only once someone had scoped it. Measured against the
 * first-party `/mcp` panel, that made the axis close to inverted -- 15 of the 16 servers
 * the panel called live had no row, and the one that did was the one it called disabled.
 *
 * So every case below scopes as little as it can get away with. A test that starts
 * passing because a fixture gained a `disabledMcpServers` entry has stopped testing the
 * defect.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allMcpServerNames,
  buildMcpCatalog,
  countByPresence,
  pluginServerKey,
  type McpCatalog,
} from '../src/mcp.ts';
import { catalogEnumerations, readInventories } from '../src/inventory.ts';
import { resolvePlugin } from '../src/resolve.ts';
import { loadWorkspace, readClaudeJson } from '../src/surfaces/read.ts';
import type { PluginInventory } from '../src/inventory.ts';
import type {
  ClaudeJson,
  McpServerSpec,
  SettingsFile,
  Workspace,
} from '../src/surfaces/types.ts';
import { project } from './factories.ts';

const settings = (path: string, body: Partial<SettingsFile> = {}): SettingsFile => ({
  path,
  rest: {},
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

function workspace(body: Partial<Workspace> = {}): Workspace {
  return {
    home: '/home',
    userSettings: null,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(),
    projects: [],
    ...body,
  };
}

/** A plugin whose catalog entry declares MCP servers and nothing else. */
function inventory(id: string, mcpServerNames: string[]): PluginInventory {
  return {
    id,
    installPath: `/plugins/${id}`,
    version: '1',
    sha: null,
    installed: [],
    enumerated: [
      {
        source: 'plugin-catalog-cache.json',
        names: [],
        skillNames: [],
        mcpServerNames,
        sha: null,
        version: '1',
        fetchedAt: null,
      },
    ],
  };
}

const spec = (): McpServerSpec => ({ type: 'stdio', command: 'x' });

const axisOf = (ws: Workspace, inv: ReadonlyMap<string, PluginInventory> = new Map()): string[] =>
  allMcpServerNames(buildMcpCatalog(ws, inv));

const entryOf = (catalog: McpCatalog, name: string) =>
  catalog.entries.find((e) => e.name === name);

// ---------------------------------------------------------------------------
// The two sources that had to be read off disk before any of this could work
// ---------------------------------------------------------------------------

/**
 * Both keys are spelled as literals, and both literals are somebody else's fact: they
 * are what Claude Code writes into `~/.claude.json` and into `plugin-catalog-cache.json`.
 * Written this way the reader is pinned on a machine that has neither file -- these
 * caught nothing on CI while they lived only in the live block below, which is the shape
 * of the gate that could not fail (DEA-127).
 */
describe('the sources are read off disk', () => {
  test('readClaudeJson keeps claudeAiMcpEverConnected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-mcp-'));
    try {
      const path = join(dir, '.claude.json');
      writeFileSync(
        path,
        JSON.stringify({
          mcpServers: {},
          projects: {},
          claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai raindrop.io'],
        }),
      );
      assert.deepEqual(readClaudeJson(path).claudeAiMcpEverConnected, [
        'claude.ai Gmail',
        'claude.ai raindrop.io',
      ]);

      // A file without the key is an empty list, never undefined: this one is iterated.
      writeFileSync(path, JSON.stringify({ mcpServers: {} }));
      assert.deepEqual(readClaudeJson(path).claudeAiMcpEverConnected, []);

      // And a key holding something else does not become a value that throws downstream.
      writeFileSync(path, JSON.stringify({ claudeAiMcpEverConnected: 'Gmail' }));
      assert.deepEqual(readClaudeJson(path).claudeAiMcpEverConnected, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('catalogEnumerations keeps components.mcpServers', () => {
    const raw = {
      catalog: {
        plugins: {
          'airtable@claude-plugins-official': {
            components: {
              skills: [{ name: 'airtable-cli' }],
              commands: [],
              agents: [],
              mcpServers: ['airtable'],
            },
          },
          // 21 catalogued plugins look like this -- a server and nothing else. The old
          // `if (!names.length) continue` dropped every one of them.
          'context7@claude-plugins-official': {
            components: { skills: [], commands: [], agents: [], mcpServers: ['context7'] },
          },
        },
      },
    };
    const out = catalogEnumerations(raw, 'plugin-catalog-cache.json');

    const airtable = out.get('airtable@claude-plugins-official');
    const context7 = out.get('context7@claude-plugins-official');
    assert.ok(airtable, 'a catalogued plugin got no enumeration at all');
    assert.ok(context7, 'a plugin declaring only an MCP server got no enumeration at all');

    assert.deepEqual(airtable.mcpServerNames, ['airtable']);
    assert.deepEqual(context7.mcpServerNames, ['context7']);

    // A server is not a file under `installPath`, so it must stay out of the list the
    // on-disk mismatch check walks -- there it would report as missing, every time.
    assert.deepEqual(airtable.names, ['airtable-cli']);
    assert.deepEqual(context7.names, []);
  });
});

// ---------------------------------------------------------------------------
// Each source, on its own
// ---------------------------------------------------------------------------

describe('the axis is not the deny-list', () => {
  test('a user-scope server nothing has scoped is a row', () => {
    const ws = workspace({
      projects: [project('/p')],
      claudeJson: claudeJson({ mcpServers: { 'user-srv': spec() } }),
    });
    assert.deepEqual(axisOf(ws), ['user-srv']);
    assert.equal(entryOf(buildMcpCatalog(ws, new Map()), 'user-srv')!.presence, 'available');
  });

  test("a project's own .mcp.json declaration is a row", () => {
    const ws = workspace({
      projects: [
        project('/p', { mcpJson: { path: '/p/.mcp.json', mcpServers: { 'proj-srv': spec() } } }),
      ],
    });
    assert.deepEqual(axisOf(ws), ['proj-srv']);
  });

  /**
   * The connectors. Nothing else on disk names them -- they are declared in claude.ai --
   * so before this key was read, twelve servers the panel called live had no row at all.
   */
  test('a connector named only by claudeAiMcpEverConnected is a row', () => {
    const ws = workspace({
      projects: [project('/p')],
      claudeJson: claudeJson({ claudeAiMcpEverConnected: ['claude.ai Gmail'] }),
    });
    assert.deepEqual(axisOf(ws), ['claude.ai Gmail']);
  });

  /**
   * The circularity, from the other side. The deny-list is still a source, and a name
   * only it carries -- a connector removed from claude.ai, a plugin never installed --
   * must survive, or the fix trades one truncated axis for another.
   */
  test('a name only a deny-list carries is still a row', () => {
    const ws = workspace({
      projects: [project('/p', { entry: { disabledMcpServers: ['legacy-srv'] } })],
    });
    assert.deepEqual(axisOf(ws), ['legacy-srv']);
    assert.equal(entryOf(buildMcpCatalog(ws, new Map()), 'legacy-srv')!.presence, 'scoped-only');
  });

  /**
   * Ten of the differential fixture's dead entries carry a non-empty deny-list. A dead
   * project renders no column, but the name it denies is still a name this workspace has
   * an opinion about, and dropping it would shrink the axis on a machine that has moved
   * a repo.
   */
  test('a dead project\'s deny-list still names rows', () => {
    const ws = workspace({
      projects: [project('/gone', { alive: false, entry: { disabledMcpServers: ['legacy-srv'] } })],
    });
    assert.deepEqual(axisOf(ws), ['legacy-srv']);
  });
});

// ---------------------------------------------------------------------------
// Plugin-provided servers
// ---------------------------------------------------------------------------

/**
 * The config key, spelled the way Claude Code spells it.
 *
 * These strings are literals rather than anything derived here, and they are somebody
 * else's fact: they are the form `disabledMcpServers` entries take on the captured
 * machine. Deriving the expectation from `pluginServerKey` would put the same function
 * on both sides of the comparison, which agrees with itself whatever it does (DEA-133).
 */
describe('the plugin server key', () => {
  test('drops the marketplace and keeps the plugin short name', () => {
    assert.equal(pluginServerKey('figma@claude-plugins-official', 'figma'), 'plugin:figma:figma');
    assert.equal(
      pluginServerKey('airtable@claude-plugins-official', 'airtable'),
      'plugin:airtable:airtable',
    );
    // Plugin name and server name differ, and the key carries both.
    assert.equal(
      pluginServerKey('chrome-devtools-mcp@claude-plugins-official', 'chrome-devtools'),
      'plugin:chrome-devtools-mcp:chrome-devtools',
    );
    // A local plugin with no marketplace half is not mangled into one.
    assert.equal(pluginServerKey('local-plugin', 'srv'), 'plugin:local-plugin:srv');
  });

  test('a plugin-provided server and its deny-list entry are one row, not two', () => {
    const ws = workspace({
      projects: [
        project('/p', {
          settings: settings('/p/.claude/settings.json', {
            enabledPlugins: { 'figma@claude-plugins-official': true },
          }),
          entry: { disabledMcpServers: ['plugin:figma:figma'] },
        }),
      ],
    });
    const inv = new Map([
      ['figma@claude-plugins-official', inventory('figma@claude-plugins-official', ['figma'])],
    ]);
    assert.deepEqual(axisOf(ws, inv), ['plugin:figma:figma']);
  });
});

describe('only an enabled plugin provides a server', () => {
  const inv = new Map([
    ['alpha@m', inventory('alpha@m', ['alpha'])],
    ['bravo@m', inventory('bravo@m', ['bravo'])],
  ]);

  const wsWith = (enabledPlugins: Record<string, boolean>): Workspace =>
    workspace({
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins }),
      projects: [project('/p')],
    });

  test('an enabled plugin puts its server on the axis', () => {
    assert.deepEqual(axisOf(wsWith({ 'alpha@m': true }), inv), ['plugin:alpha:alpha']);
  });

  test('a disabled plugin does not, because its server never loads', () => {
    const axis = axisOf(wsWith({ 'alpha@m': true, 'bravo@m': false }), inv);
    assert.deepEqual(axis, ['plugin:alpha:alpha']);
    assert.equal(axis.includes('plugin:bravo:bravo'), false);
  });

  test('a plugin nobody enabled anywhere does not either', () => {
    assert.deepEqual(axisOf(wsWith({}), inv), []);
  });

  /**
   * The two claims are separable, and both matter: the server is off the axis because
   * the *plugin* is off, and it comes back as a `scoped-only` row -- never `available` --
   * the moment a deny-list names it.
   */
  test('but a deny-list entry brings the disabled plugin\'s server back, as scoped-only', () => {
    const ws = workspace({
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'bravo@m': false } }),
      projects: [project('/p', { entry: { disabledMcpServers: ['plugin:bravo:bravo'] } })],
    });
    const catalog = buildMcpCatalog(ws, inv);
    const entry = entryOf(catalog, 'plugin:bravo:bravo')!;
    assert.equal(entry.presence, 'scoped-only');
    assert.equal(entry.fromPlugin, null, 'a disabled plugin is not credited with providing it');
  });

  /** A plugin enabled only where no column is drawn loads nowhere anyone can see. */
  test('enabled only in a dead project is not enabled anywhere', () => {
    const ws = workspace({
      projects: [
        project('/gone', {
          alive: false,
          settings: settings('/gone/.claude/settings.json', { enabledPlugins: { 'alpha@m': true } }),
        }),
      ],
    });
    assert.deepEqual(axisOf(ws, inv), []);
  });
});

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * `claudeAiMcpEverConnected` is historical and the key name says so. Treating it as an
 * installed set is the `usageCount` mistake with a set instead of a counter, so the one
 * thing that must not be possible is for an entry named by it alone to read as
 * `available`.
 */
describe('connected at some point is not installed', () => {
  test('a connector named only by the ever-connected list never reads as available', () => {
    const ws = workspace({
      projects: [project('/p', { entry: { disabledMcpServers: ['claude.ai Gmail'] } })],
      claudeJson: claudeJson({ claudeAiMcpEverConnected: ['claude.ai Gmail'] }),
    });
    const entry = entryOf(buildMcpCatalog(ws, new Map()), 'claude.ai Gmail')!;
    assert.equal(entry.presence, 'ever-connected');
    assert.equal(entry.everConnected, true);
    assert.equal(entry.userScope, false);
    assert.deepEqual(entry.declaredIn, []);
  });

  test('and reads as available only once a launch spec on disk says so', () => {
    const ws = workspace({
      projects: [project('/p')],
      claudeJson: claudeJson({
        mcpServers: { 'claude.ai Gmail': spec() },
        claudeAiMcpEverConnected: ['claude.ai Gmail'],
      }),
    });
    assert.equal(entryOf(buildMcpCatalog(ws, new Map()), 'claude.ai Gmail')!.presence, 'available');
  });

  test('the three presences are reported apart rather than as one total', () => {
    const ws = workspace({
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'alpha@m': true } }),
      projects: [project('/p', { entry: { disabledMcpServers: ['legacy-srv'] } })],
      claudeJson: claudeJson({
        mcpServers: { 'user-srv': spec() },
        claudeAiMcpEverConnected: ['claude.ai Gmail'],
      }),
    });
    const catalog = buildMcpCatalog(ws, new Map([['alpha@m', inventory('alpha@m', ['alpha'])]]));
    assert.deepEqual(countByPresence(catalog), {
      available: 2,
      'ever-connected': 1,
      'scoped-only': 1,
    });
  });
});

// ---------------------------------------------------------------------------
// The gate, and the mutations it is measured by
// ---------------------------------------------------------------------------

interface Scenario {
  ws: Workspace;
  inventories: Map<string, PluginInventory>;
}

/**
 * One workspace carrying every source at once.
 *
 * `bravo` and `charlie` are installed, declare a server each, and are switched off --
 * `bravo` explicitly, `charlie` by never being mentioned. Both spellings of "off" are
 * here because a filter written as `enabledPlugins[id] === false` catches one and misses
 * the other.
 */
function scenario(): Scenario {
  return {
    ws: workspace({
      userSettings: settings('/home/.claude/settings.json', {
        enabledPlugins: { 'alpha@m': true, 'bravo@m': false },
      }),
      projects: [
        project('/p', {
          mcpJson: { path: '/p/.mcp.json', mcpServers: { 'proj-srv': spec() } },
          entry: { disabledMcpServers: ['legacy-srv'] },
        }),
      ],
      claudeJson: claudeJson({
        mcpServers: { 'user-srv': spec() },
        claudeAiMcpEverConnected: ['claude.ai Gmail'],
      }),
    }),
    inventories: new Map([
      ['alpha@m', inventory('alpha@m', ['alpha'])],
      ['bravo@m', inventory('bravo@m', ['bravo'])],
      ['charlie@m', inventory('charlie@m', ['charlie'])],
    ]),
  };
}

/**
 * What that workspace's axis is, written out.
 *
 * A literal, and the whole gate. Every mutation below is measured against this rather
 * than against a second run of `buildMcpCatalog`, which would agree with itself whatever
 * the function does. Sorted the way the axis sorts -- default comparator, not
 * `localeCompare`.
 */
const EXPECTED_AXIS = [
  'claude.ai Gmail',
  'legacy-srv',
  'plugin:alpha:alpha',
  'proj-srv',
  'user-srv',
];

/** Every row the expectation and the axis disagree about, named. */
function diff(actual: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of EXPECTED_AXIS) if (!actual.includes(name)) out.push(`missing row ${name}`);
  for (const name of actual) if (!EXPECTED_AXIS.includes(name)) out.push(`extra row ${name}`);
  if (!out.length && actual.join('') !== EXPECTED_AXIS.join('')) {
    out.push(`rows reordered: ${actual.join(', ')}`);
  }
  return out;
}

describe('every source reaches the axis', () => {
  test('and the axis is exactly what the sources name', () => {
    const { ws, inventories } = scenario();
    assert.deepEqual(diff(axisOf(ws, inventories)), []);
  });

  /**
   * The plugin filter, pinned as an absence. If the `resolvePlugin` check in
   * `buildMcpCatalog` is deleted, this is the assertion that goes red -- the mutation
   * below only shows what it would go red *with*.
   */
  test('and no disabled plugin smuggled a server onto it', () => {
    const { ws, inventories } = scenario();
    const axis = axisOf(ws, inventories);
    assert.equal(axis.includes('plugin:bravo:bravo'), false, 'bravo is enabledPlugins false');
    assert.equal(axis.includes('plugin:charlie:charlie'), false, 'charlie is mentioned nowhere');
  });
});

interface Mutation {
  name: string;
  /** Mutates the scenario in place. The axis is taken afterwards. */
  apply: (s: Scenario) => void;
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    /** The source that was missing entirely: `readClaudeJson` dropped this key. */
    name: 'drop the claudeAiMcpEverConnected source',
    apply: (s) => {
      s.ws.claudeJson.claudeAiMcpEverConnected = [];
    },
    names: /^missing row claude\.ai Gmail$/,
  },
  {
    /** As if `catalogEnumerations` still ignored `components.mcpServers`. */
    name: 'drop the plugin-catalog source',
    apply: (s) => {
      for (const inv of s.inventories.values()) {
        for (const src of inv.enumerated) src.mcpServerNames = [];
      }
    },
    names: /^missing row plugin:alpha:alpha$/,
  },
  {
    /**
     * The filter, from the only side a test can reach without editing source.
     *
     * Enabling every plugin makes the filtered enumeration and an unfiltered one produce
     * the same bytes, so this axis is exactly what a `buildMcpCatalog` that never
     * consulted `resolvePlugin` would return for the *unmutated* workspace. The gate
     * rejecting it is what says the two are distinguishable at all -- and the assertion
     * that goes red when the check is actually deleted is the one above.
     */
    name: 'count servers from disabled plugins too',
    apply: (s) => {
      const enabled: Record<string, boolean> = {};
      for (const id of s.inventories.keys()) enabled[id] = true;
      s.ws.userSettings = settings('/home/.claude/settings.json', { enabledPlugins: enabled });
    },
    names: /^extra row plugin:(bravo:bravo|charlie:charlie)$/,
  },
  {
    /**
     * Not one of the three the brief names, and here because the derivation is the part
     * a reader cannot check by eye. A key built from the whole `name@marketplace` id
     * looks plausible and matches no `disabledMcpServers` entry Claude Code ever writes,
     * so the plugin row would silently double instead of joining.
     */
    name: 'derive the plugin key from the full marketplace id',
    apply: (s) => {
      // `alpha@m` + `alpha@m:alpha` -> `plugin:alpha:alpha@m:alpha`, which is the shape a
      // key carrying the marketplace half takes.
      for (const [id, inv] of s.inventories) {
        for (const src of inv.enumerated) {
          src.mcpServerNames = src.mcpServerNames.map((n) => `${id}:${n}`);
        }
      }
    },
    names: /^(missing row plugin:alpha:alpha|extra row plugin:alpha:alpha@m:alpha)$/,
  },
];

describe('the gate fails when a source is lost', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const s = scenario();
      mutation.apply(s);

      const failures = diff(axisOf(s.ws, s.inventories));
      assert.ok(
        failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate -- that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      assert.ok(
        failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${failures.join('; ')}`,
      );
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  /** The positive control the four above are measured against. */
  test('and passes when nothing is lost', () => {
    const s = scenario();
    assert.deepEqual(diff(axisOf(s.ws, s.inventories)), []);
  });
});

// ---------------------------------------------------------------------------
// Against whatever this machine actually has
// ---------------------------------------------------------------------------

/**
 * Ground truth read straight out of the JSON, never back through `readClaudeJson`,
 * `readInventories` or `buildMcpCatalog`.
 *
 * Reading the expectation through the reader that feeds the code under test is the
 * DEA-133 defect one level removed -- the two halves agree with each other whatever
 * either does. These halves move independently: one is `JSON.parse` on a file Claude
 * Code writes, the other is the whole pipeline.
 */
function rawJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

describe('the catalog agrees with the live workspace', () => {
  const home = homedir();
  const ws = loadWorkspace();
  const inventories = readInventories(home);
  const catalog = buildMcpCatalog(ws, inventories);
  const axis = new Set(allMcpServerNames(catalog));

  const rawClaudeJson = rawJson(join(home, '.claude.json'));
  const rawCatalog = rawJson(join(home, '.claude', 'plugins', 'plugin-catalog-cache.json'));
  const rawBuilds = rawJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));

  test('every connector the ever-connected list names is a row', (t) => {
    const connectors: string[] = rawClaudeJson?.claudeAiMcpEverConnected ?? [];
    if (!connectors.length) return t.skip('no claudeAiMcpEverConnected on this machine');

    assert.deepEqual(connectors.filter((n) => !axis.has(n)), []);
    console.log(`    live: ${axis.size} rows, ${connectors.length} of them ever-connected`);
  });

  test('and none of them is reported as available on the strength of that alone', (t) => {
    const connectors: string[] = rawClaudeJson?.claudeAiMcpEverConnected ?? [];
    if (!connectors.length) return t.skip('no claudeAiMcpEverConnected on this machine');

    const declared = new Set(Object.keys(rawClaudeJson?.mcpServers ?? {}));
    const wrong = catalog.entries
      .filter((e) => e.everConnected && e.presence === 'available' && !declared.has(e.name))
      .map((e) => e.name);
    assert.deepEqual(wrong, [], 'ever-connected was rounded up to installed');
  });

  test('every enabled plugin that declares a server has one row per server', (t) => {
    if (!rawCatalog || !rawBuilds) return t.skip('no plugin catalog on this machine');

    const installed = Object.keys(rawBuilds.plugins ?? {});
    const expected: string[] = [];
    for (const id of installed) {
      const servers = rawCatalog.catalog?.plugins?.[id]?.components?.mcpServers;
      if (!Array.isArray(servers) || !servers.length) continue;
      // The enabled half comes from the resolver on purpose: it is the claim under test
      // on the *other* axis, and restating plugin precedence here would fork it.
      if (!ws.projects.some((p) => p.alive && resolvePlugin(ws, p, id).value)) continue;
      for (const s of servers) expected.push(`plugin:${id.split('@')[0]}:${s}`);
    }
    if (!expected.length) return t.skip('no enabled plugin declares an MCP server here');

    assert.deepEqual(expected.filter((n) => !axis.has(n)), []);
    console.log(`    live: ${expected.length} server(s) from enabled plugins`);
  });

  test('and a disabled plugin contributes none', (t) => {
    if (!rawCatalog || !rawBuilds) return t.skip('no plugin catalog on this machine');

    const credited = catalog.entries.filter((e) => e.fromPlugin !== null);
    if (!credited.length) return t.skip('no plugin-provided server on this machine');

    const stillOff = credited.filter(
      (e) => !ws.projects.some((p) => p.alive && resolvePlugin(ws, p, e.fromPlugin!).value),
    );
    assert.deepEqual(stillOff.map((e) => e.name), []);
  });

  /**
   * The pre-DEA-143 axis was the deny-list. Every name it carried has to survive, or the
   * widening quietly traded rows rather than adding them.
   */
  test('nothing the deny-list names was dropped on the way', () => {
    const scoped = new Set<string>();
    for (const entry of Object.values<any>(rawClaudeJson?.projects ?? {})) {
      for (const n of entry?.disabledMcpServers ?? []) scoped.add(n);
      for (const n of entry?.enabledMcpServers ?? []) scoped.add(n);
    }
    assert.deepEqual([...scoped].filter((n) => !axis.has(n)), []);
  });

  test('the axis is strictly wider than the deny-list it used to be', (t) => {
    if (!rawClaudeJson) return t.skip(`no ${join(home, '.claude.json')} on this machine`);
    const beyondScoping = catalog.entries.filter((e) => e.presence !== 'scoped-only');
    if (!beyondScoping.length) {
      return t.skip('nothing installed or ever-connected on this machine');
    }
    assert.ok(
      beyondScoping.some((e) => e.scopedIn.length === 0),
      'every row is still one somebody had already scoped -- the defect, exactly',
    );
  });
});
