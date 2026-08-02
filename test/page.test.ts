/**
 * What the page must be true of before a browser ever sees it.
 *
 * `view.test.ts` and `serve.test.ts` establish that nothing sensitive reaches the wire in
 * the *data*. The page is the other half of the same boundary and fails differently: it is
 * a literal, so a path can be typed into it directly, and no amount of projection upstream
 * would catch that. Hence a substring sweep over the constant itself.
 *
 * The rest is the contract between this file and `server.ts`: the page must fit inside the
 * policy that response carries, and it must reach the two endpoints slice 2 split apart.
 * A page that quietly needed a CDN would still render on the machine that wrote it -- the
 * CSP failure is silent to the author and total to everyone else.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { PAGE } from '../src/view/page.ts';
import { SKILL_VALUES } from '../src/model.ts';

describe('nothing about this machine is in the page', () => {
  test('no home directory', () => {
    assert.ok(!PAGE.includes(homedir()), 'the home directory is in the page literal');
    assert.ok(!PAGE.includes('/Users/'), '/Users/ is in the page literal');
    assert.ok(!PAGE.includes('/home/'), '/home/ is in the page literal');
    // A drive letter is a *lone* letter before the colon; `http://` is not one.
    assert.ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(PAGE), 'a Windows drive path is in the page');
  });

  /**
   * Anything that looks like an absolute filesystem path, wherever it sits in the string.
   * `/api/view` and `/api/cost` are request targets, not paths, so the roots are named
   * rather than matching every leading slash.
   */
  test('nor any absolute filesystem path', () => {
    const found = PAGE.match(/\/(Users|home|var|etc|opt|private|tmp|root|usr)\/[A-Za-z0-9._-]+/g);
    assert.deepEqual(found, null);
  });

  test('and the page never builds one', () => {
    // Slice 1 is an allowlist, not a filter. Reassembling a path client-side from what did
    // survive would walk straight around it.
    for (const cue of ['homedir', 'process.env', 'file://', '.claude/settings']) {
      assert.ok(!PAGE.includes(cue), `the page mentions ${cue}`);
    }
  });
});

