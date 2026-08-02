/**
 * Baseline measurement from transcripts.
 *
 * The synthetic fixture pins the arithmetic. The live block then asserts the same
 * invariants against real sessions on this machine, because the fixture can only
 * contain shapes I already knew about.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

import {
  measureTranscript,
  measureProject,
  classifyServer,
  normalizeServerName,
  unauthenticatedButListed,
  type TranscriptMeasurement,
} from '../src/cost/transcript.ts';
import { memorySlug } from '../src/surfaces/read.ts';

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
  /**
   * The guard asks the machine; the assertion asks the code. They must not be the same
   * question.
   *
   * Guarding on `sessions.length === 0` -- the obvious fix for the worktree failure --
   * makes the skip condition the exact negation of the assertion below it. The test then
   * runs only where it is guaranteed to pass and skips wherever it could fail, which is
   * a test that cannot fail for any input. That matters here specifically: `measureProject`
   * swallows per-file read errors in a bare `catch`, so a regression in `memorySlug` or
   * in the reader returns `[]` with the files still sitting on disk. Under the derived
   * guard that regression skips silently and the three invariant tests below iterate an
   * empty array and pass -- the suite goes green for exactly the failure this block exists
   * to catch.
   *
   * So the skip counts transcript files on disk, which is a fact about this machine and
   * this checkout path, and nothing else. A worktree, fresh clone or CI runner has none
   * and skips cleanly; anywhere the files exist, the assertion is free to fail.
   */
  const transcriptDir = join(homedir(), '.claude', 'projects', memorySlug(process.cwd()));
  const recorded = existsSync(transcriptDir)
    ? readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'))
    : [];
  const skip = recorded.length === 0 && `no transcript files under ${transcriptDir}`;

  const sessions = measureProject(homedir(), process.cwd()).slice(0, 5);

  test('found real sessions to check', { skip }, () => {
    assert.ok(
      sessions.length > 0,
      `${recorded.length} transcript files on disk, but measureProject measured none`,
    );
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

/**
 * The property the block above can only check where history happens to exist.
 *
 * "Transcript files on disk are found by `measureProject`" is the whole contract between
 * `memorySlug` and the reader, and on a machine with no sessions for this path -- CI, a
 * worktree, a fresh clone -- the live block skips and asserts nothing about it. Built
 * here instead, so the contract is checked everywhere rather than only where the last
 * few weeks of work happened to leave data.
 *
 * This is also what stops the guard above from drifting back into a tautology. A guard
 * derived from `sessions.length` would make the live block vacuous, and *this* block is
 * what would still go red.
 */
describe('the slug-to-directory contract', () => {
  const home = mkdtempSync(join(tmpdir(), 'qm-transcript-'));

  /**
   * Written out in full rather than built with `memorySlug`.
   *
   * Calling `memorySlug` to lay the directory down and then reading it back through
   * `measureProject` -- which calls `memorySlug` itself -- is the same tautology the
   * guard above was rewritten to avoid: both sides move together, so the test agrees
   * with itself whatever the function does. Measured: swapping the separator to `_`
   * leaves that version of this test green. The literal is the independent half. It is
   * Claude Code's on-disk layout, not this repo's invention, so pinning it is pinning a
   * fact rather than restating an implementation.
   */
  const PROJECT_PATH = '/Users/testuser/some-project';
  const RECORDED_SLUG = '-Users-testuser-some-project';

  after(() => rmSync(home, { recursive: true, force: true }));

  test('memorySlug produces the layout Claude Code actually writes', () => {
    assert.equal(memorySlug(PROJECT_PATH), RECORDED_SLUG);
  });

  test('a transcript filed under that slug is measured', () => {
    const dir = join(home, '.claude', 'projects', RECORDED_SLUG);
    mkdirSync(dir, { recursive: true });
    copyFileSync(FIXTURE, join(dir, 'session.jsonl'));

    const found = measureProject(home, PROJECT_PATH);
    assert.equal(found.length, 1, 'a .jsonl under the recorded slug should be measured');
    assert.ok(found[0]!.totalChars > 0);
  });

  test('and a path with no directory measures nothing, rather than throwing', () => {
    assert.deepEqual(measureProject(home, '/Users/testuser/never-opened'), []);
  });
});
