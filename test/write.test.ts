/**
 * The surgical-write gate: bytes nobody modelled must survive an edit.
 *
 * `readClaudeJson` names five fields. The live `~/.claude.json` has 83 top-level keys,
 * so 78 of them exist only as bytes, and the property under test is about those 78 --
 * not about what a parse produces. So the gate is **byte identity**, never deep-equality
 * of parsed JSON: `assert.deepEqual(JSON.parse(after), JSON.parse(before))` passes for a
 * writer that reformats all 202,828 bytes and drops every comment, key order and spacing
 * decision the file carried. Apply an edit, revert it, compare the strings.
 *
 * ## Where byte identity is and is not available
 *
 * Reverting re-encodes the original *value*, so the revert is byte-identical exactly
 * where the file was `JSON.stringify(_, null, 2)` output at that path. That is not an
 * assumption about `~/.claude.json`: all 83 of its top-level values were measured
 * against exactly that encoding and all 83 matched, which is why every one of them is
 * round-tripped below. Where a file is *not* canonical -- an array written inline in an
 * otherwise expanded document -- the edit still touches nothing but that one value, and
 * `reverting a non-canonical value reformats it` pins what happens instead.
 *
 * Insertions have no revert, because there is no delete. Their independent pin is
 * `soleInsertion`: every byte of the original must reappear, in order, with exactly one
 * contiguous run added -- and that run compared against a literal.
 *
 * ## Negative controls
 *
 * A gate that cannot fail is not a gate. Four mutants run the same corpus through a
 * broken setter built from the real `locate` -- a span one byte short, a span one byte
 * early, an insert silently dropped, and a key found the way it would be found by
 * someone who has only ever seen keys that need no escaping. Each is asserted to fail
 * and to fail *saying the right thing*. Two facts they defend:
 *
 *   - 0 of the live file's 83 top-level keys and 0 of its 139 project keys need a JSON
 *     string escape, so the naive scanner passes on this machine and corrupts the first
 *     one whose project path contains a quote.
 *   - the live file moves under the tool constantly -- every session writes `lastCost`
 *     into it -- so `applyStage` refusing is the common case, not the exotic one. It is
 *     mutated between staging and applying below, and the refusal asserted.
 *
 * ## What this file never does
 *
 * It never writes to a real config file. `~/.claude.json` is read, copied into
 * `mkdtempSync` space, and only the copy is ever passed to anything that writes. The
 * live block skips on whether that file exists -- a fact about the machine -- and never
 * on anything derived from what the assertions check (DEA-133).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyStage,
  locate,
  setJsonValue,
  spliceAt,
  stageEdits,
  type Edit,
  type EditResult,
  type JsonPath,
  type Stage,
} from '../src/surfaces/write.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL = 'qm-DEA-139-sentinel';

/** A bare `text -> text` setter, so a mutant can stand where the real one stands. */
type Setter = (text: string, path: JsonPath, value: unknown) => string;

function edited(result: EditResult): string {
  if (result.outcome === 'refused') {
    throw new Error(`refused ${result.refusal.reason}: ${result.refusal.detail}`);
  }
  return result.text;
}

const real: Setter = (text, path, value) => edited(setJsonValue(text, path, value));

function refusalOf(result: EditResult): { reason: string; detail: string } {
  if (result.outcome === 'edited') throw new Error('expected a refusal, got an edit');
  return result.refusal;
}

function pluck(root: unknown, path: JsonPath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return cur;
}

function diffAt(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a.charAt(i) === b.charAt(i)) i++;
  return (
    `lengths ${a.length} vs ${b.length}, first difference at ${i}: ` +
    `${JSON.stringify(a.slice(i, i + 48))} vs ${JSON.stringify(b.slice(i, i + 48))}`
  );
}

/**
 * The one contiguous run `after` adds to `before`, or null if it is not that.
 *
 * Null covers everything an insert must not do: drop a byte, move one, reorder members,
 * reformat a neighbour. Independent of the locator, so a mislocated insert fails here
 * rather than being compared against the same wrong offset that produced it.
 */