describe('the page fits inside the policy the server sets', () => {
  test('it fetches this origin and nothing else', () => {
    const fetches = [...PAGE.matchAll(/fetch\((['"`])([^'"`]*)/g)].map((m) => m[2]!);
    assert.ok(fetches.length > 0, 'the page fetches nothing');
    for (const url of fetches) assert.match(url, /^\/api\//, url);
  });

  test('no external origin appears at all', () => {
    // `default-src 'none'` with `connect-src 'self'`: a CDN, a font or a remote image is a
    // blocked request and a blank page, not a degraded one.
    const urls = PAGE.match(/https?:\/\/[^\s"')]+/g) ?? [];
    // The SVG namespace is an identifier in an xmlns attribute; nothing is fetched from it.
    assert.deepEqual(urls.filter((u) => u !== 'http://www.w3.org/2000/svg'), []);
  });

  test('images are inline data URIs, which is what img-src allows', () => {
    assert.ok(PAGE.includes('url("data:image/svg+xml,'), 'no inline icon found');
    assert.ok(!/<img\b/.test(PAGE), 'an <img> element would need a source to fetch');
  });

  test('it is one file: no module import, no external stylesheet', () => {
    assert.ok(!/<link\b/.test(PAGE), '<link> is an external fetch');
    assert.ok(!/type=["']module["']/.test(PAGE));
    assert.ok(!/\bimport\s/.test(PAGE));
  });

  test('and declares a policy-compatible document', () => {
    assert.match(PAGE, /^<!doctype html>/);
    assert.match(PAGE, /<meta charset="utf-8">/);
  });
});

describe('the mount points the script writes into all exist', () => {
  for (const id of ['snap', 'kinds', 'catwrap', 'cat', 'hl', 'main', 'view-ext', 'view-proj',
    'detail', 'detail-body', 'detail-x', 'stat', 'hlrule', 'catrule', 'tab-ext', 'tab-proj']) {
    test(`#${id}`, () => {
      assert.ok(PAGE.includes(`id="${id}"`), `no element carries id="${id}"`);
      // And something reads it, or it is decoration masquerading as a mount point.
      assert.ok(PAGE.includes(`'${id}'`) || PAGE.includes(`"${id}"`), `#${id} is never used`);
    });
  }
});

describe('what the brief asked to be on screen', () => {
  test('both endpoints are reached', () => {
    assert.ok(PAGE.includes('/api/view'));
    assert.ok(PAGE.includes('/api/cost?plugin='));
  });

  test('two separate filters, not one', () => {
    assert.ok(PAGE.includes('data-kind='), 'no type filter');
    assert.ok(PAGE.includes('id="cat"'), 'no category filter');
  });

  test('the snapshot is stated, with the restart it needs', () => {
    assert.match(PAGE, /snapshot/);
    assert.match(PAGE, /restart of .{0,20}qm serve/);
    assert.ok(PAGE.includes('not on a page refresh'));
  });

  test('the add/remove control is present and inert', () => {
    assert.match(PAGE, /add \/ remove/);
    assert.match(PAGE, /<select disabled>/);
    assert.match(PAGE, /Phase 2/);
  });

  test('the pinned global row is derived from the user scope', () => {
    assert.match(PAGE, /globalValue/);
    assert.ok(PAGE.includes("scope === 'user'"), 'global is not read off the user link');
  });

  test('cost has three states, and pending is not unpriceable', () => {
    assert.ok(PAGE.includes('not priced yet'));
    assert.ok(PAGE.includes('nothing could price it'));
    assert.ok(PAGE.includes('alwaysOnTokens'));
  });
});

describe('value and origin stay two axes', () => {
  test('every skill value has its own glyph', () => {
    // Four values through the same renderer as a two-valued plugin row. A skill value
    // without a glyph is the A-F flattening coming back in a different shape.
    const glyphs = new Map<string, string>();
    for (const v of [...SKILL_VALUES, 'true', 'false']) {
      const m = PAGE.match(new RegExp(`'${v}': '(\\\\u[0-9A-F]{4})'`));
      assert.ok(m, `no glyph for ${v}`);
      glyphs.set(v, m[1]!);
    }
    assert.equal(new Set([...SKILL_VALUES].map((v) => glyphs.get(v))).size, SKILL_VALUES.length,
      'two skill values share a glyph');
  });

  test('origin drives styling, on its own attribute', () => {
    for (const o of ['inherited', 'overridden', 'restated']) {
      assert.ok(PAGE.includes(`td.c[data-o=${o}]`), `no rule for ${o}`);
    }
    // The one the brief is explicit about: restated must not read as overridden.
    assert.match(PAGE, /td\.c\[data-o=restated\]::before\{content:"\\25B3"/);
  });

  test('scope is a separate attribute with its own mark', () => {
    for (const s of ['user', 'project', 'local']) {
      assert.ok(PAGE.includes(`td.c[data-s=${s}]::after`), `no provenance mark for ${s}`);
      assert.ok(PAGE.includes(`--i-${s}:url("data:image/svg+xml,`), `no icon for ${s}`);
    }
  });

  test('and the two are never the same attribute', () => {
    assert.ok(!PAGE.includes('data-o=user'));
    assert.ok(!PAGE.includes('data-s=inherited'));
  });
});

describe('the grid is listened to once', () => {
  test('delegation, not a listener per cell', () => {
    const listeners = PAGE.match(/addEventListener\(/g) ?? [];
    // nav click, nav change, detail close, main click. Anything growing with cell count
    // would have to be added here first.
    assert.ok(listeners.length <= 6, `${listeners.length} addEventListener calls`);
    assert.ok(PAGE.includes("el('main').addEventListener('click'"), 'no delegated grid handler');
  });

  test('and highlighting is a rule, not a walk over cells', () => {
    assert.ok(PAGE.includes("el('hlrule').textContent"), 'highlight does not go through CSS');
  });

  test('prices are fetched with a bound on concurrency', () => {
    assert.match(PAGE, /for \(var i = 0; i < 5; i\+\+\) pump\(\)/);
  });
});
