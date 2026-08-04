/**
 * The scheduled live-oracle check (DEA-118).
 *
 * Nothing here spawns `claude` and nothing here reaches Linear. The oracle is the
 * recorded differential fixture replayed through the same `OracleReader` the live check
 * uses, which makes the two interesting inputs available at once: an oracle that agrees,
 * because it is the one 1,050 pairs were captured against, and an oracle that has
 * *changed its answer*, which is the whole event this check exists to notice and which a
 * recording can otherwise never produce.
 *
 * The order below matters. Silence is the healthy signal, and a check that is silent
 * because it is broken passes a silence test perfectly -- so the divergence scenario is
 * asserted first and the silence scenario is only meaningful given it. Then three wrong
 * dedupe rules are shipped against the same scenarios, each caught by a different one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decide,
  divergenceKey,
  isStale,
  pairKeys,
  readRunState,
  runOracleCheck,
  statusReport,
  STALE_AFTER_DAYS,
  type CheckOutcome,
  type DecideFn,
  type DivergenceRecord,
  type FirstPartyPlugin,
  type IssueDraft,
  type Mismatch,
  type OracleReader,
  type RunState,
  type Verdict,
} from '../src/oracle.ts';
import type { Workspace } from '../src/surfaces/types.ts';
import { loadFixtureWorkspace, readOracle, readManifest } from './fixtures/differential/load.ts';

const MANIFEST = readManifest();
const RECORDED = readOracle();

/**
 * The two live fixture projects the generator never asked the oracle about -- it answers
 * about plugins, and those two carry a constructed skill and MCP surface. They are asked
 * here and do not answer, which is what an unreadable project looks like.
 */
const UNASKED = MANIFEST.skillProbeProjects.length + MANIFEST.mcpProbeProjects.length;

/** The oracle as recorded: the answers the resolver was proven against. */
const agreeing: OracleReader = (cwd) => RECORDED[cwd] ?? null;

/**
 * A Claude Code release that resolves one pair differently.
 *
 * Flipping the recorded `enabled` is exactly the event this is built for -- the config
 * on disk is unchanged, our resolution of it is unchanged, and the first-party answer
 * moved. Nothing else can simulate that, because every other input agrees with itself.
 */
function oracleThatFlipped(...pairs: Array<[string, string]>): OracleReader {
  const flips = new Map<string, Set<string>>();
  for (const [project, plugin] of pairs) {
    const set = flips.get(project) ?? new Set<string>();
    set.add(plugin);
    flips.set(project, set);
  }
  return (cwd) => {
    const answer = RECORDED[cwd];
    if (!answer) return null;
    const wanted = flips.get(cwd);
    if (!wanted) return answer;
    return answer.map((p): FirstPartyPlugin =>
      wanted.has(p.id) ? { id: p.id, enabled: !p.enabled } : p,
    );
  };
}

/** A pair the fixture actually has, chosen from the recording rather than invented. */
function somePair(skip = 0): [string, string] {
  let seen = 0;
  for (const [project, plugins] of Object.entries(RECORDED)) {
    for (const p of plugins) {
      if (seen++ === skip) return [project, p.id];
    }
  }
  throw new Error('the recorded oracle has no pairs at all');
}

const PAIR_A = somePair(0);
const PAIR_B = somePair(1);

/** A pair as `comparePairs` would have reported it. Only the two ids are ever read. */
const mismatchOf = ([project, plugin]: [string, string]): Mismatch => ({
  project,
  plugin,
  firstParty: true,
  resolver: false,
  origin: 'inherited',
  chain: 'user=false',
});

const WS: Workspace = loadFixtureWorkspace();

// ---------------------------------------------------------------------------
// A harness that runs a sequence of checks against one state file
// ---------------------------------------------------------------------------

interface Session {
  outcomes: CheckOutcome[];
  filed: IssueDraft[];
  state: RunState | null;
}

