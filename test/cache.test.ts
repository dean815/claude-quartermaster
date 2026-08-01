/**
 * Cache tests. The key must distinguish two builds that share a version string but
 * differ in content (DEA-128), and a cache written by an older CACHE_VERSION must be
 * discarded on load rather than trusted -- the failure mode DEA-109 first exposed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginCostCache } from '../src/cache.ts';
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
      // A v2 file, keyed the old `<id>@<version>` way, must not be trusted at v3.
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          entries: { 'airtable@claude-plugins-official@0.1.0': cost() },
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
      assert.equal(written.version, 3);
    });
  });
});
