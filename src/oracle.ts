/**
 * Re-asking the live `claude` binary whether the resolver is still right (DEA-118).
 *
 * The precedence rules in `resolve.ts` were reverse-engineered. Nothing publishes them,
 * so a Claude Code release that changes how `enabledPlugins` resolves does not break
 * this tool loudly -- it makes it confidently wrong, everywhere, at once.
 *
 * DEA-127 already replays a *recorded* oracle in CI, which catches our regressions. It
 * cannot catch theirs: a recording agrees with itself forever, and a green replay only
 * proves we still match the release the fixture was captured from. So this half asks
 * the binary again, on a schedule, on the machine that has both it and the real config.
 *
 * Two things are deliberately not here.
 *
 * The comparison is not reimplemented -- `comparePairs` below is the one the
 * differential suite runs, moved rather than copied. Two implementations of "does the
 * resolver agree with first-party" drift, and the copy that drifts is the one nobody
 * watches, which is the failure `test/differential.test.ts` already had once.
 *
 * And nothing here installs, loads, or writes a launchd agent. `launchd/` ships a plist
 * and `scripts/install-oracle-schedule.sh` installs it, because a tool whose promise is
 * "it does not write your live environment" cannot make an exception for its own
 * scheduling.
 *
 * The day it fails: this covers *one* of the four reverse-engineered behaviours -- see
 * `SCOPE_NOTE`. A release that changes `claude plugin details` output, the usage-counter
 * semantics, or MCP tool-name loading passes this check silently.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { claudeCli } from './disclose.ts';
import { resolvePlugin } from './resolve.ts';
import type { ProjectRecord, Workspace } from './surfaces/types.ts';

/**
 * What this check does and does not cover, in one place because it has to appear
 * verbatim in three: the terminal report, the `--status` line, and the filed issue.
 *
 * Stated as a narrowing rather than left implicit. "The oracle agrees" is very easy to
 * read as "drift is handled", and three of the four behaviours it might mean are not
 * measured here at all.
 */
export const SCOPE_NOTE =
  'Scope: this compares one reverse-engineered behaviour — the per-directory `enabled` ' +
  'resolution of plugins. It does not check `claude plugin details` output, the usage-' +
  'counter semantics, or MCP tool-name loading. Those can change without this noticing.';

// ---------------------------------------------------------------------------
// The comparison, shared with test/differential.test.ts
// ---------------------------------------------------------------------------

export interface FirstPartyPlugin {
  id: string;
  enabled: boolean;
}

/** One project, plus the first-party opinion of every plugin visible from it. */
export interface OracleCase {
  project: ProjectRecord;
  expected: FirstPartyPlugin[];
}

/**
 * One pair the two disagree about.
 *
 * Structured rather than pre-rendered. The differential suite wants a block of text in
 * an assertion message and a filed issue wants a markdown row; formatting at the point
 * of divergence would have forced one of the two to re-parse the other's prose.
 */
export interface Mismatch {
  project: string;
  plugin: string;
  firstParty: boolean;
  resolver: boolean;
  origin: string;
  /** The precedence chain that produced `resolver`, e.g. `user=true, local=false`. */
  chain: string;
}

export interface Comparison {
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
  mismatches: Mismatch[];
}

/**
 * The comparison itself.
 *
 * Live, replay, and the scheduled check differ only in where the cases come from. A
 * second copy of this loop would be a second thing to keep in step, and the copy that
 * drifted would be the one nobody runs.
 */
export function comparePairs(ws: Workspace, cases: readonly OracleCase[]): Comparison {
  const mismatches: Mismatch[] = [];
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
        mismatches.push({
          project: project.path,
          plugin: plugin.id,
          firstParty: plugin.enabled,
          resolver: ours.value,
          origin: ours.origin,
          chain: ours.chain.map((l) => `${l.scope}=${l.value}`).join(', '),
        });
      }
    }
  }

  return { compared, decided, mismatches };
}