/** Every filing this session made, so "one issue, not one per run" is countable. */
async function play(
  readers: readonly OracleReader[],
  opts: { decide?: DecideFn } = {},
): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), 'qm-oracle-'));
  const statePath = join(dir, 'oracle-run.json');
  const filed: IssueDraft[] = [];
  const outcomes: CheckOutcome[] = [];

  try {
    let tick = 0;
    for (const read of readers) {
      outcomes.push(
        await runOracleCheck({
          ws: WS,
          read,
          statePath,
          now: new Date(Date.UTC(2026, 0, 1 + tick++)),
          file: async (draft) => {
            filed.push(draft);
            return { identifier: `DEA-${900 + filed.length}`, url: 'https://linear.app/x' };
          },
          ...(opts.decide ? { decide: opts.decide } : {}),
        }),
      );
    }
    return { outcomes, filed, state: readRunState(statePath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The scenarios. Each is one claim the issue makes about the check.
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  readers: OracleReader[];
  /** Which runs must have said something, by index. */
  speaks: number[];
  /** How many issues the whole session must file. */
  files: number;
}

const SCENARIOS: Scenario[] = [
  {
    // Asserted first on purpose: a check that reports nothing because it is broken
    // passes the silence scenario perfectly, so silence only means anything once this
    // one has shown the check can speak.
    name: 'a changed oracle is reported',
    readers: [oracleThatFlipped(PAIR_A)],
    speaks: [0],
    files: 1,
  },
  {
    name: 'an unchanged oracle says nothing and files nothing',
    readers: [agreeing],
    speaks: [],
    files: 0,
  },
  {
    // The dedupe. Two runs, the same disagreement: one issue.
    name: 'the same divergence twice files once',
    readers: [oracleThatFlipped(PAIR_A), oracleThatFlipped(PAIR_A)],
    speaks: [0, 1],
    files: 1,
  },
  {
    // A second, different divergence while the first is open. It files again, because
    // the open issue's table no longer describes what disagrees.
    name: 'a different divergence while the first is open files again',
    readers: [oracleThatFlipped(PAIR_A), oracleThatFlipped(PAIR_A, PAIR_B)],
    speaks: [0, 1],
    files: 2,
  },
  {
    // A divergence that goes away is forgotten, so its return is news rather than a
    // silent `known`.
    name: 'a divergence that is fixed and returns files again',
    readers: [oracleThatFlipped(PAIR_A), agreeing, oracleThatFlipped(PAIR_A)],
    speaks: [0, 2],
    files: 2,
  },
];

/** Every way a session and its scenario disagree, named. */
function diff(s: Scenario, session: Session): string[] {
  const out: string[] = [];
  session.outcomes.forEach((o, i) => {
    const shouldSpeak = s.speaks.includes(i);
    if (shouldSpeak && o.report === null) out.push(`${s.name}: run ${i} was silent, expected a report`);
    if (!shouldSpeak && o.report !== null) {
      out.push(`${s.name}: run ${i} said "${o.report.split('\n')[0]}", expected silence`);
    }
  });
  if (session.filed.length !== s.files) {
    out.push(`${s.name}: filed ${session.filed.length} issue(s), expected ${s.files}`);
  }
  return out;
}

describe('the oracle check speaks only when the answers moved', () => {
  for (const s of SCENARIOS) {
    test(s.name, async () => {
      assert.deepEqual(diff(s, await play(s.readers)), []);
    });
  }
});

describe('what the report of a changed oracle says', () => {
  test('it names every diverging pair, and only those', async () => {
    const { outcomes, filed } = await play([oracleThatFlipped(PAIR_A, PAIR_B)]);
    const [run] = outcomes;
    assert.ok(run);

    assert.equal(run.run.mismatches.length, 2);
    assert.equal(run.run.compared, MANIFEST.pairs, 'the whole recorded oracle was compared');
    assert.equal(run.run.projects, MANIFEST.oracleProjects);
    assert.equal(run.run.unreadable.length, UNASKED);
    assert.equal(run.broken, false);

    // Both scopes still decide pairs, so a divergence here is a divergence in a
    // comparison that can actually see project- and local-scope precedence.
    assert.deepEqual(run.run.decided, {
      project: MANIFEST.decidedByScope.project,
      local: MANIFEST.decidedByScope.local,
    });

    for (const [project, plugin] of [PAIR_A, PAIR_B]) {
      assert.ok(run.report?.includes(project), `the report names ${project}`);
      assert.ok(run.report?.includes(plugin), `the report names ${plugin}`);
      assert.ok(filed[0]?.body.includes(plugin), `the issue body names ${plugin}`);
    }

    // The narrowing, in every user-facing place. It is very easy to read "the oracle
    // agrees" as "drift is handled", and three of the four behaviours are unmeasured.
    assert.match(run.report!, /does not check `claude plugin details`/);
    assert.match(filed[0]!.body, /does not check `claude plugin details`/);
  });

  test('a second divergence names the one it supersedes', async () => {
    const { filed } = await play([oracleThatFlipped(PAIR_A), oracleThatFlipped(PAIR_A, PAIR_B)]);
    assert.equal(filed.length, 2);
    const first = divergenceKey(pairKeys([mismatchOf(PAIR_A)]));
    assert.ok(filed[1]!.body.includes(first), `the second issue names divergence ${first}`);
    assert.match(filed[1]!.body, /was not closed automatically/);
  });

  test('the title carries the divergence key, so two issues are visibly different', async () => {
    const { filed } = await play([oracleThatFlipped(PAIR_A), oracleThatFlipped(PAIR_A, PAIR_B)]);
    assert.notEqual(filed[0]!.title, filed[1]!.title);
    for (const draft of filed) assert.match(draft.title, /^Resolver diverges from .+ \([0-9a-f]{12}\)$/);
  });
});

describe('filing is something a run has to be handed, not something it can fall into', () => {
  test('with no filer the divergence is still reported and nothing is filed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-oracle-dry-'));
    try {
      const outcome = await runOracleCheck({
        ws: WS,
        read: oracleThatFlipped(PAIR_A),
        statePath: join(dir, 'oracle-run.json'),
        now: new Date('2026-01-01T00:00:00Z'),
      });
      assert.ok(outcome.report, 'a dry run still reports');
      assert.ok(outcome.draft, 'and still produces the issue it would have filed');
      assert.equal(outcome.filed, null);
      // Recorded as open with no identifier, so the next run dedupes against it rather
      // than filing the same divergence once the flag is finally passed... and the null
      // identifier is what says it was never actually filed.
      assert.equal(outcome.state.open?.issue, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a check that compared nothing is broken, not agreeing', () => {
  test('it reports, exits through the broken path, and files no issue', async () => {
    const { outcomes, filed, state } = await play([() => null]);
    const [run] = outcomes;
    assert.ok(run);
    assert.equal(run.broken, true);
    assert.equal(run.run.compared, 0);
    assert.ok(run.report, 'silence here would be a dead check reporting health');
    assert.match(run.report!, /none answered/);
    assert.equal(filed.length, 0, 'a broken check is our problem, not a Claude Code change');
    assert.equal(state?.broken, true);
  });
});

// ---------------------------------------------------------------------------
// The last-run record: the answer to "a silent job looks like a broken one"
// ---------------------------------------------------------------------------

describe('the run record is what distinguishes quiet from dead', () => {
  test('a silent, agreeing run still leaves a timestamp behind', async () => {
    const { outcomes, state } = await play([agreeing]);
    assert.equal(outcomes[0]?.report, null, 'and it is still silent');
    assert.ok(state, 'success writes state even though it prints nothing');
    assert.equal(state!.diverging, 0);
    assert.equal(state!.compared, MANIFEST.pairs);
    assert.equal(state!.open, null);
  });

  test('--status on a machine that never ran says so, and points at the installer', () => {
    const text = statusReport(null, new Date('2026-01-01T00:00:00Z'), '/nowhere/oracle-run.json');
    assert.match(text, /no run recorded/);
    assert.match(text, /install-oracle-schedule\.sh/);
  });

  test('--status calls a run older than the schedule stale', () => {
    const state: RunState = {
      version: 1,
      ranAt: '2026-01-01T00:00:00Z',
      projects: 25,
      compared: 1050,
      unreadable: 0,
      diverging: 0,
      broken: false,
      open: null,
    };
    const fresh = new Date('2026-01-04T00:00:00Z');
    const old = new Date(Date.parse(state.ranAt) + (STALE_AFTER_DAYS + 1) * 86_400_000);

    assert.equal(isStale(state, fresh), false);
    assert.equal(isStale(state, old), true);
    assert.doesNotMatch(statusReport(state, fresh, '/x'), /STALE/);
    assert.match(statusReport(state, old, '/x'), /STALE/);
    // The healthy line has to state what agreed, or "no news" is indistinguishable from
    // "nothing was checked".
    assert.match(statusReport(state, fresh, '/x'), /agreed/);
  });

  test('--status names an open divergence rather than reporting agreement', async () => {
    const { state } = await play([oracleThatFlipped(PAIR_A)]);
    const text = statusReport(state, new Date('2026-01-01T12:00:00Z'), '/x');
    assert.match(text, /divergence [0-9a-f]{12} open since/);
    assert.doesNotMatch(text, /agreed/);
  });
});

describe('the state file rejects what it cannot read', () => {
  test('absent, malformed, and future-versioned all read as no record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-oracle-state-'));
    try {
      const path = join(dir, 'oracle-run.json');
      assert.equal(readRunState(path), null, 'absent');
      assert.equal(existsSync(path), false, 'and reading it does not create it');

      writeFileSync(path, '{ not json');
      assert.equal(readRunState(path), null, 'malformed');

      // A record written by a later version is not one this can interpret, and reading
      // half of it would dedupe against a key that means something else.
      writeFileSync(path, JSON.stringify({ version: 2, ranAt: '2026-01-01T00:00:00Z' }));
      assert.equal(readRunState(path), null, 'future-versioned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The mutations the gate is measured by
// ---------------------------------------------------------------------------

/**
 * Three wrong dedupe rules, hand-written.
 *
 * Not derived from `decide`: a mutant that borrows the real predicate agrees with it
 * whatever it does, which is the defect CLAUDE.md names as reading a value back through
 * the function that wrote it. What they share with the real rule is only its signature.
 */
type Wrong = 'always-file' | 'never-file-twice' | 'reports-agreement';

function mutantDecide(wrong: Wrong): DecideFn {
  return (mismatches, open): Verdict => {
    const key = divergenceKey(pairKeys(mismatches));
    switch (wrong) {
      // No dedupe at all. Correct on the first run of every scenario, and files a fresh
      // issue every week for as long as a divergence stays open.
      case 'always-file':
        return mismatches.length === 0
          ? { action: 'agree' }
          : { action: 'file', key, supersedes: open };
      // Dedupe on "is anything open" rather than on which pairs diverge. Files once and
      // then goes quiet through every later, different disagreement -- the failure that
      // looks like a working dedupe until the second divergence, which is when it
      // matters.
      case 'never-file-twice':
        return mismatches.length === 0
          ? { action: 'agree' }
          : open
            ? { action: 'known', key: open.key, issue: open.issue, since: open.filedAt }
            : { action: 'file', key, supersedes: null };
      // Treats "compared, nothing wrong" as something to say. The all-clear line the
      // requirement forbids, arrived at from the decide side.
      case 'reports-agreement':
        return { action: 'file', key, supersedes: open };
    }
  };
}

interface Mutation {
  name: string;
  wrong: Wrong;
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'file on every run instead of once per divergence',
    wrong: 'always-file',
    names: /^the same divergence twice files once: filed 2 issue\(s\), expected 1$/,
  },
  {
    name: 'dedupe on "something is open" instead of on which pairs diverge',
    wrong: 'never-file-twice',
    names: /^a different divergence while the first is open files again: filed 1 issue\(s\), expected 2$/,
  },
  {
    name: 'report on agreement',
    wrong: 'reports-agreement',
    names: /^an unchanged oracle says nothing and files nothing: run 0 said /,
  },
];

describe('the gate fails when the dedupe rule is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, async () => {
      const failures: string[] = [];
      for (const s of SCENARIOS) {
        failures.push(...diff(s, await play(s.readers, { decide: mutantDecide(mutation.wrong) })));
      }

      assert.ok(
        failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate — that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      assert.ok(
        failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${failures.join('; ')}`,
      );
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  /** The positive control the three above are measured against. */
  test('and passes the real rule', async () => {
    const failures: string[] = [];
    for (const s of SCENARIOS) failures.push(...diff(s, await play(s.readers)));
    assert.deepEqual(failures, []);
  });
});

describe('the dedupe key is the set of diverging pairs and nothing else', () => {
  const record = (pairs: string[]): DivergenceRecord => ({
    key: divergenceKey(pairs),
    pairs,
    filedAt: '2026-01-01T00:00:00Z',
    issue: 'DEA-901',
  });

  test('order does not change it, membership does', () => {
    assert.equal(divergenceKey(['b', 'a']), divergenceKey(['a', 'b']));
    assert.notEqual(divergenceKey(['a', 'b']), divergenceKey(['a', 'b', 'c']));
    assert.notEqual(divergenceKey(['a', 'b']), divergenceKey(['a']));
  });

  test('a subset is a different divergence, deliberately', () => {
    // Stated as a test rather than left to a comment: when a divergence shrinks, the
    // open issue's table is wrong, and the choice made is to file rather than to leave
    // it wrong. Anyone changing that should have to change this line.
    const open = record(pairKeys([mismatchOf(['p', 'one']), mismatchOf(['p', 'two'])]));
    assert.equal(decide([mismatchOf(['p', 'one'])], open).action, 'file');
    // ...and the same set, in any order, is not.
    assert.equal(
      decide([mismatchOf(['p', 'two']), mismatchOf(['p', 'one'])], open).action,
      'known',
    );
  });
});
