/**
 * The sessions view (QM-55).
 *
 * `qm serve` is one port for the whole suite, and the second view is Fleet's board rendered
 * by Fleet's own scripts. What these gate is the boundary rather than the board: this repo
 * does not own `render.py`, so asserting anything about the board's *content* would be a
 * second opinion about a renderer that can change without notice.
 *
 * Three properties, and the third is why the route exists in this shape at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fleetDir, renderSessions } from '../src/view/sessions.ts';

const repoRoot = () => dirname(dirname(fileURLToPath(import.meta.url)));
const havePython = (): boolean => {
  try {
    execFileSync('python3', ['-c', ''], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('the sessions view', () => {
  /**
   * The path has to resolve from `src/view/` to the sibling plugin, and it is the one thing
   * that stops working if the repo is relaid out. Asserted against a path built from the
   * repo root by a *different* route than `fleetDir` uses -- reading it back through the
   * function that computes it would agree with whatever that function does, which is the
   * `memorySlug` defect this repo keeps re-learning.
   */
  test('resolves Fleet from this file, not from the working directory', () => {
    assert.equal(fleetDir(), join(repoRoot(), 'plugins', 'session-fleet'));
    assert.ok(existsSync(join(fleetDir(), 'collect.py')), 'collect.py is not where the route looks');
    assert.ok(existsSync(join(fleetDir(), 'render.py')), 'render.py is not where the route looks');
  });

  /**
   * The degradation, which is the whole reason this is a subprocess with a diagnostic and
   * not a `try`/`catch` around a 500. A control plane whose config half dies because its
   * sessions half cannot start is worse than one that says which half is missing.
   *
   * Exercised by making `python3` unreachable rather than by stubbing, so it tests the
   * `ENOENT` this actually gets rather than a shape someone imagined it gets.
   */
  test('says which half is missing when python3 is not on PATH', () => {
    const real = process.env['PATH'];
    process.env['PATH'] = '/nonexistent-for-this-test';
    try {
      const r = renderSessions();
      assert.equal(r.ok, false);
      assert.match(r.html, /No python3 on PATH/);
      // It must stay a page. An exception here is a 500, and a 500 is what takes the grid
      // down with it.
      assert.match(r.html, /back to the extensions grid/);
    } finally {
      process.env['PATH'] = real;
    }
  });

  /**
   * And it renders, where a python3 exists. Guarded on the *input* -- whether this machine
   * has a python3 -- which is QM-51's legitimate category: a real machine can lack one, and
   * the assertion below is about the route, not about the machine.
   */
  test('renders Fleet’s own bytes when python3 is present', (t) => {
    if (!havePython()) return t.skip('no python3 on this machine');
    const r = renderSessions(1);
    assert.equal(r.ok, true, 'the board did not render');
    assert.ok(!/Sessions &mdash; unavailable|Sessions — unavailable/.test(r.html));

    // Verbatim, asserted as a property of the whole document rather than by finding Fleet's
    // title somewhere in it. Matching `<title>Session Fleet</title>` passes just as happily
    // when a wrapper has been prepended around it -- verified by mutation: prefixing
    // `<title>quartermaster</title>` left that assertion green. What cannot survive a
    // wrapper is the document still *beginning* at Fleet's first byte and still carrying
    // exactly one title.
    assert.ok(r.html.startsWith('<title>Session Fleet</title>'),
      `the board is not served from its first byte: ${JSON.stringify(r.html.slice(0, 60))}`);
    assert.equal(r.html.split('<title>').length - 1, 1, 'a second <title> means a wrapper');
    // What this does NOT catch, measured: appending a footer after Fleet's last byte leaves
    // both assertions green. Gating that means asserting the board's closing bytes, which
    // couples this test to a renderer the repo does not own -- `render.py` may reorder its
    // output in any commit and the test would fail for a change that broke nothing. A
    // prepended wrapper is the shape a header or nav actually takes, and that is gated.
  });
});
