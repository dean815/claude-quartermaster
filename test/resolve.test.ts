/**
 * Wiring tests for `resolve.ts`.
 *
 * `model.test.ts` proves the precedence algebra. `differential.test.ts` proves the
 * wiring against a first-party oracle -- but only for the scopes this workspace
 * happens to use. A negative control showed the live comparison cannot catch a
 * resolver that ignores `settings.local.json`, because no project here sets
 * `enabledPlugins` there, and nothing sets `skillOverrides` at all.
 *
 * These synthetic workspaces cover what the oracle structurally cannot.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePlugin, resolveSkill, resolveMcpServer, allPluginIds } from '../src/resolve.ts';
import type { SettingsFile, ProjectRecord, Workspace, ClaudeJson } from '../src/surfaces/types.ts';
import type { PluginInventory } from '../src/inventory.ts';
import { project } from './factories.ts';

const inventory = (id: string): PluginInventory => ({
  id,
  installPath: `/plugins/${id}`,
  version: '1',
  sha: null,
  manifestName: null,
  installed: [],
  enumerated: [],
});

/**
 * `not-checked` unless a case says otherwise, because that is what resolves the way this
 * file resolved before DEA-147 -- every assertion below predates validity and must not
 * move. A `discarded` default would delete links from chains these cases are about.
 */
function settings(path: string, body: Partial<SettingsFile> = {}): SettingsFile {
  return { path, validity: 'not-checked', rest: {}, ...body };
}

function claudeJson(body: Partial<ClaudeJson> = {}): ClaudeJson {
  return {
    path: '/home/.claude.json',
    mcpServers: {},
    projects: {},
    claudeAiMcpEverConnected: [],
    skillUsage: {},
    pluginUsage: {},
    ...body,
  };
}

function workspace(userSettings: SettingsFile | null, projects: ProjectRecord[]): Workspace {
  return {
    home: '/home',
    userSettings,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(),
    projects,
  };
}

describe('local scope (not covered by the live oracle)', () => {
  const user = settings('/home/.claude/settings.json', { enabledPlugins: { a: true } });

  test('settings.local.json overrides settings.json', () => {
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { enabledPlugins: { a: true } }),
      localSettings: settings('/p/.claude/settings.local.json', { enabledPlugins: { a: false } }),
    });
    const cell = resolvePlugin(workspace(user, [p]), p, 'a');
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'overridden');
    assert.deepEqual(cell.chain.map((l) => l.scope), ['user', 'project', 'local']);
  });

  test('settings.local.json alone overrides the user scope', () => {
    const p = project('/p', {
      localSettings: settings('/p/.claude/settings.local.json', { enabledPlugins: { a: false } }),
    });
    const cell = resolvePlugin(workspace(user, [p]), p, 'a');
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'overridden');
  });

  test('a local restatement of the user value is redundant', () => {
    const p = project('/p', {
      localSettings: settings('/p/.claude/settings.local.json', { enabledPlugins: { a: true } }),
    });
    const cell = resolvePlugin(workspace(user, [p]), p, 'a');
    assert.equal(cell.value, true);
    assert.equal(cell.origin, 'restated');
  });
});

/**
 * When Claude Code runs in the home directory, `~` is a project whose project-scope
 * settings file *is* the user-scope file. Counted twice, all 42 globally-enabled
 * plugins would report as `restated`.
 */
describe('the home-directory scope collision', () => {
  const shared = settings('/home/.claude/settings.json', {
    enabledPlugins: { a: true, b: false },
  });

  test('one file serving two scopes contributes once', () => {
    const home = project('/home', { settings: shared });
    const ws = workspace(shared, [home]);

    for (const id of ['a', 'b']) {
      const cell = resolvePlugin(ws, home, id);
      assert.equal(cell.origin, 'inherited', `${id} should be inherited, not restated`);
      assert.equal(cell.chain.length, 1, `${id} should have one chain link`);
    }
  });

  test('a genuinely distinct project file still counts', () => {
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { enabledPlugins: { a: true } }),
    });
    const cell = resolvePlugin(workspace(shared, [p]), p, 'a');
    assert.equal(cell.origin, 'restated');
    assert.equal(cell.chain.length, 2);
  });
});