function soleInsertion(before: string, after: string): string | null {
  if (after.length <= before.length) return null;
  let p = 0;
  while (p < before.length && before.charAt(p) === after.charAt(p)) p++;
  const added = after.length - before.length;
  if (before.slice(p) !== after.slice(p + added)) return null;
  return after.slice(p, p + added);
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** `JSON.stringify(_, null, 2)` output, which is the shape Claude Code writes. */
const PRETTY = `{
  "numStartups": 97,
  "installMethod": "native",
  "projects": {
    "/Users/x/proj": {
      "disabledMcpServers": [
        "a",
        "b"
      ],
      "hasTrustDialogAccepted": true
    }
  },
  "userID": "u-1"
}`;

/** No whitespace at all, and braces, brackets and quotes inside a string value. */
const COMPACT = '{"a":1,"b":{"c":[1,2]},"tricky":"}{[],\\"quoted\\""}';

/**
 * Keys that need escapes -- the case the live file cannot exercise.
 *
 * `"a\\"b"` matters beyond decoding it correctly: the raw bytes of that key contain the
 * substring `"b":`, so a scanner searching the text for `"b":` finds this member and
 * edits the wrong value. That is the whole of the `naive key search` mutant below.
 */
const ESCAPED = `{
  "a\\"b": "keep me",
  "b": "target",
  "c\\\\d": 3,
  "\\u0041": 4
}`;

const TABS = `{
\t"outer": {
\t\t"inner": true
\t},
\t"n": 1
}`;

const CRLF = PRETTY.replaceAll('\n', '\r\n');

const EMPTY = `{
  "obj": {},
  "arr": [],
  "spread": {
  }
}`;

/**
 * A container deep enough that a recursive value-skipper would overflow before reaching
 * the member after it. The path stays shallow on purpose: what is under test is skipping
 * *past* 10,000 levels to find `after`, not walking into them.
 */
const DEEP_LEVELS = 10_000;
const DEEP = (() => {
  let inner = '"leaf"';
  for (let i = 0; i < DEEP_LEVELS; i++) inner = `{"a":${inner}}`;
  return `{"deep":${inner},"after":1}`;
})();

interface Fixture {
  name: string;
  text: string;
  /** Paths that already hold a value, and whose layout is canonical so revert is exact. */
  replace: JsonPath[];
}

const FIXTURES: Fixture[] = [
  {
    name: 'pretty',
    text: PRETTY,
    replace: [
      ['numStartups'],
      ['installMethod'],
      ['projects'],
      ['projects', '/Users/x/proj'],
      ['projects', '/Users/x/proj', 'disabledMcpServers'],
      ['projects', '/Users/x/proj', 'disabledMcpServers', 0],
      ['projects', '/Users/x/proj', 'disabledMcpServers', 1],
      ['projects', '/Users/x/proj', 'hasTrustDialogAccepted'],
      ['userID'],
    ],
  },
  {
    name: 'compact',
    text: COMPACT,
    replace: [['a'], ['b'], ['b', 'c'], ['b', 'c', 0], ['tricky']],
  },
  {
    name: 'escaped keys',
    text: ESCAPED,
    replace: [['a"b'], ['b'], ['c\\d'], ['A']],
  },
  { name: 'tab indented', text: TABS, replace: [['outer'], ['outer', 'inner'], ['n']] },
  {
    name: 'crlf',
    text: CRLF,
    replace: [['numStartups'], ['projects'], ['projects', '/Users/x/proj', 'disabledMcpServers']],
  },
  {
    name: 'empty containers',
    text: EMPTY,
    // `"spread"` is left out: `{` and `}` on two lines is not what
    // `JSON.stringify({}, null, 2)` writes, so reverting it collapses to `{}`. That is
    // the documented non-canonical case, pinned by its own test below.
    replace: [['obj'], ['arr']],
  },
  { name: 'deep', text: DEEP, replace: [['after']] },
];

interface InsertCase {
  fixture: string;
  text: string;
  path: JsonPath;
  value: unknown;
  /** The whole file afterwards. A literal, so nothing here is computed from the code. */
  after: string;
}

/** Small, so an insert's expectation can be the whole document rather than a fragment. */
const INS = `{
  "projects": {
    "/p": {
      "disabledMcpServers": [
        "a"
      ]
    }
  },
  "userID": "u-1"
}`;

const INSERTS: InsertCase[] = [
  {
    fixture: 'append a member to a nested object',
    text: INS,
    path: ['projects', '/p', 'hasTrustDialogAccepted'],
    value: true,
    after: `{
  "projects": {
    "/p": {
      "disabledMcpServers": [
        "a"
      ],
      "hasTrustDialogAccepted": true
    }
  },
  "userID": "u-1"
}`,
  },
  {
    fixture: 'append an element to an array',
    text: INS,
    path: ['projects', '/p', 'disabledMcpServers', 1],
    value: 'b',
    after: `{
  "projects": {
    "/p": {
      "disabledMcpServers": [
        "a",
        "b"
      ]
    }
  },
  "userID": "u-1"
}`,
  },
  {
    fixture: 'append at the top level',
    text: INS,
    path: ['autoUpdates'],
    value: false,
    after: `{
  "projects": {
    "/p": {
      "disabledMcpServers": [
        "a"
      ]
    }
  },
  "userID": "u-1",
  "autoUpdates": false
}`,
  },
  {
    // The colon spacing is copied from the file, not chosen: a compact document gets a
    // compact member.
    fixture: 'compact',
    text: COMPACT,
    path: ['added'],
    value: { x: 1 },
    after: '{"a":1,"b":{"c":[1,2]},"tricky":"}{[],\\"quoted\\"","added":{"x":1}}',
  },
  {
    fixture: 'a key needing escapes',
    text: ESCAPED,
    path: ['q"\\'],
    value: 1,
    after: `{
  "a\\"b": "keep me",
  "b": "target",
  "c\\\\d": 3,
  "\\u0041": 4,
  "q\\"\\\\": 1
}`,
  },
  {
    fixture: 'tab indented',
    text: TABS,
    path: ['outer', 'k'],
    value: [1],
    after: `{
\t"outer": {
\t\t"inner": true,
\t\t"k": [
\t\t\t1
\t\t]
\t},
\t"n": 1
}`,
  },
  {
    // Derived from the LF literal above by a total transformation -- the point is that
    // the inserted member carries the file's line ending, not a hardcoded `\n`.
    fixture: 'crlf',
    text: INS.replaceAll('\n', '\r\n'),
    path: ['autoUpdates'],
    value: false,
    after: `{
  "projects": {
    "/p": {
      "disabledMcpServers": [
        "a"
      ]
    }
  },
  "userID": "u-1",
  "autoUpdates": false
}`.replaceAll('\n', '\r\n'),
  },
  {
    fixture: 'an empty object stays on its line',
    text: EMPTY,
    path: ['obj', 'k'],
    value: true,
    after: `{
  "obj": {"k": true},
  "arr": [],
  "spread": {
  }
}`,
  },
  {
    fixture: 'an empty array stays on its line',
    text: EMPTY,
    path: ['arr', 0],
    value: 'x',
    after: `{
  "obj": {},
  "arr": ["x"],
  "spread": {
  }
}`,
  },
  {
    fixture: 'braces already split over lines get a member between them',
    text: EMPTY,
    path: ['spread', 'k'],
    value: 1,
    after: `{
  "obj": {},
  "arr": [],
  "spread": {
    "k": 1
  }
}`,
  },
];

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Replace the value at `path`, read it back, revert, and compare bytes. */
function replaceGate(set: Setter, name: string, text: string, path: JsonPath): string[] {
  const failures: string[] = [];
  const at = `${name} @ ${path.map(String).join('/')}`;
  const original = pluck(JSON.parse(text), path);

  let next: string;
  try {
    next = set(text, path, SENTINEL);
  } catch (err) {
    return [`${at}: the edit threw ${err instanceof Error ? err.message : String(err)}`];
  }
  if (next === text) failures.push(`${at}: the edit changed nothing`);

  try {
    const readBack = pluck(JSON.parse(next), path);
    if (readBack !== SENTINEL) {
      failures.push(`${at}: reads back as ${JSON.stringify(readBack)}, not the sentinel`);
    }
  } catch (err) {
    failures.push(`${at}: the edited text no longer parses -- ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const back = set(next, path, original);
    if (back !== text) {
      failures.push(
        `${at}: revert is not byte-identical -- ${diffAt(text, back)}` +
          ' (if the document is not JSON.stringify(_, null, 2) output here, that is the reason)',
      );
    }
  } catch (err) {
    failures.push(`${at}: the revert threw ${err instanceof Error ? err.message : String(err)}`);
  }

  return failures;
}

/** Insert a key that is not there, and prove the file gained exactly that one run. */
function insertGate(set: Setter, c: InsertCase): string[] {
  const failures: string[] = [];
  const at = `${c.fixture} + ${c.path.map(String).join('/')}`;

  let next: string;
  try {
    next = set(c.text, c.path, c.value);
  } catch (err) {
    return [`${at}: the insert threw ${err instanceof Error ? err.message : String(err)}`];
  }

  // Two expectations, and the weaker one first because its message is the readable one:
  // "the file gained one run" localises the bug, "the file is not this text" pins it.
  if (next === c.text) {
    failures.push(`${at}: the file did not gain exactly one contiguous run -- it did not change at all`);
  } else if (soleInsertion(c.text, next) === null) {
    failures.push(`${at}: the file did not gain exactly one contiguous run -- ${diffAt(c.text, next)}`);
  }
  if (next !== c.after) failures.push(`${at}: not the expected file -- ${diffAt(c.after, next)}`);

  try {
    assert.deepEqual(pluck(JSON.parse(next), c.path), c.value);
  } catch {
    failures.push(`${at}: the inserted value does not read back at its path`);
  }

  return failures;
}

function runGate(set: Setter, fixtures: readonly Fixture[], inserts: readonly InsertCase[]): string[] {
  const failures: string[] = [];
  for (const f of fixtures) for (const p of f.replace) failures.push(...replaceGate(set, f.name, f.text, p));
  for (const c of inserts) failures.push(...insertGate(set, c));
  return failures;
}

const report = (failures: string[]): string =>
  `\n  ${failures.length} failure(s):\n  ${failures.slice(0, 8).join('\n  ')}`;

// ---------------------------------------------------------------------------

describe('an edit changes one value and no other byte', () => {
  test('every fixture round-trips byte-identically', () => {
    const failures = runGate(real, FIXTURES, INSERTS);
    console.log(
      `    write: ${FIXTURES.reduce((n, f) => n + f.replace.length, 0)} replace paths, ` +
        `${INSERTS.length} inserts, over ${FIXTURES.length} fixtures`,
    );
    assert.deepEqual(failures, [], report(failures));
  });

  test('a value containing braces, brackets and quotes is one value', () => {
    const next = real(COMPACT, ['a'], 2);
    assert.equal(next, '{"a":2,"b":{"c":[1,2]},"tricky":"}{[],\\"quoted\\""}');
  });

  test('scanning past a 10,000-deep container needs no stack', () => {
    // The iterative skipper's reason to exist. A recursive one throws RangeError from
    // inside the scanner here, which is a crash and not a refusal.
    const next = real(DEEP, ['after'], 2);
    assert.ok(next.endsWith('},"after":2}'), next.slice(-24));
    assert.equal(next.length, DEEP.length);
  });

  test('and walking into one resolves the right level', () => {
    const path = ['deep', 'a', 'a', 'a'];
    const next = real(DEEP, path, SENTINEL);
    assert.equal(pluck(JSON.parse(next), path), SENTINEL);
    // One contiguous shrink: everything before and after the replaced span is untouched.
    assert.ok(next.startsWith('{"deep":{"a":{"a":{"a":"qm-DEA-139-sentinel"}'), next.slice(0, 60));
    assert.equal(next.endsWith('},"after":1}'), true);
  });

  test('an escaped key is the key it decodes to', () => {
    // A key spelled with a unicode escape is the key it decodes to; comparing the raw
    // bytes of the two spellings would make them two different keys.
    assert.equal(pluck(JSON.parse(real(ESCAPED, ['A'], 9)), ['A']), 9);
    assert.equal(pluck(JSON.parse(real(ESCAPED, ['c\\d'], 9)), ['c\\d']), 9);
    // And the neighbour whose raw bytes contain `"b":` is left alone.
    const next = real(ESCAPED, ['b'], 'moved');
    assert.equal(pluck(JSON.parse(next), ['a"b']), 'keep me');
  });

  /**
   * The one case where a value's bytes change without being the target.
   *
   * An inline array in an otherwise expanded document is not what
   * `JSON.stringify(_, null, 2)` writes, so re-encoding it expands it. Pinned rather
   * than hidden: the edit is still confined to that one value, and the assertion says
   * exactly how far the reformatting reaches.
   */
  test('reverting a non-canonical value reformats it, and nothing around it', () => {
    const inline = `{\n  "a": [1, 2],\n  "b": 3\n}`;
    const back = real(real(inline, ['a'], SENTINEL), ['a'], [1, 2]);
    assert.equal(back, `{\n  "a": [\n    1,\n    2\n  ],\n  "b": 3\n}`);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what it refuses rather than guesses', () => {
  test('duplicate keys', () => {
    const dup = `{\n  "a": 1,\n  "b": 2,\n  "a": 3\n}`;
    const r = refusalOf(setJsonValue(dup, ['a'], 4));
    assert.equal(r.reason, 'duplicate-key');
    assert.match(r.detail, /"a" appears 2 times/);
    // The same document is editable at a key that is not duplicated.
    assert.equal(edited(setJsonValue(dup, ['b'], 4)), `{\n  "a": 1,\n  "b": 4,\n  "a": 3\n}`);
  });

  test('a key written twice, once escaped, is still one key twice over', () => {
    const dup = `{\n  "A": 1,\n  "\\u0041": 2\n}`;
    assert.equal(refusalOf(setJsonValue(dup, ['A'], 3)).reason, 'duplicate-key');
  });

  test('a missing intermediate segment, because inventing one asserts a fact', () => {
    const r = refusalOf(setJsonValue(PRETTY, ['projects', '/Users/x/other', 'disabledMcpServers'], []));
    assert.equal(r.reason, 'no-such-path');
    assert.match(r.detail, /only the last segment is created/);
  });

  test('a path into a scalar', () => {
    assert.equal(refusalOf(setJsonValue(PRETTY, ['numStartups', 'x'], 1)).reason, 'not-a-container');
  });

  test('an index into an object, and a key into an array', () => {
    assert.equal(refusalOf(setJsonValue(PRETTY, ['projects', 0], 1)).reason, 'not-a-container');
    assert.equal(
      refusalOf(setJsonValue(PRETTY, ['projects', '/Users/x/proj', 'disabledMcpServers', 'a'], 1)).reason,
      'not-a-container',
    );
  });

  test('an array index past the end -- one past appends, further would need a hole', () => {
    const path = ['projects', '/Users/x/proj', 'disabledMcpServers', 4];
    const r = refusalOf(setJsonValue(PRETTY, path, 'x'));
    assert.equal(r.reason, 'no-such-path');
    assert.match(r.detail, /past the end of the 2-element array/);
  });

  test('the document root', () => {
    assert.equal(refusalOf(setJsonValue(PRETTY, [], {})).reason, 'empty-path');
  });

  test('a document that does not parse -- including one with a BOM', () => {
    assert.equal(refusalOf(setJsonValue('{"a": 1,}', ['a'], 2)).reason, 'not-json');
    // Written as the escape, never as the character: a literal BOM in a source file is
    // invisible to a reviewer and to half the tools that touch it.
    assert.equal(refusalOf(setJsonValue('\ufeff{"a": 1}', ['a'], 2)).reason, 'not-json');
    // JSONC is not JSON: a settings file with comments is refused, not silently stripped.
    assert.equal(refusalOf(setJsonValue('{\n  // note\n  "a": 1\n}', ['a'], 2)).reason, 'not-json');
  });

  test('a value JSON cannot carry', () => {
    assert.equal(refusalOf(setJsonValue(PRETTY, ['userID'], undefined)).reason, 'unserialisable');
    assert.equal(refusalOf(setJsonValue(PRETTY, ['userID'], () => 1)).reason, 'unserialisable');
    // NaN serialises to `null` without complaint. The read-back is what notices.
    const r = refusalOf(setJsonValue(PRETTY, ['numStartups'], Number.NaN));
    assert.equal(r.reason, 'postcondition');
    assert.match(r.detail, /reads back as null/);
  });
});

// ---------------------------------------------------------------------------
// The live file, copied
// ---------------------------------------------------------------------------

/**
 * The skip asks the machine; the assertions ask the code, and the two are different
 * questions (DEA-133). Whether `~/.claude.json` exists is a fact about where this runs --
 * CI and a fresh checkout have none. Whether an edit to it round-trips byte-identically
 * is a fact about `write.ts`, and nothing below derives one from the other.
 */
const LIVE = join(homedir(), '.claude.json');
const liveSkip = !existsSync(LIVE) && `no ${LIVE} on this machine`;

/** The six fields `readClaudeJson` builds its result from -- restated, not imported. */
const MODELLED = [
  'numStartups',
  'mcpServers',
  'projects',
  'claudeAiMcpEverConnected',
  'skillUsage',
  'pluginUsage',
];

let dir = '';
let liveCopy = '';
let liveText = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'qm-write-'));
  if (liveSkip) return;
  // A copy, in temp space. Nothing in this file opens the original for writing.
  liveCopy = join(dir, 'claude.json');
  copyFileSync(LIVE, liveCopy);
  liveText = readFileSync(liveCopy, 'utf8');
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Top-level members, found without this module's scanner.
 *
 * A second opinion on where each key's bytes are: JSON strings cannot contain a literal
 * newline, and a nested member is indented deeper, so `\n  "key": ` at column two can
 * only be a top-level member of a two-space-indented document. Comparing regions found
 * by `locate` would compare the scanner against itself.
 */
function topLevelRegions(text: string): Map<string, string> {
  const anchors: Array<[string, number]> = [];
  const re = /\n {2}"((?:[^"\\]|\\.)*)": /g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    anchors.push([JSON.parse(`"${m[1]!}"`) as string, m.index]);
  }
  const regions = new Map<string, string>();
  for (const [i, [key, start]] of anchors.entries()) {
    regions.set(key, text.slice(start, anchors[i + 1]?.[1] ?? text.length));
  }
  return regions;
}

describe('the live ~/.claude.json, on a copy', () => {
  test('every top-level key round-trips byte-identically', { skip: liveSkip }, () => {
    const keys = Object.keys(JSON.parse(liveText) as Record<string, unknown>);
    const failures: string[] = [];
    for (const key of keys) failures.push(...replaceGate(real, 'live', liveText, [key]));

    const unmodelled = keys.filter((k) => !MODELLED.includes(k));
    console.log(
      `    live: ${liveText.length} bytes, ${keys.length} top-level keys ` +
        `(${MODELLED.filter((k) => keys.includes(k)).length} modelled, ${unmodelled.length} not)`,
    );
    assert.deepEqual(failures, [], report(failures));
    assert.ok(unmodelled.length > 0, 'a file with nothing unmodelled proves nothing here');
  });

  test('and so does a nested project entry', { skip: liveSkip }, (t) => {
    /*
     * Whether this installation has ever run Claude Code inside a project -- a machine
     * fact, and not the DEA-133 defect wearing a different hat. The distinction is what
     * computes the guard: `JSON.parse` does, and nothing in `write.ts` is on that path,
     * so the assertions below stay free to fail wherever there is anything to assert
     * about. A `~/.claude.json` written moments ago has 8 keys and no `projects` at all
     * (measured, by pointing HOME at an empty directory and letting `claude` create one).
     */
    const registry = (JSON.parse(liveText) as { projects?: Record<string, unknown> }).projects ?? {};
    const projects = Object.keys(registry);
    if (projects.length === 0) return t.skip('this ~/.claude.json registers no projects');

    const failures = [
      ...replaceGate(real, 'live', liveText, ['projects', projects[0]!]),
      ...replaceGate(real, 'live', liveText, ['projects', projects.at(-1)!]),
    ];
    console.log(`    live: ${projects.length} project keys`);
    assert.deepEqual(failures, [], report(failures));
  });

  /**
   * The negative assertion, per key rather than over the whole file.
   *
   * The round trip above already proves no other byte moved, but it proves it as one
   * string comparison. This says which key survived, so a writer that drops `userID`
   * fails naming `userID`.
   */
  test('after one edit, every unmodelled key is byte-identical in its region', { skip: liveSkip }, () => {
    // Whichever key this file happens to put first, rather than a name it may not carry:
    // a fresh `~/.claude.json` has none of the five modelled keys.
    const target = Object.keys(JSON.parse(liveText) as Record<string, unknown>)[0]!;
    const after = real(liveText, [target], SENTINEL);

    const before = topLevelRegions(liveText);
    const now = topLevelRegions(after);
    assert.equal(
      before.size,
      Object.keys(JSON.parse(liveText) as Record<string, unknown>).length,
      'the region scan found fewer keys than the file has -- it is not two-space indented, ' +
        'so this check would pass without comparing anything',
    );
    assert.deepEqual([...now.keys()], [...before.keys()], 'the set or order of top-level keys moved');

    const moved: string[] = [];
    for (const [key, region] of before) {
      if (key !== target && now.get(key) !== region) moved.push(key);
    }
    assert.deepEqual(moved, [], `keys whose bytes moved: ${moved.slice(0, 10).join(', ')}`);

    // The issue's claim in its own terms, with the edited key taken out of it -- on a
    // fresh install every key is unmodelled, so the target can be one of them.
    const unmodelled = [...before.keys()].filter((k) => !MODELLED.includes(k) && k !== target);
    assert.deepEqual(unmodelled.filter((k) => now.get(k) !== before.get(k)), []);
    console.log(
      `    live: edited ${target}; ${unmodelled.length} other unmodelled keys byte-identical ` +
        `(${before.size} top-level keys in all)`,
    );
  });
});

// ---------------------------------------------------------------------------
// Staging, and the concurrent-write refusal
// ---------------------------------------------------------------------------

const SMALL = `{\n  "numStartups": 1,\n  "userID": "u",\n  "projects": {\n    "/p": {\n      "disabledMcpServers": []\n    }\n  }\n}`;

function scratch(name: string, text = SMALL): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function staged(path: string, edits: readonly Edit[]): Stage {
  const result = stageEdits(path, edits);
  if (result.outcome === 'refused') throw new Error(`staging refused: ${result.refusal.detail}`);
  return result.stage;
}

const EDITS: Edit[] = [
  { path: ['projects', '/p', 'disabledMcpServers'], value: ['linear-server'] },
  { path: ['projects', '/p', 'hasTrustDialogAccepted'], value: true },
];

describe('staging holds the batch; applying re-checks the file', () => {
  test('a quiet file gets exactly the staged bytes', () => {
    const path = scratch('quiet.json');
    const stage = staged(path, EDITS);

    const result = applyStage(stage);
    assert.equal(result.outcome, 'written');
    assert.equal(readFileSync(path, 'utf8'), stage.text);
    assert.deepEqual(
      (JSON.parse(stage.text) as { projects: Record<string, { disabledMcpServers: string[] }> }).projects['/p']
        ?.disabledMcpServers,
      ['linear-server'],
    );
    // The batch is one write, not one per edit.
    assert.equal(soleInsertion(SMALL, stage.text) === null, true, 'two edits should not read as one insertion');
    assert.equal(readdirSync(dir).filter((f) => f.includes('.qm-')).length, 0, 'a temp file was left behind');
  });

  /**
   * The refusal, provable. A round trip that only ever sees a quiescent file says
   * nothing about the case that actually happens: every live session writes `lastCost`
   * and `lastSessionId` into `~/.claude.json`, so this is the common path.
   */
  test('a file written between staging and applying is refused, and left alone', () => {
    const path = scratch('busy.json');
    const stage = staged(path, EDITS);

    const meanwhile = SMALL.replace('"numStartups": 1', '"numStartups": 2');
    writeFileSync(path, meanwhile);

    const result = applyStage(stage);
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') {
      assert.equal(result.refusal.reason, 'file-moved');
      assert.match(result.refusal.detail, /mtime \d/);
    }
    assert.equal(readFileSync(path, 'utf8'), meanwhile, 'the refusal still wrote');
  });

  /**
   * The hash half, isolated. A filesystem with a coarse timestamp, or two writes inside
   * one tick, gives back the mtime that was staged; only the content says otherwise.
   */
  test('and refused on content alone when the mtime agrees', () => {
    const path = scratch('same-mtime.json');
    const stage = staged(path, EDITS);

    writeFileSync(path, SMALL.replace('"userID": "u"', '"userID": "v"'));
    const asIfUnmoved: Stage = { ...stage, mtimeMs: statSync(path).mtimeMs };

    const result = applyStage(asIfUnmoved);
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') {
      assert.equal(result.refusal.reason, 'file-moved');
      assert.match(result.refusal.detail, /content \w+ -> \w+ with mtime unchanged/);
    }
  });

  test('a file deleted between staging and applying is refused', () => {
    const path = scratch('gone.json');
    const stage = staged(path, EDITS);
    unlinkSync(path);

    const result = applyStage(stage);
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') assert.equal(result.refusal.reason, 'file-vanished');
  });

  test('a refused edit refuses the whole batch, naming which one', () => {
    const path = scratch('batch.json');
    const result = stageEdits(path, [EDITS[0]!, { path: ['projects', '/nope', 'x'], value: 1 }]);
    assert.equal(result.outcome, 'refused');
    if (result.outcome === 'refused') {
      assert.equal(result.refusal.reason, 'no-such-path');
      assert.match(result.refusal.detail, /^edit 1: /);
    }
    assert.equal(readFileSync(path, 'utf8'), SMALL, 'staging wrote');
  });

  test('the mode survives the rename', () => {
    // `~/.claude.json` is 0600 here. A temp file made under the default umask would
    // publish it at 0644 -- the rename would widen a file it was only meant to edit.
    const path = scratch('mode.json');
    chmodSync(path, 0o600);
    const stage = staged(path, EDITS);
    assert.equal(applyStage(stage).outcome, 'written');
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test('staging a copy of the live file, and refusing when it moves', { skip: liveSkip }, () => {
    const path = join(dir, 'live-apply.json');
    copyFileSync(LIVE, path);
    const target = Object.keys(JSON.parse(liveText) as Record<string, unknown>)[0]!;
    const stage = staged(path, [{ path: [target], value: SENTINEL }]);

    // A telemetry write, the way a live session makes one. Written as a prepend so it
    // lands on any `~/.claude.json`, however few keys it has.
    const moved = readFileSync(path, 'utf8').replace('{', '{"lastCost":0.0123,');
    writeFileSync(path, moved);

    const result = applyStage(stage);
    assert.equal(result.outcome, 'refused');
    assert.equal(readFileSync(path, 'utf8'), moved);
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

/**
 * Mutants built from the real `locate`, so each breaks exactly one decision and the
 * corpus is what has to notice. A second copy of the scanner, broken on purpose, would
 * drift from the first the day either is edited -- which is the reason `spliceAt` and
 * `locate` are exported at all.
 */
interface Mutant {
  name: string;
  set: Setter;
  names: RegExp;
}

function sited(text: string, path: JsonPath) {
  const found = locate(text, path);
  if (found.outcome === 'refused') throw new Error(`locate refused: ${found.refusal.detail}`);
  return found.site;
}

const MUTANTS: Mutant[] = [
  {
    name: 'span ends one byte short',
    set: (text, path, value) => {
      const site = sited(text, path);
      return site.kind === 'replace' ? spliceAt(text, { ...site, end: site.end - 1 }, value) : real(text, path, value);
    },
    names: /no longer parses|revert is not byte-identical|reads back as/,
  },
  {
    name: 'span starts one byte early',
    set: (text, path, value) => {
      const site = sited(text, path);
      return site.kind === 'replace' ? spliceAt(text, { ...site, start: site.start - 1 }, value) : real(text, path, value);
    },
    names: /no longer parses|revert is not byte-identical|reads back as/,
  },
  {
    name: 'the insert path drops the edit',
    set: (text, path, value) => (sited(text, path).kind === 'insert' ? text : real(text, path, value)),
    names: /did not gain exactly one contiguous run/,
  },
  {
    /**
     * The scanner someone writes having only ever seen keys that need no escaping --
     * which is every key in the live file. It searches the raw text for `"key":`, so on
     * `{"a\"b": ..., "b": ...}` it finds the escaped quote inside the first key and
     * edits that member instead. Anything it cannot express is delegated, so it differs
     * from the real one on exactly the question the corpus asks.
     */
    name: 'naive key search, no escape handling',
    set: (text, path, value) => {
      const key = path[0];
      if (path.length !== 1 || typeof key !== 'string') return real(text, path, value);
      const needle = `"${key}":`;
      const i = text.indexOf(needle);
      if (i === -1) return real(text, path, value);
      let start = i + needle.length;
      while (text.charAt(start) === ' ') start++;
      let end = start;
      while (end < text.length && !',}\n'.includes(text.charAt(end))) end++;
      return text.slice(0, start) + JSON.stringify(value) + text.slice(end);
    },
    // Named exactly, and not by a looser alternation: this mutant mangles other fixtures
    // too, for reasons that have nothing to do with escapes. The divergence it exists to
    // demonstrate is the one on `escaped keys`, where the raw bytes of the key `a"b`
    // contain `"b":` and the naive search edits that member's value instead.
    names: /^escaped keys @ b: reads back as "target", not the sentinel$/,
  },
];

describe('the gate fails when the primitive is wrong', () => {
  for (const mutant of MUTANTS) {
    test(mutant.name, () => {
      const failures = runGate(mutant.set, FIXTURES, INSERTS);
      assert.ok(
        failures.length > 0,
        `mutant "${mutant.name}" passed the gate -- that is a hole in the gate, not a mutant to delete`,
      );
      assert.ok(
        failures.some((f) => mutant.names.test(f)),
        `the gate failed, but for the wrong reason: ${report(failures)}`,
      );
      console.log(`    caught "${mutant.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  test('and passes when it is not', () => {
    assert.deepEqual(runGate(real, FIXTURES, INSERTS), []);
  });
});
