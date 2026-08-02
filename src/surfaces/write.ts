/**
 * Surgical edits to a JSON config file, as text.
 *
 * Nothing calls this. Phase 1 is read-only and stays that way; this is the primitive
 * Phase 2 needs and the one place the concurrent-write rule can be enforced once.
 *
 * ## Why text and not parse-modify-serialise
 *
 * `readClaudeJson` builds its result from five named fields. The live `~/.claude.json`
 * on this machine has 83 top-level keys, so 78 -- `userID`, `installMethod`,
 * `firstStartTime`, a family of migration flags -- exist only as bytes nobody modelled.
 * A writer that parses, edits and re-serialises destroys all 78.
 *
 * Modelling them instead is the obvious fix and the wrong one: it makes this repo
 * responsible for tracking a key set another program owns, and the day it falls behind
 * is a silent data loss rather than a failure. `SettingsFile.rest` is that bargain
 * already made once -- see the note at the bottom of this file.
 *
 * Even a lossless parse does not survive `JSON.stringify`: it reformats the whole
 * document, so every byte moves and a diff shows the file rewritten. CLAUDE.md's
 * convention -- *"JSON edits are surgical: change only target keys, never rewrite a
 * file"* -- read literally rules the round trip out. So: find the byte span of one
 * value, splice, leave every other byte alone.
 *
 * ## What is refused
 *
 * A refusal is an answer. Silent misbehaviour is not, so every case this scanner
 * cannot handle correctly leaves as a typed `Refusal` naming the offset: duplicate
 * keys, a missing intermediate segment, a path into a scalar, an unserialisable value,
 * a document that does not parse. `EditResult` and `ApplyResult` share no fields
 * beyond `outcome`, so nothing reads a result without narrowing it first.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Object keys are arbitrary strings; array indices are numbers. */
export type JsonPath = readonly (string | number)[];

export type RefusalReason =
  /** The whole document is not a target -- replacing the root is rewriting the file. */
  | 'empty-path'
  | 'not-json'
  /** Decoding the bytes as UTF-8 and re-encoding them did not give the bytes back. */
  | 'not-utf8'
  | 'malformed'
  | 'no-such-path'
  | 'not-a-container'
  | 'duplicate-key'
  | 'unserialisable'
  /** The splice landed, but reading the value back did not return what was written. */
  | 'postcondition'
  | 'file-vanished'
  | 'file-moved';

export interface Refusal {
  reason: RefusalReason;
  /** Names the offset or key, so a refusal can be acted on rather than only reported. */
  detail: string;
}

export type EditResult =
  | { outcome: 'edited'; text: string }
  | { outcome: 'refused'; refusal: Refusal };

export type LocateResult =
  | { outcome: 'located'; site: Site }
  | { outcome: 'refused'; refusal: Refusal };

export type StageResult =
  | { outcome: 'staged'; stage: Stage }
  | { outcome: 'refused'; refusal: Refusal };

export type ApplyResult =
  | { outcome: 'written'; bytes: number }
  | { outcome: 'refused'; refusal: Refusal };

/**
 * Where a value sits, or where one would go.
 *
 * Exported because the span is the reviewable unit: a caller showing what an edit will
 * touch wants the offsets, not the resulting document. It is also what lets the tests
 * mutate this scanner -- a doctored `Site` through `spliceAt` is the off-by-one bug
 * exactly, without a second copy of the scanner to drift against the first.
 */
export type Site =
  | { kind: 'replace'; start: number; end: number; indent: string; unit: string }
  | {
      kind: 'insert';
      at: number;
      /** The separator, copied from the file rather than invented. */
      prefix: string;
      /** `"key": ` for an object member, empty for an array element. */
      label: string;
      indent: string;
      unit: string;
    };

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

class RefusedError extends Error {
  refusal: Refusal;
  constructor(refusal: Refusal) {
    super(`${refusal.reason}: ${refusal.detail}`);
    this.refusal = refusal;
  }
}

const refusal = (reason: RefusalReason, detail: string): RefusedError =>
  new RefusedError({ reason, detail });

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const SCALAR_END = new Set([',', '}', ']', ' ', '\t', '\n', '\r']);

function skipWs(text: string, i: number): number {
  while (i < text.length && WHITESPACE.has(text.charAt(i))) i++;
  return i;
}