/** The indented block the differential suite prints in its assertion message. */
export function describeMismatch(m: Mismatch): string {
  return (
    `${m.project}\n    ${m.plugin}\n` +
    `      first-party: ${m.firstParty}\n` +
    `      resolver:    ${m.resolver} (${m.origin}, chain=[${m.chain}])`
  );
}

/**
 * The projects a first-party opinion can be asked for.
 *
 * Shared with the live half of the differential suite so the scheduled job and the test
 * compare the same population -- a job checking a wider or narrower set than CI is a job
 * whose green and CI's green mean different things.
 *
 * Worktrees are skipped: they inherit their parent's settings by a different path.
 *
 * `alive` and not a second `existsSync(p.path)`. On a live workspace the two are the
 * same test, since `alive` is `existsSync` on that same path. On one loaded through a
 * `projectPathResolver` -- the differential fixture -- they are not: `path` is the
 * recorded, synthetic one and only `alive` reflects the directory that actually backs
 * it, so the extra check silently emptied the list.
 */
export function askableProjects(ws: Workspace): ProjectRecord[] {
  return ws.projects.filter((p) => p.alive && !p.path.includes('/worktrees/'));
}

/** How the oracle is asked. Injectable so a test can drive a divergence without one. */
export type OracleReader = (cwd: string) => FirstPartyPlugin[] | null;

/**
 * The real oracle: `claude plugin list --json`, run in the project directory.
 *
 * Through `claudeCli` and not `execFileSync`, because this spawns `claude` once per
 * registered project and on a machine without `~/.claude.json` the first of those
 * creates it (DEA-140). One door, so the run can name the command that did.
 *
 * A failed lookup is `null` rather than a throw: one unreachable project must not end a
 * sweep over twenty reachable ones. The count of them is reported, because a sweep where
 * every project failed is a broken check and not an agreeing one.
 */
