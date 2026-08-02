/**
 * Baseline measurement from transcripts.
 *
 * The synthetic fixture pins the arithmetic. The live block then asserts the same
 * invariants against real sessions on this machine, because the fixture can only
 * contain shapes I already knew about.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  measureTranscript,
  measureProject,
  classifyServer,
  normalizeServerName,
  unauthenticatedButListed,
  type TranscriptMeasurement,
} from '../src/cost/transcript.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'transcripts', 'synthetic.jsonl');

const block = (m: TranscriptMeasurement, kind: string) => m.blocks.find((b) => b.kind === kind);

describe('server classification', () => {
  test('separates the three namespaces', () => {
    assert.equal(classifyServer('6f1f8065-e9be-4252-b99d-84ff19549f0d'), 'connector');
    assert.equal(classifyServer('plugin_playwright_playwright'), 'plugin');
    assert.equal(classifyServer('raindrop'), 'direct');
    assert.equal(classifyServer('(built-in)'), 'builtin');
  });

  test('a status-list name normalizes to its tool-name form', () => {
    assert.equal(normalizeServerName('plugin:marketing:ahrefs'), 'plugin_marketing_ahrefs');
    assert.equal(
      normalizeServerName('plugin:adobe-for-creativity:Adobe for creativity'),
      'plugin_adobe-for-creativity_Adobe_for_creativity',
    );
    assert.equal(normalizeServerName('raindrop'), 'raindrop');
  });
});

describe('synthetic transcript', () => {
  const m = measureTranscript(FIXTURE);

  test('deltas accumulate and duplicates are not paid for twice', () => {
    // 4 names in the first delta, 2 in the second, one of which repeats.
    assert.equal(block(m, 'deferred_tools')!.items, 5);
  });

  test('per-server attribution partitions the block exactly', () => {
    const attributed = m.servers.reduce((n, s) => n + s.chars, 0);
    assert.equal(attributed, block(m, 'deferred_tools')!.chars);
  });

  test('tool counts partition too', () => {
    const counted = m.servers.reduce((n, s) => n + s.tools, 0);
    assert.equal(counted, block(m, 'deferred_tools')!.items);
  });

  test('each namespace is attributed to the right kind', () => {
    const kinds = Object.fromEntries(m.servers.map((s) => [s.server, s.kind]));
    assert.equal(kinds['6f1f8065-e9be-4252-b99d-84ff19549f0d'], 'connector');
    assert.equal(kinds['plugin_playwright_playwright'], 'plugin');
    assert.equal(kinds['raindrop'], 'direct');
    assert.equal(kinds['(built-in)'], 'builtin');
  });

  test('UUID overhead is charged only to connectors', () => {
    const connector = m.servers.find((s) => s.kind === 'connector')!;
    assert.equal(connector.tools, 2);
    assert.equal(connector.uuidOverhead, 72);
    for (const s of m.servers.filter((x) => x.kind !== 'connector')) {
      assert.equal(s.uuidOverhead, 0, `${s.server} should carry no UUID overhead`);
    }
  });

  test('skill listing takes the largest record, not the sum', () => {
    // Two listings: 21 chars then 42. Each is a full listing, so 42 is the cost.
    assert.equal(block(m, 'skill_listing')!.chars, 42);
    assert.equal(block(m, 'skill_listing')!.items, 2);
  });

  test('agent listing sums its deltas', () => {
    assert.equal(block(m, 'agent_listing')!.chars, '- Explore: reads'.length + '- Plan: designs'.length);
    assert.equal(block(m, 'agent_listing')!.items, 2);
  });

  test('mcp instructions and hook output are measured', () => {
    assert.equal(block(m, 'mcp_instructions')!.chars, '## raindrop\nBookmarks.'.length);
    assert.equal(block(m, 'hook_output')!.items, 2);
    assert.equal(block(m, 'hook_output')!.chars, '=== REMEMBER ==='.length + 'ok'.length);
  });

  test('auth and pending sets are unioned across deltas', () => {
    assert.deepEqual(m.needsAuth, ['linear-server', 'plugin:marketing:ahrefs']);
    assert.deepEqual(m.pending, ['logic-pro']);
  });

  test('total is the sum of the blocks', () => {
    assert.equal(m.totalChars, m.blocks.reduce((n, b) => n + b.chars, 0));
  });

  test('servers needing auth published no tools here', () => {
    assert.deepEqual(unauthenticatedButListed(m), []);
  });
});

/**
 * Live invariants. The partition property has to hold on real data, where tool names
 * are far messier than anything I would think to write into a fixture.
 */
describe('live transcripts', () => {
  // Guard on the thing actually measured: this working directory's own sessions.
  // measureProject returns [] both when the machine has no ~/.claude/projects and
  // when it exists but holds nothing for this path -- a fresh clone, worktree, or CI
  // checkout. Guarding on the directory's mere existence skipped only the last case
  // and turned the other two into failures.
  const sessions = measureProject(homedir(), process.cwd()).slice(0, 5);
  const skip = sessions.length === 0 && `no recorded sessions for ${process.cwd()}`;

  test('found real sessions to check', { skip }, () => {
    assert.ok(sessions.length > 0, 'no sessions measured for this project');
  });

  test('attribution partitions exactly on real data', { skip }, () => {
    for (const m of sessions) {
      const deferred = block(m, 'deferred_tools');
      if (!deferred) continue;
      assert.equal(
        m.servers.reduce((n, s) => n + s.chars, 0),
        deferred.chars,
        `chars mismatch in ${m.sessionId}`,
      );
      assert.equal(
        m.servers.reduce((n, s) => n + s.tools, 0),
        deferred.items,
        `tool count mismatch in ${m.sessionId}`,
      );
    }
  });

  test('measurement is deterministic', { skip }, () => {
    const first = sessions[0];
    if (!first) return;
    const again = measureTranscript(first.path);
    assert.equal(again.totalChars, first.totalChars);
    assert.deepEqual(again.servers, first.servers);
  });

  test('every namespace classifies', { skip }, () => {
    for (const m of sessions) {
      for (const s of m.servers) {
        assert.ok(
          ['connector', 'plugin', 'direct', 'builtin'].includes(s.kind),
          `${s.server} -> ${s.kind}`,
        );
      }
    }
  });
});