/**
 * End of the string literal opening at `i`, one past its closing quote.
 *
 * The two-character skip after a backslash is the whole of escape handling, and the
 * live file exercises none of it: 0 of its 83 top-level keys and 0 of its 139 project
 * keys need an escape. So a scanner that searches for the next `"`, or for the literal
 * `"key"`, passes on this machine and corrupts the first one whose project path
 * contains a quote or a backslash. `\uXXXX` needs no special case -- the four hex
 * digits are ordinary characters that cannot close a string.
 */
function endOfString(text: string, i: number): number {
  for (let j = i + 1; j < text.length; ) {
    const c = text.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    j++;
  }
  throw refusal('malformed', `unterminated string at ${i}`);
}

/**
 * End of the value starting at `i`.
 *
 * Containers are skipped with the depth in a counter rather than on the call stack.
 * A document nested a few thousand deep is legal JSON, and a recursive skipper meets it
 * with a RangeError from somewhere inside this file rather than a refusal naming it.
 */
function endOfValue(text: string, i: number): number {
  const c = text.charAt(i);
  if (c === '"') return endOfString(text, i);

  if (c !== '{' && c !== '[') {
    let j = i;
    while (j < text.length && !SCALAR_END.has(text.charAt(j))) j++;
    if (j === i) throw refusal('malformed', `expected a value at ${i}`);
    return j;
  }

  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text.charAt(j);
    if (ch === '"') {
      j = endOfString(text, j);
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      j++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  throw refusal('malformed', `unterminated container at ${i}`);
}

interface Member {
  key: string;
  /** Just past the `{` or `,` before it: the start of the whitespace it is laid out with. */
  leadStart: number;
  keyStart: number;
  /** Everything between the key and its value -- `": "` here, `":"` in a compact file. */
  sep: string;
  valueStart: number;
  valueEnd: number;
}

function members(text: string, open: number): Member[] {
  const out: Member[] = [];
  let i = open + 1;
  if (text.charAt(skipWs(text, i)) === '}') return out;

  for (;;) {
    const leadStart = i;
    i = skipWs(text, i);
    if (text.charAt(i) !== '"') throw refusal('malformed', `expected a key at ${i}`);
    const keyStart = i;
    const keyEnd = endOfString(text, keyStart);
    // Decoded through `JSON.parse` rather than compared raw: a key written with a
    // unicode escape and the same key written literally are one key, and the spec's own
    // decoder is the only thing guaranteed to agree with the `JSON.parse` a reader will
    // use on this file.
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;

    i = skipWs(text, keyEnd);
    if (text.charAt(i) !== ':') throw refusal('malformed', `expected ':' after the key at ${keyStart}`);
    const valueStart = skipWs(text, i + 1);
    const valueEnd = endOfValue(text, valueStart);
    out.push({ key, leadStart, keyStart, sep: text.slice(keyEnd, valueStart), valueStart, valueEnd });

    i = skipWs(text, valueEnd);
    const c = text.charAt(i);
    if (c === ',') {
      i += 1;
      continue;
    }
    if (c === '}') return out;
    throw refusal('malformed', `expected ',' or '}' at ${i}`);
  }
}

interface Element {
  leadStart: number;
  valueStart: number;
  valueEnd: number;
}

function elements(text: string, open: number): Element[] {
  const out: Element[] = [];
  let i = open + 1;
  if (text.charAt(skipWs(text, i)) === ']') return out;

  for (;;) {
    const leadStart = i;
    const valueStart = skipWs(text, i);
    const valueEnd = endOfValue(text, valueStart);
    out.push({ leadStart, valueStart, valueEnd });

    i = skipWs(text, valueEnd);
    const c = text.charAt(i);
    if (c === ',') {
      i += 1;
      continue;
    }
    if (c === ']') return out;
    throw refusal('malformed', `expected ',' or ']' at ${i}`);
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The document's indent unit, read off its first indented line. `''` for compact JSON. */
function indentUnit(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1]! : '';
}

/** The whitespace the line holding `i` begins with. */
function lineIndent(text: string, i: number): string {
  const start = text.lastIndexOf('\n', i) + 1;
  let j = start;
  while (j < text.length && (text.charAt(j) === ' ' || text.charAt(j) === '\t')) j++;
  return text.slice(start, Math.min(j, i));
}

const newline = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/**
 * The value, rendered to sit where it is going.
 *
 * `unit === ''` is compact JSON on one line, which is both what a compact document
 * wants and what a member already written inline wants. Continuation lines carry the
 * member's own indent, and the document's line ending -- not `\n` -- because a value
 * spliced with the wrong ending leaves a file mixing both.
 */
function encode(value: unknown, indent: string, unit: string, nl: string): string {
  const json = JSON.stringify(value, null, unit);
  if (json === undefined) {
    throw refusal('unserialisable', `JSON.stringify produced nothing for ${typeof value}`);
  }
  if (unit === '') return json;
  return json.split('\n').map((line, k) => (k === 0 ? line : indent + line)).join(nl);
}

function objectInsertSite(text: string, open: number, ms: Member[], key: string, unit: string): Site {
  const last = ms.at(-1);

  if (last) {
    // The separator between two existing members, and the one between a key and its
    // value, reused verbatim: two strings that already carry the newline, the depth,
    // tabs-versus-spaces and whether this file puts a space after the colon. Rebuilding
    // either from a guess is what writes `"k": 1` into a file that writes `"k":1`.
    const lead = text.slice(last.leadStart, last.keyStart);
    return {
      kind: 'insert',
      at: last.valueEnd,
      prefix: `,${lead}`,
      label: JSON.stringify(key) + last.sep,
      indent: lineIndent(text, last.keyStart),
      unit: lead.includes('\n') ? unit : '',
    };
  }

  // Nothing to copy from, so the document's own indent decides: a file with no
  // whitespace anywhere gets none here either.
  const label = `${JSON.stringify(key)}:${unit === '' ? '' : ' '}`;

  // Empty container: nothing to copy, so the shape of the braces decides. `{}` stays on
  // its line; a `{` and `}` already split across lines gets a member between them at one
  // more level of indent, and the closing brace is not touched either way.
  const inner = text.slice(open + 1, endOfValue(text, open) - 1);
  if (!inner.includes('\n')) {
    return { kind: 'insert', at: open + 1, prefix: '', label, indent: '', unit: '' };
  }
  const indent = lineIndent(text, open) + (unit || '  ');
  return { kind: 'insert', at: open + 1, prefix: newline(text) + indent, label, indent, unit };
}

function arrayInsertSite(text: string, open: number, els: Element[], unit: string): Site {
  const last = els.at(-1);
  if (last) {
    const lead = text.slice(last.leadStart, last.valueStart);
    return {
      kind: 'insert',
      at: last.valueEnd,
      prefix: `,${lead}`,
      label: '',
      indent: lineIndent(text, last.valueStart),
      unit: lead.includes('\n') ? unit : '',
    };
  }
  const inner = text.slice(open + 1, endOfValue(text, open) - 1);
  if (!inner.includes('\n')) {
    return { kind: 'insert', at: open + 1, prefix: '', label: '', indent: '', unit: '' };
  }
  const indent = lineIndent(text, open) + (unit || '  ');
  return { kind: 'insert', at: open + 1, prefix: newline(text) + indent, label: '', indent, unit };
}

// ---------------------------------------------------------------------------
// Locating
// ---------------------------------------------------------------------------

const describe = (path: JsonPath, depth: number): string =>
  depth === 0 ? '(root)' : path.slice(0, depth).map((s) => JSON.stringify(s)).join(' -> ');

function locateOrThrow(text: string, path: JsonPath): Site {
  if (path.length === 0) {
    throw refusal('empty-path', 'the document root is not a target: replacing it rewrites the file');
  }

  const unit = indentUnit(text);
  let i = skipWs(text, 0);

  for (let d = 0; d < path.length; d++) {
    const seg = path[d]!;
    const last = d === path.length - 1;
    const at = describe(path, d);
    const open = text.charAt(i);

    if (open === '{') {
      if (typeof seg !== 'string') {
        throw refusal('not-a-container', `${at} is an object, but segment ${d} is the index ${seg}`);
      }
      const ms = members(text, i);
      const hits = ms.filter((m) => m.key === seg);

      // Legal JSON, and `JSON.parse` keeps the last. Editing the last would be correct
      // and would still leave a shadowed copy for the next reader to trip over; editing
      // the first would change nothing a reader can see. Neither is an edit worth making
      // without someone looking at the file.
      if (hits.length > 1) {
        throw refusal(
          'duplicate-key',
          `${JSON.stringify(seg)} appears ${hits.length} times in ${at} ` +
            `(offsets ${hits.map((h) => h.keyStart).join(', ')})`,
        );
      }

      const hit = hits[0];
      if (!hit) {
        // Only the leaf is created. Building the missing parents would mean inventing a
        // `projects[<path>]` entry that Claude Code never registered, which is a fact
        // about the machine this tool is not entitled to assert.
        if (!last) {
          throw refusal('no-such-path', `${at} has no key ${JSON.stringify(seg)}, and only the last segment is created`);
        }
        return objectInsertSite(text, i, ms, seg, unit);
      }
      if (last) {
        return {
          kind: 'replace',
          start: hit.valueStart,
          end: hit.valueEnd,
          indent: lineIndent(text, hit.keyStart),
          unit,
        };
      }
      i = hit.valueStart;
      continue;
    }

    if (open === '[') {
      if (typeof seg !== 'number' || !Number.isInteger(seg) || seg < 0) {
        throw refusal('not-a-container', `${at} is an array, but segment ${d} is ${JSON.stringify(seg)}`);
      }
      const els = elements(text, i);
      const el = els[seg];
      if (el) {
        if (last) {
          return {
            kind: 'replace',
            start: el.valueStart,
            end: el.valueEnd,
            indent: lineIndent(text, el.valueStart),
            unit,
          };
        }
        i = el.valueStart;
        continue;
      }
      // One past the end appends. Further than that would need holes, which JSON has no
      // way to write.
      if (seg === els.length && last) return arrayInsertSite(text, i, els, unit);
      throw refusal('no-such-path', `index ${seg} is past the end of the ${els.length}-element array at ${at}`);
    }

    throw refusal('not-a-container', `${at} is a scalar, so ${JSON.stringify(seg)} resolves to nothing`);
  }

  // Unreachable: the loop returns on its last segment. Here so the function has no
  // implicit fall-through if a branch above ever gains a `continue`.
  throw refusal('no-such-path', `${describe(path, path.length)} was not reached`);
}

export function locate(text: string, path: JsonPath): LocateResult {
  try {
    return { outcome: 'located', site: locateOrThrow(text, path) };
  } catch (err) {
    if (err instanceof RefusedError) return { outcome: 'refused', refusal: err.refusal };
    throw err;
  }
}

/** The splice itself. Every byte outside the span is carried over by construction. */
export function spliceAt(text: string, site: Site, value: unknown): string {
  const body = encode(value, site.indent, site.unit, newline(text));
  return site.kind === 'replace'
    ? text.slice(0, site.start) + body + text.slice(site.end)
    : text.slice(0, site.at) + site.prefix + site.label + body + text.slice(site.at);
}

function pluck(root: unknown, path: JsonPath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[String(seg)];
  }
  return cur;
}

/**
 * Replace -- or insert -- the value at `path`, and change nothing else.
 *
 * The document is parsed twice and serialised never. The first parse rejects input this
 * scanner has no business walking; the second is the postcondition, and it is what turns
 * a class of quiet bugs into a refusal: a span located one member early puts the value
 * somewhere else, `NaN` serialises to `null`, an `undefined` inside an object is dropped.
 * All three read back as something other than what was asked for.
 *
 * Text offsets are UTF-16 code units and the concurrency check hashes UTF-8 bytes. The
 * two never mix: `stageEdits` proves the decode is lossless before either is used.
 */
export function setJsonValue(text: string, path: JsonPath, value: unknown): EditResult {
  try {
    JSON.parse(text);
  } catch (err) {
    return {
      outcome: 'refused',
      refusal: { reason: 'not-json', detail: err instanceof Error ? err.message : String(err) },
    };
  }

  try {
    const site = locateOrThrow(text, path);
    const next = spliceAt(text, site, value);
    const readBack = pluck(JSON.parse(next), path);
    if (!isDeepStrictEqual(readBack, value)) {
      throw refusal(
        'postcondition',
        `${describe(path, path.length)} reads back as ${JSON.stringify(readBack)}, not ${JSON.stringify(value)}`,
      );
    }
    return { outcome: 'edited', text: next };
  } catch (err) {
    if (err instanceof RefusedError) return { outcome: 'refused', refusal: err.refusal };
    if (err instanceof SyntaxError) {
      return { outcome: 'refused', refusal: { reason: 'postcondition', detail: `the edit did not parse: ${err.message}` } };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Staging and applying
// ---------------------------------------------------------------------------

export interface Edit {
  path: JsonPath;
  value: unknown;
}

export interface Stage {
  path: string;
  /** SHA-256 of the bytes read. Half of what proves nothing moved. */
  hash: string;
  mtimeMs: number;
  /** The whole file as it would be written. Reviewable before anything is applied. */
  text: string;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/**
 * Read, apply the batch in memory, and hold what it produced.
 *
 * A batch and not one edit at a time, because CLAUDE.md's convention is that edits
 * stage and apply as one reviewed batch: an eight-edit apply that half-succeeds leaves
 * a config in a state no one chose.
 */
export function stageEdits(path: string, edits: readonly Edit[]): StageResult {
  if (!existsSync(path)) {
    return { outcome: 'refused', refusal: { reason: 'file-vanished', detail: `no file at ${path}` } };
  }

  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  // A lossy decode silently rewrites bytes -- an invalid sequence becomes U+FFFD and the
  // splice carries it back to disk. Everything below works on the string, so this is
  // where that has to be caught.
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    return { outcome: 'refused', refusal: { reason: 'not-utf8', detail: `${path} does not round-trip through UTF-8` } };
  }
  const mtimeMs = statSync(path).mtimeMs;

  let next = text;
  for (const [n, edit] of edits.entries()) {
    const result = setJsonValue(next, edit.path, edit.value);
    if (result.outcome === 'refused') {
      return {
        outcome: 'refused',
        refusal: { reason: result.refusal.reason, detail: `edit ${n}: ${result.refusal.detail}` },
      };
    }
    next = result.text;
  }

  return { outcome: 'staged', stage: { path, hash: sha256(buf), mtimeMs, text: next } };
}

/**
 * Write the staged text, if the file is still the one that was staged.
 *
 * Every live Claude Code session writes telemetry into `~/.claude.json` -- `lastCost`,
 * `lastSessionId` -- so between staging and applying it moves under the tool routinely.
 * mtime and content hash are both checked because each misses on its own: a coarse
 * filesystem timestamp hides a fast write, and a hash alone cannot tell a file being
 * actively written from a quiet one.
 *
 * The check is unconditional rather than special-cased for `~/.claude.json`. A rule that
 * applies to one path is a rule someone forgets at the second call site.
 *
 * A window remains between the check and the rename. Closing it needs a lock Claude Code
 * does not take and would not honour; what is on offer is refusing every collision
 * anyone can observe, not a guarantee.
 */
export function applyStage(stage: Stage): ApplyResult {
  if (!existsSync(stage.path)) {
    return { outcome: 'refused', refusal: { reason: 'file-vanished', detail: `${stage.path} is gone since staging` } };
  }

  const stat = statSync(stage.path);
  if (stat.mtimeMs !== stage.mtimeMs) {
    return {
      outcome: 'refused',
      refusal: { reason: 'file-moved', detail: `mtime ${stage.mtimeMs} -> ${stat.mtimeMs} since staging` },
    };
  }
  const current = sha256(readFileSync(stage.path));
  if (current !== stage.hash) {
    return {
      outcome: 'refused',
      refusal: {
        reason: 'file-moved',
        detail: `content ${stage.hash.slice(0, 12)} -> ${current.slice(0, 12)} with mtime unchanged`,
      },
    };
  }

  // Same directory, so the rename cannot cross a filesystem and degrade to a copy. The
  // file this replaces is 200KB of a working installation; a half-written one is worse
  // than no write at all, and only rename is atomic.
  const tmp = join(dirname(stage.path), `.${basename(stage.path)}.qm-${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx');
    // The original mode, restored explicitly: `~/.claude.json` is 0600 here, and a new
    // file made under the default umask would publish it at 0644.
    fchmodSync(fd, stat.mode & 0o777);
    writeFileSync(fd, stage.text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, stage.path);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw err;
  }

  return { outcome: 'written', bytes: Buffer.byteLength(stage.text) };
}

/**
 * On `SettingsFile.rest`.
 *
 * `rest` exists to let a writer round-trip a settings file without loss, and this module
 * does that job for every JSON file without holding a copy of anything. Two mechanisms
 * for one property is the drift condition this project keeps legislating against -- and
 * `rest` is the one that costs elsewhere: `view/model.ts` builds its payload key by key
 * specifically because `rest` is unbounded and unknown by construction, so whatever the
 * next Claude Code release adds lands in it and would reach a browser.
 *
 * Retiring it is a wide refactor across the readers, the view boundary and their tests,
 * so it is recommended here and filed separately rather than done in passing.
 */
