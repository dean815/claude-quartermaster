/**
 * The resolver's correctness gate.
 *
 * Hand-written expectations only prove the resolver agrees with whoever wrote them.
 * `claude plugin list --json` reports `enabled` already resolved for its working
 * directory, which makes it an external oracle: run it in each project, and every
 * (plugin, project) pair either matches our resolution or the resolver is wrong.
 *
 * The oracle is only reachable on a machine that has the CLI *and* registered
 * projects, which CI has neither of -- so for its first months this file skipped in
 * its entirety and the green tick said nothing at all about the resolver. It now runs
 * two ways over one comparison:
 *
 *   live    -- against this machine, when `claude` is installed. Keeps catching what a
 *              recording cannot: a CLI change, a surface nobody modelled yet.
 *   replay  -- against a recorded fixture HOME tree, everywhere, always.
 *
 * Replay never skips. A missing, empty, or degenerate fixture fails, because a gate
 * that quietly declines to run is precisely the defect this arrangement removes.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { loadWorkspace } from '../src/surfaces/read.ts';
import { resolvePlugin } from '../src/resolve.ts';
import type { Workspace, ProjectRecord } from '../src/surfaces/types.ts';
import {
  FIXTURE_HOME,
  FIXTURE_ROOT,
  loadFixtureWorkspace,
  readOracle,
  readManifest,
} from './fixtures/differential/load.ts';

interface FirstPartyPlugin {
  id: string;
  enabled: boolean;
}

/** One project, plus the first-party opinion of every plugin visible from it. */
interface Case {
  project: ProjectRecord;
  expected: FirstPartyPlugin[];
}

/**
 * The comparison itself, shared by both modes.
 *
 * Live and replay differ only in where the cases come from. A second copy of this loop
 * would be a second thing to keep in step, and the copy that drifted would be the one
 * nobody runs -- which is the failure this file already had once.
 */
interface Outcome {
  compared: number;
  /**
   * Pairs each scope actually *won*, counted per scope.
   *
   * Two subtleties, both learned by mutation rather than reasoning.
   *
   * It has to be per scope rather than one total: a pair decided at user scope agrees
   * with the oracle even if every line of precedence handling is deleted, so "some
   * project-ish scope spoke" reads as healthy while one of the two scopes goes entirely
   * untested. That is exactly what happened -- 19 pairs at `project`, none at `local`,
   * and demoting `local` below `user` produced no mismatch at all.
   *
   * And it counts the *winner*, not every scope that had an opinion. A pair where
   * `project` is overruled by `local` protects `project` from nothing: break `project`
   * and that pair still resolves correctly. Demoting `local` produces exactly as many
   * mismatches as there are pairs `local` won -- 2, matching `manifest.decidedByScope`.
   * Counting participation instead would report 20 project-scope pairs where only 19
   * can fail, i.e. it would overstate the fixture's power by precisely the pairs that
   * cannot detect anything.
   */
  decided: { project: number; local: number };
  mismatches: string[];
}

function comparePairs(ws: Workspace, cases: Case[]): Outcome {
  const mismatches: string[] = [];
  const decided = { project: 0, local: 0 };
  let compared = 0;

  for (const { project, expected } of cases) {
    for (const plugin of expected) {
      const ours = resolvePlugin(ws, project, plugin.id);
      compared++;
      const winner = ours.chain.at(-1)?.scope;
      if (winner === 'project') decided.project++;
      if (winner === 'local') decided.local++;
      if (ours.value !== plugin.enabled) {
        mismatches.push(
          `${project.path}\n    ${plugin.id}\n` +
            `      first-party: ${plugin.enabled}\n` +
            `      resolver:    ${ours.value} (${ours.origin}, chain=[${ours.chain
              .map((l) => `${l.scope}=${l.value}`)
              .join(', ')}])`,
        );
      }
    }
  }

  return { compared, decided, mismatches };
}

