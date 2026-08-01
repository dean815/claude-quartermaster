import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { distribution, profileFrom } from '../src/cost/summary.ts';
import type { TranscriptMeasurement } from '../src/cost/transcript.ts';

function session(
  id: string,
  servers: Array<{ server: string; kind: any; tools: number; chars: number; uuidOverhead?: number }>,
  needsAuth: string[] = [],
): TranscriptMeasurement {
  const chars = servers.reduce((n, s) => n + s.chars, 0);
  return {
    path: `/p/${id}.jsonl`,
    sessionId: id,
    modifiedAt: 0,
    blocks: [{ kind: 'deferred_tools', chars, items: servers.reduce((n, s) => n + s.tools, 0) }],
    servers: servers.map((s) => ({ uuidOverhead: 0, ...s })),
    needsAuth,
    pending: [],
    totalChars: chars,
  };
}

describe('distribution', () => {
  test('reports every quantile for a known series', () => {
    const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(d.samples, 10);
    assert.equal(d.min, 1);
    assert.equal(d.max, 10);
    assert.equal(d.median, 6);
  });

  test('a single sample is its own everything', () => {
    const d = distribution([42]);
    assert.deepEqual(d, { samples: 1, min: 42, p25: 42, median: 42, p75: 42, p95: 42, max: 42 });
  });

  test('empty input does not throw', () => {
    assert.equal(distribution([]).samples, 0);
  });
});

/**
 * Regression: the first version unioned "servers needing auth" and "servers that
 * published tools" across *different* sessions, then intersected them. On real data
 * that reported 31 servers being paid for unused, where the same-session answer is 0.
 * A server that needed auth on Monday and connected on Tuesday is not evidence of
 * paying for nothing.
 */
describe('unauthenticated servers must be judged per session', () => {
  const monday = session('mon', [{ server: 'raindrop', kind: 'direct', tools: 3, chars: 60 }], [
    'linear-server',
  ]);
  const tuesday = session('tue', [{ server: 'linear-server', kind: 'direct', tools: 5, chars: 90 }]);

  test('does not manufacture overlap across sessions', () => {
    const p = profileFrom([monday, tuesday]);
    assert.deepEqual(p.payingForUnauthenticated, []);
  });

  test('does report a genuine same-session overlap', () => {
    const both = session(
      'both',
      [{ server: 'linear-server', kind: 'direct', tools: 5, chars: 90 }],
      ['linear-server'],
    );
    const p = profileFrom([both]);
    assert.deepEqual(p.payingForUnauthenticated.map((s) => s.server), ['linear-server']);
  });

  test('normalizes plugin naming when matching', () => {
    const s = session(
      'x',
      [{ server: 'plugin_marketing_ahrefs', kind: 'plugin', tools: 2, chars: 50 }],
      ['plugin:marketing:ahrefs'],
    );
    assert.deepEqual(profileFrom([s]).payingForUnauthenticated.map((x) => x.server), [
      'plugin_marketing_ahrefs',
    ]);
  });
});

describe('profile aggregation', () => {
  const a = session('a', [
    { server: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', kind: 'connector', tools: 10, chars: 500, uuidOverhead: 360 },
    { server: 'raindrop', kind: 'direct', tools: 4, chars: 100 },
  ]);
  const b = session('b', [
    { server: 'raindrop', kind: 'direct', tools: 4, chars: 100 },
  ]);

  test('counts sessions a server actually appeared in', () => {
    const p = profileFrom([a, b]);
    const raindrop = p.servers.find((s) => s.server === 'raindrop')!;
    assert.equal(raindrop.sessions, 2);
    const connector = p.servers.find((s) => s.kind === 'connector')!;
    assert.equal(connector.sessions, 1);
  });

  test('reports a range for the tool block, never a single number', () => {
    const p = profileFrom([a, b]);
    assert.equal(p.deferredToolChars.min, 100);
    assert.equal(p.deferredToolChars.max, 600);
    assert.equal(p.deferredToolChars.samples, 2);
  });

  test('UUID overhead accrues only to connectors', () => {
    const p = profileFrom([a, b]);
    assert.equal(p.connectorOverhead.servers, 1);
    assert.equal(p.connectorOverhead.chars, 360);
    assert.equal(p.connectorOverhead.shareOfPeakBlock, 360 / 600);
  });
});
