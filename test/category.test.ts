/**
 * The borrowed rubric, and the three ways borrowing it goes wrong.
 *
 *  1. **Reading too much.** The matrix's tables are `signal | enable | disable`, and the
 *     signal column is backticked too. Taking every backtick in the section files
 *     `typescript` and `react` as plugin names -- which is harmless right up until a
 *     plugin is called one of them, and is wrong the whole time.
 *  2. **Guessing.** An id the document does not name is uncategorised. Bucketing it by
 *     resemblance would put this repo's judgement next to `project-optimizer`'s, which is
 *     the fork the whole delegation decision exists to prevent.
 *  3. **Failing open.** No file means no filter. A category dropdown offering nothing
 *     reads as "no plugin here is categorised", which is a claim nobody made.
 *
 * The last block runs against the real document when this machine has it. That is the
 * only test here that can notice the upstream file changing shape -- which is the risk
 * that comes with reading someone else's file, and is worth seeing rather than assuming
 * away.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MATRIX_PATH,
  categorise,
  parseMatrix,
  readMatrix,
  type CategoryMatrix,
} from '../src/category.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'plugin-matrix.md');

function bucketOf(m: CategoryMatrix, name: string): string | undefined {
  return m.byName.get(name);
}

describe('the file is there', () => {
  const m = readMatrix(FIXTURE);

  test('it parsed', () => {
    assert.ok(m, 'the fixture matrix did not parse');
  });

  test('a prose bucket names plugins', () => {
    assert.equal(bucketOf(m!, 'commit-commands'), 'Universal');
    assert.equal(bucketOf(m!, 'code-review'), 'Universal');
    assert.equal(bucketOf(m!, 'superpowers'), 'Universal');
    assert.equal(bucketOf(m!, 'github'), 'Git-conditional');
  });

  test('a table names the plugins in its enable columns', () => {
    assert.equal(bucketOf(m!, 'typescript-lsp'), 'Language-conditional');
    assert.equal(bucketOf(m!, 'pyright-lsp'), 'Language-conditional');
    assert.equal(bucketOf(m!, 'frontend-design'), 'Domain-conditional');
    assert.equal(bucketOf(m!, 'playwright'), 'Domain-conditional');
    assert.equal(bucketOf(m!, 'plugin-dev'), 'Meta-conditional');
    assert.equal(bucketOf(m!, 'hookify'), 'Meta-conditional');
  });

  /** The one that would pass by accident if the first column were read as plugins. */
  test('but a table\'s first column is a signal, not a plugin', () => {
    for (const signal of ['typescript', 'python', 'react', 'next', '.claude-plugin/plugin.json']) {
      assert.equal(bucketOf(m!, signal), undefined, `${signal} was filed as a plugin`);
    }
  });

  test('a name in both the enable and disable column lands in one bucket', () => {
    assert.equal(bucketOf(m!, 'figma'), 'Domain-conditional');
  });

  test('a heading keeps its noun and drops its instruction', () => {
    assert.deepEqual(m!.buckets, [
      'Universal',
      'Git-conditional',
      'Language-conditional',
      'Domain-conditional',
      'Meta-conditional',
    ]);
  });

  test('and nothing outside the matrix section is a category', () => {
    assert.equal(bucketOf(m!, 'not-a-bucket-plugin'), undefined);
    assert.equal(bucketOf(m!, 'also-not-a-bucket-plugin'), undefined);
  });
});

describe('the file is not there', () => {
  test('reading it is null, not an empty matrix', () => {
    // Distinct answers: `null` hides the filter, an empty matrix would show an empty one
    // and let a reader conclude the workspace has no categorised plugins.
    assert.equal(readMatrix(join(import.meta.dirname, 'fixtures', 'no-such-matrix.md')), null);
  });

  test('a directory where a file should be is the same answer, not a crash', () => {
    assert.equal(readMatrix(join(import.meta.dirname, 'fixtures')), null);
  });

  test('a file with no matrix section names nothing', () => {
    const m = parseMatrix('# Title\n\n## Something else\n\n`plugin-dev`, `github`\n');
    assert.equal(m.byName.size, 0);
    assert.deepEqual(m.buckets, []);
  });
});

describe('the join is on the bare name', () => {
  const m = readMatrix(FIXTURE)!;

  test('a repo id carries a marketplace the matrix never sees', () => {
    assert.deepEqual(categorise(['github@claude-plugins-official'], m), {
      'github@claude-plugins-official': 'Git-conditional',
    });
  });

  test('an id the matrix does not name is left out, never bucketed', () => {
    const out = categorise(
      ['github@claude-plugins-official', 'minutes@minutes', 'coderabbit@claude-plugins-official'],
      m,
    );
    assert.deepEqual(Object.keys(out), ['github@claude-plugins-official']);
    // Absent, rather than present with a placeholder that would sort with the real ones.
    assert.equal('minutes@minutes' in out, false);
  });

  test('resemblance is not a match', () => {
    // `github-actions` is not `github`, and a prefix rule would say it was.
    assert.deepEqual(categorise(['github-actions@x', 'code-reviewer@x'], m), {});
  });

  test('case is folded, because the id space is and the document is not', () => {
    assert.deepEqual(categorise(['GitHub@Claude-Plugins-Official'], m), {
      'GitHub@Claude-Plugins-Official': 'Git-conditional',
    });
  });

  test('an id with no marketplace still joins', () => {
    assert.deepEqual(categorise(['superpowers'], m), { superpowers: 'Universal' });
  });
});

/**
 * The upstream document, when this machine has it.
 *
 * Skipped rather than failed elsewhere: the point of reading it at runtime is that it
 * belongs to another repo, so its absence is a supported state and not a broken test.
 */
describe('the real matrix', () => {
  const available = existsSync(DEFAULT_MATRIX_PATH);
  const m = available ? readMatrix() : null;

  test('parses and names plugins', { skip: !available && 'no plugin-matrix.md on this machine' }, () => {
    assert.ok(m, 'the real matrix did not parse');
    assert.ok(m.byName.size > 10, `only ${m.byName.size} names`);
    assert.ok(m.buckets.length >= 5, m.buckets.join(', '));
  });

  test('with the buckets the delegation decision assumes', { skip: !available && 'no plugin-matrix.md on this machine' }, () => {
    for (const b of ['Universal', 'Git-conditional', 'Domain-conditional', 'User-level']) {
      assert.ok(m!.buckets.includes(b), `${b} missing from ${m!.buckets.join(', ')}`);
    }
  });

  test('and no stack marker filed as a plugin', { skip: !available && 'no plugin-matrix.md on this machine' }, () => {
    for (const signal of ['typescript', 'python', 'react', 'next', 'vue', 'svelte', 'astro', 'mcp-sdk']) {
      assert.equal(m!.byName.get(signal), undefined, `${signal} was filed as a plugin`);
    }
  });
});