const scopeTally = (d: Outcome['decided']) =>
  `decided at project scope: ${d.project}, local scope: ${d.local}`;

const failureMessage = (mismatches: string[]) =>
  `\n  ${mismatches.length} mismatch(es):\n  ${mismatches.join('\n  ')}`;

// --- live -------------------------------------------------------------------

function claudeAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function firstPartyView(cwd: string): FirstPartyPlugin[] | null {
  try {
    const out = execFileSync('claude', ['plugin', 'list', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out) as FirstPartyPlugin[];
  } catch {
    return null;
  }
}

const available = claudeAvailable();

describe('resolver matches live `claude plugin list --json`', { skip: !available && 'claude CLI unavailable' }, () => {
  let ws: Workspace;
  let live: ProjectRecord[];

  before(() => {
    ws = loadWorkspace();
    // Only directories that still exist can be asked for a first-party opinion.
    // Worktrees are skipped: they inherit their parent's settings by a different path.
    live = ws.projects.filter(
      (p) => p.alive && existsSync(p.path) && !p.path.includes('/worktrees/'),
    );
  });

  test('every (plugin, project) pair agrees', (t) => {
    // A machine with no registered projects has nothing to compare. That is a skip,
    // not a pass and not a failure -- asserting projects exist made this suite fail on
    // any fresh clone, which is worse than not running it. The replay half below is
    // what guarantees the resolver is still checked when this path skips.
    if (live.length === 0) return t.skip('no registered projects on this machine');

    const cases: Case[] = [];
    let unreadable = 0;
    for (const project of live) {
      const expected = firstPartyView(project.path);
      if (!expected) {
        unreadable++;
        continue;
      }
      cases.push({ project, expected });
    }

    const { compared, decided, mismatches } = comparePairs(ws, cases);

    console.log(
      `    live: compared ${compared} pairs across ${cases.length} projects, ` +
        scopeTally(decided) +
        (unreadable ? ` (${unreadable} unreadable)` : ''),
    );
    // Projects existed but nothing could be compared -- the oracle is broken, and a
    // silent pass here would retire the only external check on the resolver.
    assert.ok(compared > 0, `${live.length} projects found but no pairs compared`);
    assert.deepEqual(mismatches, [], failureMessage(mismatches));
  });
});

// --- replay -----------------------------------------------------------------

/**
 * The counts the generator recorded when it wrote the fixture.
 *
 * Exact, not a floor. A floor set low enough to be safe against a legitimately smaller
 * capture is also low enough for a thousand pairs to collapse to five without anyone
 * noticing, which is the same class of silent-erosion bug as the suite that never ran.
 * The oracle cannot supply the number either: an expectation derived from the file
 * under inspection moves with every shrink and therefore asserts nothing.
 *
 * So it comes from `manifest.json`, which the generator writes and git tracks. A
 * regeneration that loses coverage changes a committed file rather than quietly
 * agreeing with itself, and the constant cannot drift out of step with the fixture
 * because there is no constant.
 */
const MANIFEST = readManifest();

function loadReplay(): { ws: Workspace; cases: Case[] } {
  let oracle: Record<string, FirstPartyPlugin[]>;
  try {
    oracle = readOracle();
  } catch (err) {
    // Loud, and specific about what is absent. A skip here would restore precisely the
    // defect this half exists to remove.
    throw new Error(
      `differential replay fixture unreadable: ${err instanceof Error ? err.message : String(err)}\n` +
        `  expected a recorded HOME tree under ${FIXTURE_ROOT} and an oracle beside it,\n` +
        '  shaped { "<project path>": [{ "id": string, "enabled": boolean }] }.\n' +
        '  Rebuild it with: node --experimental-strip-types scripts/make-differential-fixture.ts',
    );
  }

  const entries = Object.entries(oracle);
  if (entries.length === 0) throw new Error(`${FIXTURE_ROOT}/oracle.json records no projects`);

  // The fixture owns the rule for pointing `loadWorkspace` at itself -- the recorded
  // paths are synthetic and have to be rebased onto its own tree. Keeping a second copy
  // of that rule here is how the two drift the first time either is edited.
  const ws = loadFixtureWorkspace();

  const cases: Case[] = [];
  for (const [path, expected] of entries) {
    const project = ws.projects.find((p) => p.path === path);
    if (!project) {
      throw new Error(
        `oracle names a project the fixture HOME does not register: ${path}\n` +
          `  ${FIXTURE_HOME}/.claude.json registers: ${ws.projects.map((p) => p.path).join(', ') || '(none)'}`,
      );
    }
    // A registered path with no directory behind it reads as a dead project: its
    // settings files come back null and every pair would silently compare against the
    // user scope alone, which is a resolver check that checks almost nothing.
    if (!project.alive) {
      throw new Error(
        `oracle names ${path}, which the fixture registers but no directory backs.\n` +
          '  Its project- and local-scope settings read as absent, so the precedence\n' +
          '  chain under test would collapse to the user scope.',
      );
    }
    cases.push({ project, expected });
  }

  return { ws, cases };
}

describe('resolver matches recorded `claude plugin list --json`', () => {
  test('every (plugin, project) pair agrees', () => {
    const { ws, cases } = loadReplay();
    const { compared, decided, mismatches } = comparePairs(ws, cases);

    // Printed so a fixture quietly shrinking shows up in the CI log next to the run
    // that still says PASS.
    console.log(
      `    replay: compared ${compared} pairs across ${cases.length} projects, ` +
        scopeTally(decided),
    );

    assert.equal(
      compared,
      MANIFEST.pairs,
      `replay compared ${compared} pairs, but manifest.json records ${MANIFEST.pairs}.\n` +
        '  These disagreeing means the fixture and its manifest were not written by the\n' +
        '  same run -- regenerate with scripts/make-differential-fixture.ts so both move\n' +
        '  together, and check the resulting diff is the capture you meant.',
    );

    // The manifest counts winning scope, so these must agree exactly. If they drift, the
    // gate and the generator disagree about what the fixture covers, and the per-scope
    // assertions below are being evaluated against a tally nobody has validated.
    assert.deepEqual(
      { project: decided.project, local: decided.local },
      { project: MANIFEST.decidedByScope.project, local: MANIFEST.decidedByScope.local },
      'per-scope tally disagrees with manifest.json -- the gate and the generator are ' +
        'counting different things, so neither number can be trusted',
    );

    // Plugins default to off, so a recording in which nothing is enabled would still
    // pass with the resolution logic deleted outright. Both outcomes must appear for
    // the comparison to mean anything.
    const outcomes = new Set(cases.flatMap((c) => c.expected.map((p) => p.enabled)));
    assert.ok(
      outcomes.has(true) && outcomes.has(false),
      `fixture records only enabled=${[...outcomes].join('/')} -- it cannot distinguish ` +
        'a working resolver from one that always returns the default',
    );

    // Both project-level scopes have to decide something, asserted separately.
    //
    // A combined "some project-scope file spoke" check passes on `project` alone, which
    // is what the fixture happened to have: demoting `project` below `user` produced 16
    // mismatches, demoting `local` produced none, and a single tally could not tell the
    // two situations apart. Whichever scope is missing is a scope the gate is blind to.
    assert.ok(
      decided.project > 0,
      'no compared pair was decided by a project-scope settings.json -- the fixture ' +
        'cannot tell a working precedence chain from one that ignores project settings',
    );
    assert.ok(
      decided.local > 0,
      'no compared pair was decided by a settings.local.json -- local scope is the ' +
        'highest-precedence file surface and the one this project writes to, and the ' +
        'fixture currently cannot detect a resolver that ignores it entirely',
    );

    assert.deepEqual(mismatches, [], failureMessage(mismatches));
  });
});
