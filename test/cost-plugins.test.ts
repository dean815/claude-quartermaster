/**
 * Parser tests against real `claude plugin details` output, captured verbatim into
 * `test/fixtures/plugin-details/`. Invented sample text would only prove the parser
 * agrees with my guess at the format.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePluginDetails, parseTokenCount, pluginLookupName } from '../src/cost/plugins.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'plugin-details');
const load = (name: string) =>
  parsePluginDetails(name, readFileSync(join(FIXTURES, `${name}.txt`), 'utf8'));

describe('parseTokenCount', () => {
  test('reads the CLI\'s rounded forms', () => {
    assert.equal(parseTokenCount('~715'), 715);
    assert.equal(parseTokenCount('~0'), 0);
    assert.equal(parseTokenCount('~2.7k'), 2700);
    assert.equal(parseTokenCount('~9.8k'), 9800);
    assert.equal(parseTokenCount('238'), 238);
  });

  /**
   * Regression for DEA-109. The CLI prints `~2,349 tok` for anything at or above a
   * thousand, and the original pattern had no comma in its character class, so those
   * parsed as NaN and `costWithoutUse` skipped them silently -- dropping the two most
   * expensive plugins from the one report whose job is ranking by cost.
   *
   * Every case the suite had was either under 1,000 or already suffixed, which is
   * exactly why the gap survived.
   */
  test('reads thousands separators', () => {
    assert.equal(parseTokenCount('~2,349'), 2349);
    assert.equal(parseTokenCount('~1,000'), 1000);
    assert.equal(parseTokenCount('12,345'), 12345);
    assert.equal(parseTokenCount('~1,234.5k'), 1234500);
  });

  test('rejects what it cannot read rather than guessing', () => {
    assert.ok(Number.isNaN(parseTokenCount('lots')));
    assert.ok(Number.isNaN(parseTokenCount('')));
    assert.ok(Number.isNaN(parseTokenCount('1,2,3,4')));
  });
});

describe('a plugin of skills', () => {
  const p = load('superpowers');

  test('reads the headline always-on cost', () => {
    assert.equal(p.alwaysOnTokens, 715);
  });

  test('counts components', () => {
    assert.equal(p.counts['Skills'], 14);
    assert.equal(p.counts['Agents'], 0);
    assert.equal(p.counts['MCP servers'], 0);
  });

  test('reads the per-component table', () => {
    assert.equal(p.components.length, 14);
    const wg = p.components.find((c) => c.name === 'using-git-worktrees');
    assert.deepEqual(wg, { name: 'using-git-worktrees', alwaysOn: 70, onInvoke: 2700 });
  });

  test('every component row parsed to a number', () => {
    for (const c of p.components) {
      assert.ok(Number.isFinite(c.alwaysOn), `${c.name} always-on`);
      assert.ok(Number.isFinite(c.onInvoke), `${c.name} on-invoke`);
    }
  });

  test('captures version and source', () => {
    assert.equal(p.version, '6.1.1');
    assert.equal(p.source, 'superpowers@claude-plugins-official');
  });
});

/**
 * The reason this project exists: first-party prices everything except MCP, and says
 * so in its own output.
 */
describe('a plugin that is only an MCP server', () => {
  const p = load('github');

  test('reports zero always-on cost', () => {
    assert.equal(p.alwaysOnTokens, 0);
  });

  test('names the server it provides', () => {
    assert.equal(p.counts['MCP servers'], 1);
    assert.deepEqual(p.mcpServers, ['github']);
  });

  test('flags that the server was deliberately not priced', () => {
    assert.equal(p.mcpUncounted, true);
  });
});

describe('a third-party plugin absent from the catalog', () => {
  const p = load('warp');

  test('is still priced, so the catalog is not the source', () => {
    assert.equal(p.alwaysOnTokens, 0);
    assert.equal(p.source, 'warp@claude-code-warp');
  });

  test('hooks are counted but cost no model context', () => {
    assert.equal(p.counts['Hooks'], 7);
    assert.equal(p.components.length, 0);
  });
});

/** The plugin whose cost the parser used to drop entirely. */
describe('a plugin costing over a thousand tokens', () => {
  const p = load('plugin-dev');

  test('reads the comma-formatted headline', () => {
    assert.equal(p.alwaysOnTokens, 2349);
  });

  test('is a finite number, so cost detectors do not skip it', () => {
    assert.ok(Number.isFinite(p.alwaysOnTokens));
  });

  test('its components still parse', () => {
    assert.equal(p.counts['Skills'], 8);
    assert.equal(p.counts['Agents'], 3);
    assert.equal(p.components.length, 11);
    for (const c of p.components) {
      assert.ok(Number.isFinite(c.alwaysOn), `${c.name} always-on`);
      assert.ok(Number.isFinite(c.onInvoke), `${c.name} on-invoke`);
    }
  });
});

describe('a plugin with agents', () => {
  const p = load('feature-dev');

  test('sums components close to the headline', () => {
    // Per-component figures are rounded to two significant figures, so they will not
    // reconcile exactly. Within rounding error is the most that can be asserted.
    const summed = p.components.reduce((n, c) => n + c.alwaysOn, 0);
    assert.ok(
      Math.abs(summed - p.alwaysOnTokens) <= 10 * p.components.length,
      `summed ${summed} vs headline ${p.alwaysOnTokens}`,
    );
  });

  test('trailing prose after the table is not parsed as a component', () => {
    for (const c of p.components) {
      assert.ok(!/On-invoke cost|estimates/i.test(c.name), `stray row: ${c.name}`);
    }
  });
});

/**
 * Regression for DEA-122.
 *
 * `claude plugin details` resolves a plugin's *manifest* name, which is case-sensitive.
 * The marketplace id is lowercased, so deriving the lookup name from the id fails
 * whenever the two differ — `notion@claude-plugins-official` could not be priced
 * because the manifest calls it `Notion`.
 *
 * Surveyed across 42 installed plugins: 39 match, 1 differs in case, 2 ship no
 * manifest at all. So the manifest is authoritative where it exists and the id prefix
 * is the fallback — neither alone covers the set.
 */
describe('plugin lookup name', () => {
  const at = (name: string) => join(import.meta.dirname, 'fixtures', 'plugin-manifests', name);

  test('prefers the manifest name when it differs in case from the id', () => {
    assert.equal(pluginLookupName('notion@claude-plugins-official', at('cased')), 'Notion');
  });

  test('falls back to the id prefix when the plugin ships no manifest', () => {
    assert.equal(pluginLookupName('humanizer@agent-toolkit', at('nomanifest')), 'humanizer');
  });

  test('falls back when the manifest does not parse', () => {
    assert.equal(pluginLookupName('broken@m', at('malformed')), 'broken');
  });

  test('falls back when the manifest omits a name', () => {
    assert.equal(pluginLookupName('anon@m', at('nameless')), 'anon');
  });

  test('falls back when no install path is known at all', () => {
    assert.equal(pluginLookupName('solo@m', null), 'solo');
  });

  test('ignores a non-string name rather than passing it to a shell argument', () => {
    // Manifest contents are third-party input; a number or object here must not
    // become the argv entry.
    assert.equal(pluginLookupName('weird@m', at('nameless')), 'weird');
  });
});
