/**
 * Parser tests against real `claude plugin details` output, captured verbatim into
 * `test/fixtures/plugin-details/`. Invented sample text would only prove the parser
 * agrees with my guess at the format.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePluginDetails, parseTokenCount } from '../src/cost/plugins.ts';

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

  test('rejects what it cannot read rather than guessing', () => {
    assert.ok(Number.isNaN(parseTokenCount('lots')));
    assert.ok(Number.isNaN(parseTokenCount('')));
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