export const liveOracle: OracleReader = (cwd) => {
  try {
    const out = claudeCli.run(['plugin', 'list', '--json'], { cwd, timeoutMs: 60_000 });
    return JSON.parse(out) as FirstPartyPlugin[];
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// One sweep of the workspace
// ---------------------------------------------------------------------------

export interface OracleRun {
  projects: number;
  compared: number;
  /** Projects that were asked and did not answer. */
  unreadable: string[];
  decided: { project: number; local: number };
  mismatches: Mismatch[];
}

export function checkWorkspace(ws: Workspace, read: OracleReader): OracleRun {
  const askable = askableProjects(ws);
  const cases: OracleCase[] = [];
  const unreadable: string[] = [];

  for (const project of askable) {
    const expected = read(project.path);
    if (!expected) {
      unreadable.push(project.path);
      continue;
    }
    cases.push({ project, expected });
  }

  const { compared, decided, mismatches } = comparePairs(ws, cases);
  return { projects: cases.length, compared, unreadable, decided, mismatches };
}

/**
 * Projects were there to ask and none of them answered.
 *
 * Distinguished from agreement on purpose. Both produce zero mismatches, and treating
 * them alike is how a check that stopped working reports success every week -- the exact
 * defect DEA-127 found in the suite this is the other half of.
 */
export function isBroken(run: OracleRun): boolean {
  return run.compared === 0 && run.unreadable.length > 0;
}

// ---------------------------------------------------------------------------
// Identity and dedupe
// ---------------------------------------------------------------------------

/** `project\tplugin` for every diverging pair, sorted. The dedupe key's input. */
export function pairKeys(mismatches: readonly Mismatch[]): string[] {
  return [...new Set(mismatches.map((m) => `${m.project}\t${m.plugin}`))].sort();
}

/**
 * The identity of a divergence: a digest of exactly which pairs disagree.
 *
 * Chosen over the two obvious alternatives. Keying on "the oracle diverged" at all would
 * file once and then stay silent through every later, different disagreement -- the
 * first issue's body would describe a state that no longer exists and nothing would say
 * so. Keying on the run (a timestamp, a release version) dedupes nothing and files
 * weekly for as long as the divergence is open.
 *
 * So: same pairs, same divergence, one issue. A *different* set of pairs -- one pair
 * more, one fewer, or an unrelated one -- is a different key and files a second issue,
 * which names the first as superseded. That is a deliberate trade: it can file twice for
 * what a human would call one problem that grew, and the alternative is a filed issue
 * whose contents are quietly wrong. An issue that overstates is recoverable; one that
 * silently understates is the failure this whole mechanism exists to prevent.
 *
 * The day it fails: a divergence that flaps between two pair sets alternates keys and
 * files on every run. Nothing here rate-limits, because a rate limit is indistinguishable
 * from the silence it is meant to prevent.
 */
export function divergenceKey(pairs: readonly string[]): string {
  return createHash('sha256').update([...pairs].sort().join('\n')).digest('hex').slice(0, 12);
}

/** A divergence that has been filed and, as far as this machine knows, is still open. */
export interface DivergenceRecord {
  key: string;
  /** The pairs the filed issue describes. Kept so the key is never the only copy. */
  pairs: string[];
  filedAt: string;
  /** Linear's identifier, or null when the run that found it was a dry run. */
  issue: string | null;
}

export type Verdict =
  | { action: 'agree' }
  | { action: 'known'; key: string; issue: string | null; since: string }
  | { action: 'file'; key: string; supersedes: DivergenceRecord | null };

export type DecideFn = (mismatches: readonly Mismatch[], open: DivergenceRecord | null) => Verdict;

export const decide: DecideFn = (mismatches, open) => {
  if (mismatches.length === 0) return { action: 'agree' };
  const key = divergenceKey(pairKeys(mismatches));
  if (open && open.key === key) {
    return { action: 'known', key, issue: open.issue, since: open.filedAt };
  }
  return { action: 'file', key, supersedes: open };
};

// ---------------------------------------------------------------------------
// The last-run record
// ---------------------------------------------------------------------------

/**
 * What the run leaves behind, and the answer to "a silent job looks exactly like a
 * broken one".
 *
 * Silence on success is the requirement, so success cannot be signalled by anything the
 * user has to look at. It is signalled by something they can *ask*: this file is
 * overwritten in place on every run, prints nothing on its own, and `qm oracle --status`
 * reads it. A run that never happened leaves the previous timestamp behind, and a
 * timestamp older than the schedule is the failure showing.
 *
 * Rejected: emitting an all-clear line, a heartbeat issue, or a per-run log file. Each
 * makes the healthy case produce output, and output nobody needs is output nobody reads
 * -- which is how the divergence line, when it finally comes, gets skimmed past.
 *
 * The day it fails: this records that `qm oracle` reached the end. A launchd agent that
 * was never loaded, or one whose plist points at a node that has moved, writes nothing
 * at all and looks identical to a machine where `qm oracle` was never installed. Only
 * `--status` saying "never run" distinguishes those from a healthy one, and neither from
 * each other.
 */
export interface RunState {
  version: 1;
  ranAt: string;
  projects: number;
  compared: number;
  unreadable: number;
  diverging: number;
  /** True when projects existed and none answered -- checked nothing, agreed to nothing. */
  broken: boolean;
  open: DivergenceRecord | null;
}

export function readRunState(path: string): RunState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as RunState;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRunState(path: string, state: RunState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * How long after a run the record stops being evidence of health.
 *
 * The schedule is weekly, so seven days is the expected gap and anything at eight is a
 * run that did not happen. A tighter bound would call a Mac that was asleep on Sunday
 * broken; a looser one takes a fortnight to notice launchd never loaded the agent.
 */
export const STALE_AFTER_DAYS = 8;

export function isStale(state: RunState, now: Date): boolean {
  const age = now.getTime() - Date.parse(state.ranAt);
  return !Number.isFinite(age) || age > STALE_AFTER_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface IssueDraft {
  title: string;
  body: string;
}

/** A filed issue, as the tracker identifies it back to us. */
export interface FiledIssue {
  identifier: string;
  url: string;
}

export type IssueFiler = (draft: IssueDraft) => Promise<FiledIssue>;

export function divergenceReport(run: OracleRun, verdict: Verdict): string {
  const lines = [
    `oracle divergence — the resolver and \`claude plugin list --json\` disagree on ` +
      `${run.mismatches.length} of ${run.compared} pairs across ${run.projects} projects.`,
    '',
  ];
  for (const m of run.mismatches) lines.push(`  ${describeMismatch(m)}`, '');
  if (verdict.action === 'file' && verdict.supersedes) {
    lines.push(
      `  This is a different set of pairs from divergence ${verdict.supersedes.key}` +
        `${verdict.supersedes.issue ? ` (${verdict.supersedes.issue})` : ''}, ` +
        `which named ${verdict.supersedes.pairs.length}.`,
      '',
    );
  }
  if (run.unreadable.length) {
    lines.push(`  ${run.unreadable.length} project(s) could not be asked.`, '');
  }
  lines.push(`  ${SCOPE_NOTE}`);
  return lines.join('\n');
}

export function issueDraft(run: OracleRun, key: string, supersedes: DivergenceRecord | null): IssueDraft {
  const rows = run.mismatches.map(
    (m) => `| \`${m.project}\` | \`${m.plugin}\` | ${m.firstParty} | ${m.resolver} | ${m.origin} | \`${m.chain}\` |`,
  );
  const body = [
    '`claude plugin list --json` and quartermaster\'s `resolvePlugin` no longer agree.',
    '',
    `Compared **${run.compared}** (plugin, project) pairs across **${run.projects}** projects; ` +
      `**${run.mismatches.length}** diverge.`,
    '',
    '| project | plugin | first-party | resolver | origin | chain |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    supersedes
      ? `Supersedes divergence \`${supersedes.key}\`${supersedes.issue ? ` (${supersedes.issue})` : ''}, ` +
        `which named ${supersedes.pairs.length} pair(s). That issue was not closed automatically.`
      : '',
    run.unreadable.length
      ? `${run.unreadable.length} project(s) could not be asked and are not counted above.`
      : '',
    '',
    SCOPE_NOTE,
    '',
    '_Filed by `qm oracle --file-issue`, the scheduled live-oracle check (DEA-118)._',
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n');

  return { title: `Resolver diverges from \`claude plugin list --json\` (${key})`, body };
}

// ---------------------------------------------------------------------------
// The check, end to end
// ---------------------------------------------------------------------------

export interface CheckDeps {
  ws: Workspace;
  read: OracleReader;
  statePath: string;
  now: Date;
  /**
   * Absent means dry run, which is the default everywhere including here. Filing is an
   * outward-facing side effect, so it is reachable only by passing a filer in, and the
   * only code that constructs a real one is behind `qm oracle --file-issue`.
   */
  file?: IssueFiler;
  /**
   * The dedupe rule, injectable for the same reason `ClaudeExec` is in `disclose.ts`: a
   * gate is only worth its green if a wrong implementation turns it red, and a mutant
   * that borrows the real predicate agrees with it whatever it does. Production never
   * passes this.
   */
  decide?: DecideFn;
}

export interface CheckOutcome {
  run: OracleRun;
  verdict: Verdict;
  /** Everything this run has to say. Null is the answer when the two agree. */
  report: string | null;
  /** True when the report is about this check failing, not about the config. */
  broken: boolean;
  draft: IssueDraft | null;
  filed: FiledIssue | null;
  state: RunState;
}

export async function runOracleCheck(deps: CheckDeps): Promise<CheckOutcome> {
  const run = checkWorkspace(deps.ws, deps.read);
  const previous = readRunState(deps.statePath);
  const verdict = (deps.decide ?? decide)(run.mismatches, previous?.open ?? null);
  const ranAt = deps.now.toISOString();

  let draft: IssueDraft | null = null;
  let filed: FiledIssue | null = null;
  let open: DivergenceRecord | null = null;

  if (verdict.action === 'known') {
    // Already filed, and nothing about it has changed. The record is carried forward
    // verbatim: rewriting `filedAt` here would make a persistent divergence look new
    // every week, which is the noise the dedupe exists to remove.
    open = previous?.open ?? null;
  } else if (verdict.action === 'file') {
    draft = issueDraft(run, verdict.key, verdict.supersedes);
    if (deps.file) filed = await deps.file(draft);
    open = {
      key: verdict.key,
      pairs: pairKeys(run.mismatches),
      filedAt: ranAt,
      issue: filed?.identifier ?? null,
    };
  }
  // `agree` leaves `open` null, so a divergence that goes away is forgotten and files
  // afresh if it returns. A recurrence after a fix is news.

  const broken = isBroken(run);
  const state: RunState = {
    version: 1,
    ranAt,
    projects: run.projects,
    compared: run.compared,
    unreadable: run.unreadable.length,
    diverging: run.mismatches.length,
    broken,
    open,
  };
  writeRunState(deps.statePath, state);

  // Null on agreement and only on agreement. "Silent when they agree" is the whole
  // contract; a divergence that was already filed is still a divergence, and saying so
  // in one line is not noise on success -- there is no success to be noisy about.
  let report: string | null = null;
  if (broken) {
    report =
      `oracle check failed — ${run.unreadable.length} project(s) were asked and none ` +
      'answered, so nothing was compared. This is the check being broken, not the ' +
      'configuration being wrong; no issue was filed.\n' +
      run.unreadable.slice(0, 5).map((p) => `  ${p}`).join('\n');
  } else if (verdict.action === 'file') {
    report = divergenceReport(run, verdict);
  } else if (verdict.action === 'known') {
    report =
      `oracle divergence ${verdict.key} is still open since ${verdict.since}` +
      `${verdict.issue ? ` (${verdict.issue})` : ' (not filed — that run was a dry run)'}; ` +
      `${run.mismatches.length} of ${run.compared} pairs. Already reported, so nothing was filed.`;
  }

  return { run, verdict, report, broken, draft, filed, state };
}

/** `--status`: the only thing that distinguishes a quiet check from a dead one. */
export function statusReport(state: RunState | null, now: Date, statePath: string): string {
  if (!state) {
    return (
      'oracle check — no run recorded.\n' +
      `  Nothing has written ${statePath}, so the check has either never run here or\n` +
      '  never reached the end of a run. Run `qm oracle` once by hand, then install the\n' +
      '  weekly schedule with scripts/install-oracle-schedule.sh.\n' +
      `  ${SCOPE_NOTE}`
    );
  }

  const ageDays = (now.getTime() - Date.parse(state.ranAt)) / 86_400_000;
  const lines = [
    `oracle check — last ran ${state.ranAt} (${ageDays.toFixed(1)} days ago)`,
    `  compared ${state.compared} pairs across ${state.projects} projects` +
      (state.unreadable ? `, ${state.unreadable} project(s) unreadable` : ''),
  ];

  if (state.broken) {
    lines.push('  that run compared nothing — every project it asked failed to answer');
  } else if (state.open) {
    lines.push(
      `  divergence ${state.open.key} open since ${state.open.filedAt}` +
        `${state.open.issue ? ` — ${state.open.issue}` : ' — not filed (dry run)'}`,
      `  ${state.open.pairs.length} diverging pair(s)`,
    );
  } else {
    lines.push('  the resolver and `claude plugin list --json` agreed');
  }

  if (isStale(state, now)) {
    lines.push(
      `  STALE — the schedule is weekly and this is over ${STALE_AFTER_DAYS} days old.`,
      '  Check the agent is loaded: launchctl list | grep quartermaster',
    );
  }

  lines.push(`  ${SCOPE_NOTE}`);
  return lines.join('\n');
}