describe('skills (zero adoption in the wild, so untested by the oracle)', () => {
  test('an absent override is on, inherited', () => {
    const p = project('/p');
    const cell = resolveSkill(workspace(null, [p]), p, 'deploy');
    assert.equal(cell.value, 'on');
    assert.equal(cell.origin, 'inherited');
  });

  test('name-only at local overrides on at user', () => {
    const user = settings('/home/.claude/settings.json', { skillOverrides: { deploy: 'on' } });
    const p = project('/p', {
      localSettings: settings('/p/.claude/settings.local.json', {
        skillOverrides: { deploy: 'name-only' },
      }),
    });
    const cell = resolveSkill(workspace(user, [p]), p, 'deploy');
    assert.equal(cell.value, 'name-only');
    assert.equal(cell.origin, 'overridden');
  });

  test('the full precedence chain is preserved for four-valued skills', () => {
    const user = settings('/home/.claude/settings.json', { skillOverrides: { deploy: 'off' } });
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { skillOverrides: { deploy: 'name-only' } }),
      localSettings: settings('/p/.claude/settings.local.json', {
        skillOverrides: { deploy: 'user-invocable-only' },
      }),
    });
    const cell = resolveSkill(workspace(user, [p]), p, 'deploy');
    assert.equal(cell.value, 'user-invocable-only');
    assert.deepEqual(cell.chain.map((l) => l.value), ['off', 'name-only', 'user-invocable-only']);
  });
});

describe('MCP servers', () => {
  test('a user-scoped server is on until a project denies it', () => {
    const ws = workspace(null, []);
    ws.claudeJson = claudeJson({ mcpServers: { raindrop: { type: 'http', url: 'https://x' } } });

    const open = project('/open');
    assert.equal(resolveMcpServer(ws, open, 'raindrop').value, true);

    const denied = project('/denied', { entry: { disabledMcpServers: ['raindrop'] } });
    const cell = resolveMcpServer(ws, denied, 'raindrop');
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'overridden');
  });

  test('a project-declared server needs switching on', () => {
    const p = project('/p', {
      mcpJson: { path: '/p/.mcp.json', mcpServers: { docs: { type: 'http', url: 'https://d' } } },
    });
    // Declared but not enabled anywhere.
    assert.equal(resolveMcpServer(workspace(null, [p]), p, 'docs').value, true);

    const off = project('/p', {
      mcpJson: p.mcpJson,
      localSettings: settings('/p/.claude/settings.local.json', {
        disabledMcpjsonServers: ['docs'],
      }),
    });
    assert.equal(resolveMcpServer(workspace(null, [off]), off, 'docs').value, false);
  });

  test('an unknown server resolves off', () => {
    const p = project('/p');
    const cell = resolveMcpServer(workspace(null, [p]), p, 'nope');
    assert.equal(cell.value, false);
    assert.equal(cell.chain.length, 0);
  });
});

describe('enumeration', () => {
  test('plugin ids are collected from every scope and sorted', () => {
    const user = settings('/home/.claude/settings.json', { enabledPlugins: { b: true } });
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { enabledPlugins: { a: false } }),
      localSettings: settings('/p/.claude/settings.local.json', { enabledPlugins: { c: true } }),
    });
    assert.deepEqual(allPluginIds(workspace(user, [p]), new Map()), ['a', 'b', 'c']);
  });

  /**
   * The defect this mirrors on the skill axis: a plugin no settings file mentions was
   * no row at all, so an installed-but-never-toggled plugin was invisible to the grid
   * that exists to show you what you have.
   */
  test('an installed plugin no settings file mentions is still a row', () => {
    const p = project('/p');
    const inventories = new Map([['ghost@m', inventory('ghost@m')]]);
    assert.deepEqual(allPluginIds(workspace(null, [p]), inventories), ['ghost@m']);

    const cell = resolvePlugin(workspace(null, [p]), p, 'ghost@m');
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'inherited');
  });

  test('an id in both settings and the install tree appears once', () => {
    const user = settings('/home/.claude/settings.json', { enabledPlugins: { 'a@m': true } });
    const inventories = new Map([['a@m', inventory('a@m')]]);
    assert.deepEqual(allPluginIds(workspace(user, []), inventories), ['a@m']);
  });
});
