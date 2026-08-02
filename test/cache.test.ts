/**
 * Cache tests. The key must distinguish two builds that share a version string but
 * differ in content (DEA-128), and a cache written by an older CACHE_VERSION must be
 * discarded on load rather than trusted -- the failure mode DEA-109 first exposed.
 * The build component must also resolve for records that carry no sha, falling back to
 * `lastUpdated` so none key on `unknown` (DEA-131) -- see the buildIdsByPath suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginCostCache, buildIdsByPath } from '../src/cache.ts';
import type { PluginCost } from '../src/cost/plugins.ts';

const cost = (over: Partial<PluginCost> = {}): PluginCost => ({
  id: 'airtable@claude-plugins-official',
  version: '0.1.0',
  source: null,
  alwaysOnTokens: 715,
  components: [],
  counts: {},
  mcpServers: [],
  mcpUncounted: false,
  ...over,
});

function withTempCache(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qm-cache-'));
  try {
    fn(join(dir, 'plugin-costs.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PluginCostCache', () => {
  test('same id and version but different sha are separate entries', () => {
    withTempCache((path) => {
      const cache = new PluginCostCache(path);
      const eight = cost({ counts: { Skills: 8 } });
      const two = cost({ counts: { Skills: 2 } });

      cache.set('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e', eight);
      cache.set('airtable@claude-plugins-official', '0.1.0', 'deadbeef', two);

      assert.equal(cache.size, 2);
      assert.deepEqual(cache.get('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e'), eight);
      assert.deepEqual(cache.get('airtable@claude-plugins-official', '0.1.0', 'deadbeef'), two);
    });
  });

  test('a moved sha misses rather than returning the stale entry', () => {
    // The DEA-128 failure: `claude plugin update` moves the sha but not the version.
    withTempCache((path) => {
      const cache = new PluginCostCache(path);
      cache.set('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e', cost());
      assert.equal(cache.get('airtable@claude-plugins-official', '0.1.0', 'newsha00'), undefined);
    });
  });

  test('null sha keys distinctly from a present sha', () => {
    withTempCache((path) => {
      const cache = new PluginCostCache(path);
      cache.set('x@m', '1.0.0', null, cost({ id: 'x@m' }));
      assert.ok(cache.get('x@m', '1.0.0', null));
      assert.equal(cache.get('x@m', '1.0.0', 'somesha'), undefined);
    });
  });

  test('flush round-trips through a fresh instance', () => {
    withTempCache((path) => {
      const first = new PluginCostCache(path);
      first.set('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e', cost());
      first.flush();

      const second = new PluginCostCache(path);
      assert.equal(second.size, 1);
      assert.deepEqual(
        second.get('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e'),
        cost(),
      );
    });
  });

  test('a cache written by an older version is discarded, not migrated', () => {
    withTempCache((path) => {
      // A v3 file, whose no-sha entries keyed on `@unknown`, must not be trusted at v4.
      writeFileSync(
        path,
        JSON.stringify({
          version: 3,
          entries: { 'airtable@claude-plugins-official@0.1.0@unknown': cost() },
        }),
      );

      const cache = new PluginCostCache(path);
      assert.equal(cache.size, 0);
      assert.equal(cache.get('airtable@claude-plugins-official', '0.1.0', 'aaeb4f3e'), undefined);
    });
  });

  test('flush stamps the current cache version', () => {
    withTempCache((path) => {
      const cache = new PluginCostCache(path);
      cache.set('x@m', '1.0.0', 'sha', cost({ id: 'x@m' }));
      cache.flush();
      const written = JSON.parse(readFileSync(path, 'utf8')) as { version: number };
      assert.equal(written.version, 4);
    });
  });
});

describe('buildIdsByPath', () => {
  test('prefers gitCommitSha, falls back to lastUpdated, so no build reads as unknown', () => {
    // Mirrors installed_plugins.json: some records carry a sha, most only lastUpdated.
    const raw = {
      plugins: {
        airtable: [
          { installPath: '/p/airtable', version: '0.1.0', gitCommitSha: 'aaeb4f3e', lastUpdated: 't1' },
        ],
        'code-simplifier': [
          { installPath: '/p/code-simplifier', version: '1.0.0', lastUpdated: 't2' },
        ],
        context7: [
          // installPath ending in /unknown with version unknown -- lastUpdated still discriminates.
          { installPath: '/p/context7/unknown', version: 'unknown', lastUpdated: 't3' },
        ],
      },
    };

    const ids = buildIdsByPath(raw);

    assert.equal(ids.get('/p/airtable'), 'aaeb4f3e'); // sha wins over lastUpdated
    assert.equal(ids.get('/p/code-simplifier'), 't2'); // fell back to lastUpdated
    assert.equal(ids.get('/p/context7/unknown'), 't3');
    // Every record with a lastUpdated resolves -- none key on the string 'unknown'.
    for (const buildId of ids.values()) assert.notEqual(buildId, 'unknown');
  });

  test('skips records with no installPath or no usable identifier', () => {
    const raw = {
      plugins: {
        a: [{ version: '1.0.0', lastUpdated: 't1' }], // no installPath
        b: [{ installPath: '/p/b', version: '1.0.0' }], // no sha and no lastUpdated
      },
    };
    assert.equal(buildIdsByPath(raw).size, 0);
  });

  test('a missing or malformed plugins map yields an empty map', () => {
    assert.equal(buildIdsByPath(null).size, 0);
    assert.equal(buildIdsByPath({}).size, 0);
    assert.equal(buildIdsByPath({ plugins: 'nope' }).size, 0);
  });
});
