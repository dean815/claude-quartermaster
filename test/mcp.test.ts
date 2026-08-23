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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  allMcpServerNames,
  buildMcpCatalog,
  countByPresence,
  pluginServerKey,
  type McpCatalog,
  type PluginKeyBasis,
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
  // Nothing here is about validity, and `not-checked` is what resolves the way this
  // file resolved before DEA-147 existed. Never `accepted` -- these files were not checked.
  validity: 'not-checked',
  schemaErrors: [],
  droppedRuleElements: {},
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

/**
 * A plugin whose catalog entry declares MCP servers and nothing else.
 *
 * `manifestName` defaults to `null` -- "no manifest could be read" -- because that is
 * what an install path pointing at nothing yields, and it keeps every pre-DEA-145 case
 * below asserting the same key it always did. Pass a name to get the other branch.
 */
function inventory(
  id: string,
  mcpServerNames: string[],
  manifestName: string | null = null,
): PluginInventory {
  return {
    id,
    installPath: `/plugins/${id}`,
    version: '1',
    sha: null,
    manifestName,
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

  /**
   * The third source, and the one DEA-145 added: `<installPath>/.claude-plugin/plugin.json`.
   *
   * Read through `readInventories` off a real directory rather than through a hand-built
   * `PluginInventory`, because the defect being fixed was that nothing ever opened this
   * file. A factory setting `manifestName` by hand tests the plumbing downstream of the
   * read and would have passed on every day the bug existed.
   *
   * The install paths are the fixtures `cost-plugins.test.ts` already reads for
   * `pluginLookupName` -- deliberately the same four directories, since both callers now
   * share one reader and a manifest shape that starts fooling one must not be able to
   * keep fooling only the other.
   */
  test('readInventories reads each plugin manifest name off disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-mcp-'));
    try {
      const at = (name: string) => join(import.meta.dirname, 'fixtures', 'plugin-manifests', name);
      mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
      writeFileSync(
        join(dir, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          plugins: {
            'notion@claude-plugins-official': [{ installPath: at('cased'), version: '0.1.0' }],
            'humanizer@agent-toolkit': [{ installPath: at('nomanifest'), version: '1' }],
            'broken@m': [{ installPath: at('malformed'), version: '1' }],
            'anon@m': [{ installPath: at('nameless'), version: '1' }],
            'gone@m': [{ installPath: join(dir, 'uninstalled'), version: '1' }],
          },
        }),
      );

      const inv = readInventories(dir);
      assert.equal(inv.get('notion@claude-plugins-official')!.manifestName, 'Notion');

      // Four ways of failing to read a name, all of which must stay "could not tell".
      // An id-shaped string here would be a guess wearing a reading's clothes, and no
      // consumer downstream could ever tell the difference again.
      for (const id of ['humanizer@agent-toolkit', 'broken@m', 'anon@m', 'gone@m']) {
        assert.equal(
          inv.get(id)!.manifestName,
          null,
          `${id}: an unreadable manifest must not resolve to the marketplace id here`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The two disk sources meeting: a manifest that disagrees with the id, and a catalog
   * that declares the server, reaching the axis as one row.
   *
   * `plugin:Notion:notion` is pinned as a literal here for the third time in this file
   * and for the same reason each time -- it is Claude Code's spelling, not ours.
   */
  test('and a plugin whose manifest disagrees with its id gets the manifest row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-mcp-'));
    try {
      const id = 'notion@claude-plugins-official';
      const plugins = join(dir, '.claude', 'plugins');
      mkdirSync(plugins, { recursive: true });
      writeFileSync(
        join(plugins, 'installed_plugins.json'),
        JSON.stringify({
          plugins: {
            [id]: [
              {
                installPath: join(import.meta.dirname, 'fixtures', 'plugin-manifests', 'cased'),
                version: '0.1.0',
              },
            ],
          },
        }),
      );
      writeFileSync(
        join(plugins, 'plugin-catalog-cache.json'),
        JSON.stringify({ catalog: { plugins: { [id]: { components: { mcpServers: ['notion'] } } } } }),
      );

      const ws = workspace({
        userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { [id]: true } }),
        projects: [project('/p')],
      });
      const catalog = buildMcpCatalog(ws, readInventories(dir));

      assert.deepEqual(allMcpServerNames(catalog), ['plugin:Notion:notion']);
      const entry = entryOf(catalog, 'plugin:Notion:notion')!;
      assert.equal(entry.fromPlugin, id);
      assert.equal(entry.keyBasis, 'manifest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test('drops the marketplace and keeps the plugin manifest name', () => {
    assert.equal(
      pluginServerKey('figma@claude-plugins-official', 'figma', 'figma'),
      'plugin:figma:figma',
    );
    assert.equal(
      pluginServerKey('airtable@claude-plugins-official', 'airtable', 'airtable'),
      'plugin:airtable:airtable',
    );
    // Plugin name and server name differ, and the key carries both.
    assert.equal(
      pluginServerKey('chrome-devtools-mcp@claude-plugins-official', 'chrome-devtools', 'chrome-devtools-mcp'),
      'plugin:chrome-devtools-mcp:chrome-devtools',
    );
    // A local plugin with no marketplace half is not mangled into one.
    assert.equal(pluginServerKey('local-plugin', 'srv', 'local-plugin'), 'plugin:local-plugin:srv');
  });

  /**
   * The case the marketplace id gets wrong, and the reason this function takes a third
   * argument (DEA-145).
   *
   * `plugin:Notion:notion` is a literal for the same reason every other key here is, and
   * it is a stronger one: it is not merely the shape a deny-list entry takes, it is a
   * string counted 389 times inside the `needsAuthMcpServers` arrays Claude Code writes
   * into its own transcripts, against 0 for `plugin:notion:notion`. Deriving it from
   * `pluginServerKey` would put the function on both sides of the comparison.
   */
  test('and the manifest name wins where it differs from the id', () => {
    assert.equal(
      pluginServerKey('notion@claude-plugins-official', 'notion', 'Notion'),
      'plugin:Notion:notion',
    );
    // The neighbouring plugin that provides a server of the same name. Both spellings
    // appear in the same field, which is what says the middle segment is the plugin and
    // the last one is the server.
    assert.equal(
      pluginServerKey('productivity@claude-plugins-official', 'notion', 'productivity'),
      'plugin:productivity:notion',
    );
  });

  test('and an unreadable manifest falls back to the id without claiming it was read', () => {
    // 2 of the 42 plugins installed on the measured machine ship no readable manifest.
    assert.equal(pluginServerKey('humanizer@agent-toolkit', 'srv', null), 'plugin:humanizer:srv');
    // The fallback key is indistinguishable from a confirmed one by inspection -- which
    // is the whole reason `McpEntry.keyBasis` exists rather than a naming convention.
    assert.equal(
      pluginServerKey('humanizer@agent-toolkit', 'srv', null),
      pluginServerKey('humanizer@agent-toolkit', 'srv', 'humanizer'),
    );
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
 *
 * `delta` is `notion`'s shape: enabled, and carrying a manifest name its marketplace id
 * does not predict. `alpha` is the other live case, an install with no readable manifest
 * at all. One of each is the minimum that makes the two DEA-145 mutations below
 * distinguishable from each other.
 */
function scenario(): Scenario {
  return {
    ws: workspace({
      userSettings: settings('/home/.claude/settings.json', {
        enabledPlugins: { 'alpha@m': true, 'bravo@m': false, 'delta@m': true },
      }),
      projects: [
        project('/p', {
          mcpJson: { path: '/p/.mcp.json', mcpServers: { 'proj-srv': spec() } },
          // Claude Code's Local scope (QM-53). A launch spec in `~/.claude.json` under
          // this project, which is neither the top-level `mcpServers` nor a `.mcp.json`.
          entry: { disabledMcpServers: ['legacy-srv'], mcpServers: { 'local-srv': spec() } },
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
      ['delta@m', inventory('delta@m', ['delta'], 'Delta')],
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
  'local-srv',
  'plugin:Delta:delta',
  'plugin:alpha:alpha',
  'proj-srv',
  'user-srv',
];

/**
 * How each plugin row's name was arrived at, written out separately.
 *
 * A second expectation rather than a richer `EXPECTED_AXIS`, because the axis is the
 * thing that *cannot* see this: `plugin:alpha:alpha` reads identically whether the name
 * was read from a manifest or assumed from the id, so a gate over names alone passes a
 * build that has stopped telling the two apart. That is the argument
 * `duplicateAccessPaths` makes for printing `basis` beside a finding rather than folding
 * it into severity.
 */
const EXPECTED_BASIS: ReadonlyArray<readonly [string, PluginKeyBasis]> = [
  ['plugin:Delta:delta', 'manifest'],
  ['plugin:alpha:alpha', 'marketplace-id'],
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

/** Every plugin row whose name came from somewhere the expectation did not say. */
function basisDiff(catalog: McpCatalog): string[] {
  const out: string[] = [];
  const got = new Map(
    catalog.entries.filter((e) => e.fromPlugin !== null).map((e) => [e.name, e.keyBasis]),
  );
  for (const [name, basis] of EXPECTED_BASIS) {
    const seen = got.get(name);
    if (seen === undefined) out.push(`no plugin row ${name}`);
    else if (seen !== basis) out.push(`${name} spelled from ${seen}, expected ${basis}`);
  }
  for (const [name, basis] of got) {
    if (!EXPECTED_BASIS.some(([n]) => n === name)) {
      out.push(`extra plugin row ${name} (${basis})`);
    }
  }
  return out;
}

/** Both halves of the gate: what the rows are called, and where each name came from. */
function gateFailures(s: Scenario): string[] {
  const catalog = buildMcpCatalog(s.ws, s.inventories);
  return [...diff(allMcpServerNames(catalog)), ...basisDiff(catalog)];
}

describe('every source reaches the axis', () => {
  test('and the axis is exactly what the sources name', () => {
    const { ws, inventories } = scenario();
    assert.deepEqual(diff(axisOf(ws, inventories)), []);
  });

  test('and each plugin row records whether its name was read or assumed', () => {
    assert.deepEqual(basisDiff(buildMcpCatalog(scenario().ws, scenario().inventories)), []);
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
    /**
     * The source QM-53 added: `projects[<abspath>].mcpServers`, Claude Code's Local
     * scope. It was unread for the whole life of this file, and on the machine this was
     * written against that cost two live servers their row entirely.
     */
    name: 'drop the Local-scope launch specs',
    apply: (s) => {
      for (const p of s.ws.projects) if (p.entry) delete p.entry.mcpServers;
    },
    names: /^missing row local-srv$/,
  },
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
  {
    /**
     * DEA-145, from the only side a test can reach without editing source: a reader that
     * opens no manifest and hands back the marketplace id.
     *
     * This is the live bug, not a hypothetical -- `notion@claude-plugins-official` ships
     * `"name": "Notion"`, and the key this produced (`plugin:notion:notion`) appears zero
     * times in the `needsAuthMcpServers` arrays Claude Code writes, against 389 for
     * `plugin:Notion:notion`. A Phase 2 write derived from that row would report success
     * and leave the server loading.
     */
    name: 'build the plugin key from the marketplace id',
    apply: (s) => {
      for (const inv of s.inventories.values()) inv.manifestName = inv.id.split('@')[0]!;
    },
    names: /^(missing row plugin:Delta:delta|extra row plugin:delta:delta)$/,
  },
  {
    /**
     * The fallback, promoted to a reading -- as if `readManifestName` returned the id
     * prefix instead of `null` when it could not open the file.
     *
     * `diff` reports nothing for this one: the rows are identical, because the fallback
     * key *is* the id-derived key. Only `basisDiff` can see it, which is the case for
     * carrying the basis as a field. Left unnoticed it is the `usageCount` mistake --
     * "couldn't tell" recorded as a confirmed value -- and it disarms every consumer
     * downstream that would otherwise have known to distrust the key.
     */
    name: 'treat an unreadable manifest as a confirmed name',
    apply: (s) => {
      for (const inv of s.inventories.values()) inv.manifestName ??= inv.id.split('@')[0]!;
    },
    names: /^plugin:alpha:alpha spelled from manifest, expected marketplace-id$/,
  },
];

describe('the gate fails when a source is lost', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const s = scenario();
      mutation.apply(s);

      const failures = gateFailures(s);
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

  /** The positive control the six above are measured against. */
  test('and passes when nothing is lost', () => {
    assert.deepEqual(gateFailures(scenario()), []);
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
    let fromManifest = 0;
    for (const id of installed) {
      const servers = rawCatalog.catalog?.plugins?.[id]?.components?.mcpServers;
      if (!Array.isArray(servers) || !servers.length) continue;
      // The enabled half comes from the resolver on purpose: it is the claim under test
      // on the *other* axis, and restating plugin precedence here would fork it.
      if (!ws.projects.some((p) => p.alive && resolvePlugin(ws, p, id).value)) continue;
      // The name half is read straight off disk, never through `readManifestName` --
      // routing it through the reader that feeds `buildMcpCatalog` would put the same
      // function on both sides of the comparison (DEA-133). This half is Claude Code's
      // own file layout; the other half is the whole pipeline.
      const installPath = rawBuilds.plugins[id]?.at(-1)?.installPath;
      const name = installPath
        ? rawJson(join(installPath, '.claude-plugin', 'plugin.json'))?.name
        : null;
      if (typeof name === 'string' && name) fromManifest++;
      for (const s of servers) {
        expected.push(`plugin:${typeof name === 'string' && name ? name : id.split('@')[0]}:${s}`);
      }
    }
    if (!expected.length) return t.skip('no enabled plugin declares an MCP server here');

    assert.deepEqual(expected.filter((n) => !axis.has(n)), []);
    console.log(
      `    live: ${expected.length} server(s) from enabled plugins, ` +
        `${fromManifest} of those plugins named by their own manifest`,
    );
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
