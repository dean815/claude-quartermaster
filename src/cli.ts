#!/usr/bin/env node
/**
 * `qm` -- read-only everywhere except `qm set` and `qm undo`.
 *
 * Every reporting command reads and reports; the first-party subcommands they invoke do
 * initialise `~/.claude.json` on a machine that has none, and the run discloses it (see
 * `disclose.ts`). `qm set` is the one command that changes a user's configuration, and it
 * changes exactly one file -- `<project>/.claude/settings.local.json` -- after showing the
 * whole diff and asking. `qm undo` puts the last one back. Neither ever touches
 * `~/.claude.json` or a tracked `settings.json`; `apply.ts` names both and refuses.
 */
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, dirname } from 'node:path';

import { loadWorkspace, problems } from './surfaces/read.ts';
import { claudeCli } from './disclose.ts';
import { measureProject } from './cost/transcript.ts';
import { profileFrom } from './cost/summary.ts';
import {
  parsePluginDetails,
  pluginLookupName,
  type PluginCost,
  type PluginCostIndex,
} from './cost/plugins.ts';
import { PluginCostCache, buildIdsByPath } from './cache.ts';
import { readInventories } from './inventory.ts';
import {
  runAll,
  rank,
  settingsValidityTally,
  unclassifiedSettings,
  type AuditContext,
  type Finding,
} from './detect.ts';
import { collect, groupByDetector, type DelegationReport } from './delegate/types.ts';
import {
  projectOptimizerAdapter,
  projectOptimizerJudgementAdapter,
} from './delegate/projectOptimizer.ts';
import { doctorAdapter, doctorSettingsValidity } from './delegate/doctor.ts';
import {
  checkProject,
  checkAll,
  makeBaseline,
  compareToBaseline,
  readBaseline,
} from './standard.ts';
import { startServer, DEFAULT_PORT } from './view/server.ts';
import {
  buildDeferralIndex,
  candidateChanges,
  classifyAll,
  tally,
  type EffectReport,
} from './effect.ts';
import {
  liveOracle,
  readRunState,
  runOracleCheck,
  statusReport,
  type IssueFiler,
} from './oracle.ts';
import { linearConfigFromEnv, linearFiler } from './linear.ts';
import { buildSkillCatalog, allSkillIds } from './skills.ts';
import { buildMcpCatalog, allMcpServerNames } from './mcp.ts';
import { allPluginIds } from './resolve.ts';
import {
  AXES,
  describePlan,
  planEffect,
  planToggles,
  showValue,
  type Axis,
  type ToggleRequest,
} from './toggle.ts';
import { applyPlan, stateDir, undoLast } from './apply.ts';
import type { TranscriptMeasurement } from './cost/transcript.ts';
import type { SettingsCheck, SettingsFile, SettingsValidity } from './surfaces/types.ts';

const BOLD = '[1m';
const DIM = '[2m';
const RESET = '[0m';
const COLOR: Record<string, string> = {
  high: '[31m',
  medium: '[33m',
  low: '[36m',
  info: '[2m',
};

const useColor = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (s: string, c: string) => (useColor ? `${c}${s}${RESET}` : s);

function num(n: number): string {
  return n.toLocaleString('en-US');
}

interface Options {
  json: boolean;
  withPluginCost: boolean;
  full: boolean;
  github: boolean;
  drift: boolean;
  /** `qm oracle --status`: read the last run's record instead of making a new one. */
  status: boolean;
  /** `qm oracle --file-issue`: the one flag in this tool with an outward side effect. */
  fileIssue: boolean;
  /** `qm set --yes`: apply without the prompt. The diff still prints. */
  yes: boolean;
  /** `qm set --axis <name>`: which settings key the write lands in. */
  axis: Axis;
  project: string | null;
  port: number;
}

/**
 * `--axis`, defaulting to `plugin`.
 *
 * A named axis rather than a `--skill` flag, because the set is a registry and grows: two
 * mutually exclusive booleans would have to be checked against each other, and the third
 * (QM-46) would make three. An unknown name exits rather than falling back, for the
 * reason `--port` does -- a typo that silently writes the wrong settings key is exactly
 * the "reported success, changed nothing" failure this phase is built around.
 */
function parseAxis(raw: string | null): Axis {
  if (raw === null) return AXES.get('plugin')!;
  const axis = AXES.get(raw);
  if (!axis) {
    console.error(
      `qm: --axis expects one of ${[...AXES.keys()].join(', ')}, got ${JSON.stringify(raw)}`,
    );
    process.exit(2);
  }
  return axis;
}

/** A port the OS will accept. Anything else is a typo worth stopping for. */
function parsePort(raw: string | null): number {
  if (raw === null) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    console.error(`qm: --port expects a number between 1 and 65535, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): { command: string; args: string[]; opts: Options } {
  // Guard the -1 case: `idx + 1` would be 0 and drop the command itself, so every
  // invocation without a value flag silently fell back to `audit`.
  const valueIdxOf = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? -1 : idx + 1;
  };
  const projectIdx = valueIdxOf('--project');
  const portIdx = valueIdxOf('--port');
  const axisIdx = valueIdxOf('--axis');
  const positional = argv.filter(
    (a, i) => !a.startsWith('-') && i !== projectIdx && i !== portIdx && i !== axisIdx,
  );
  return {
    command: positional[0] ?? 'audit',
    // Everything after the command. `qm set` reads its targets from here; nothing else
    // uses them, and a command that ignores them is not made to care.
    args: positional.slice(1),
    opts: {
      json: argv.includes('--json'),
      withPluginCost: !argv.includes('--no-plugin-cost'),
      full: argv.includes('--full'),
      github: !argv.includes('--no-github'),
      drift: argv.includes('--drift'),
      status: argv.includes('--status'),
      fileIssue: argv.includes('--file-issue'),
      yes: argv.includes('--yes'),
      axis: parseAxis(axisIdx === -1 ? null : (argv[axisIdx] ?? null)),
      project: projectIdx === -1 ? null : (argv[projectIdx] ?? null),
      port: parsePort(portIdx === -1 ? null : (argv[portIdx] ?? null)),
    },
  };
}

/**
 * Map each installed build's `installPath` to its cache-key build identifier.
 * `plugin list --json` omits it, but `installed_plugins.json` carries it, and installPath
 * is the unambiguous join key -- a build is one directory. See `buildIdsByPath` for how
 * the identifier is chosen. A missing/malformed file yields no identifiers, degrading to
 * version-only keys rather than failing the run.
 */
function readInstalledShas(): Map<string, string> {
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'),
    );
    return buildIdsByPath(raw);
  } catch {
    // No file, or malformed -- fall back to version-only keys.
    return new Map<string, string>();
  }
}

interface InstalledPlugin {
  id: string;
  version: string | null;
  installPath?: string;
}

/**
 * Per-plugin cost, fetched the first time something reads it.
 *
 * Every miss is a ~0.6s `claude plugin details` spawn and 42 are installed, so pricing
 * the workspace up front made every command wait ~19s whenever the on-disk cache was
 * cold -- which recurs on each `CACHE_VERSION` bump, not just on a new machine. Two
 * commands never read a price at all, and a run scoped to one project needs only the
 * plugins resolving active there.
 *
 * Laziness rather than a per-command flag: the policy then lives at the call site that
 * reads the number, so a new consumer gets the right behaviour without anyone
 * remembering to extend a switch in `buildContext`.
 */
class LazyPluginCosts implements PluginCostIndex {
  private readonly resolved = new Map<string, PluginCost | null>();
  private readonly cache = new PluginCostCache();
  private readonly quiet: boolean;
  /** Null until the first read; the `plugin list` spawn is deferred with the rest. */
  private installed: Map<string, InstalledPlugin> | null = null;
  /** So a missing CLI costs one failed spawn, not one per plugin asked about. */
  private listAttempted = false;
  private shas: Map<string, string> = new Map();
  private fetched = 0;

  constructor(quiet: boolean) {
    this.quiet = quiet;
  }

  get(id: string): PluginCost | null | undefined {
    if (this.resolved.has(id)) return this.resolved.get(id);

    const installed = this.list();
    // No CLI, no component cost. Recording nothing keeps "could not be priced" meaning
    // "this build was asked about and did not answer", rather than "no CLI here".
    if (!installed) return undefined;

    const entry = installed.get(id);
    const version = entry?.version ?? null;
    const sha = this.shas.get(entry?.installPath ?? '') ?? null;

    const hit = this.cache.get(id, version, sha);
    if (hit) {
      this.resolved.set(id, hit);
      return hit;
    }

    let parsed: PluginCost | null = null;
    try {
      const text = claudeCli.run(
        ['plugin', 'details', pluginLookupName(id, entry?.installPath)],
        { timeoutMs: 30_000 },
      );
      parsed = parsePluginDetails(id, text);
      this.cache.set(id, version, sha, parsed);
      this.fetched++;
      if (!this.quiet && this.fetched % 10 === 0) {
        process.stderr.write(`  priced ${this.fetched} plugins...\n`);
      }
    } catch {
      parsed = null;
    }
    this.resolved.set(id, parsed);
    return parsed;
  }

  entries(): Iterable<[string, PluginCost | null]> {
    return this.resolved.entries();
  }

  get size(): number {
    return this.resolved.size;
  }

  /** Persist what this run priced. Safe to call when nothing was. */
  flush(): void {
    this.cache.flush();
  }

  private list(): Map<string, InstalledPlugin> | null {
    if (this.listAttempted) return this.installed;
    this.listAttempted = true;
    try {
      const raw: InstalledPlugin[] = JSON.parse(
        claudeCli.run(['plugin', 'list', '--json'], { timeoutMs: 60_000 }),
      );
      // `plugin details` resolves the manifest name, which can differ in case from the
      // lowercased marketplace id -- see pluginLookupName.
      this.installed = new Map(raw.map((p) => [p.id, p]));
      this.shas = readInstalledShas();
      return this.installed;
    } catch {
      return null;
    }
  }
}

/** The run's index, held so whatever it priced reaches the on-disk cache on exit. */
let priced: LazyPluginCosts | null = null;

function flushPrices(): void {
  priced?.flush();
}

/**
 * `settingsValidity` overrides the `--full` rule for one directory (DEA-112).
 *
 * `qm set` needs its own target's validity on every run -- writing into a file Claude
 * Code discards is the failure the whole command exists to avoid -- and cannot pay
 * `--full`'s price for it, because `loadWorkspace` asks per registered project and there
 * are 30 of them here. One spawn, for the directory being written to, and every other
 * project stays `not-checked` exactly as it is on any run without `--full`.
 */
function buildContext(
  opts: Options,
  settingsValidity?: (dir: string) => ReadonlyMap<string, SettingsCheck>,
): AuditContext {
  const home = homedir();
  const target = opts.project ? resolve(opts.project) : null;

  if (target && !existsSync(target)) {
    console.error(`qm: no such directory: ${target}`);
    process.exit(2);
  }

  // A brand-new project is absent from `~/.claude.json`, so it has to be named
  // explicitly or `--project` silently audits the whole workspace instead.
  //
  // Validity is behind `--full` for the reason every other per-project scan is: `claude
  // doctor` validates the working directory it runs in, so this is one ~0.65s spawn per
  // live project. Without it every settings file reads `not-checked` and resolves exactly
  // as it did before DEA-147 -- which is the designed degradation, not a gap.
  const ws = loadWorkspace({
    ...(target ? { extraProjectPaths: [target] } : {}),
    ...(settingsValidity
      ? { settingsValidity }
      : opts.full
        ? { settingsValidity: doctorSettingsValidity() }
        : {}),
  });

  const targets = target
    ? ws.projects.filter((p) => p.path === target)
    : ws.projects.filter((p) => p.alive);

  const measurements: TranscriptMeasurement[] = [];
  for (const p of targets) measurements.push(...measureProject(home, p.path));

  // Nothing is priced here. The index spawns per plugin on first read, so a command
  // that reads no prices pays nothing and a scoped run pays only for its own project.
  priced = opts.withPluginCost ? new LazyPluginCosts(opts.json) : null;
  const pluginCosts: PluginCostIndex = priced ?? new Map<string, PluginCost | null>();

  // Independent of --no-plugin-cost: this reads files, not the CLI, so the flag that
  // skips ~25s of subprocesses has no reason to skip it.
  return { ws, measurements, pluginCosts, scope: target, inventories: readInventories(home) };
}

/**
 * Plugins whose cost could not be determined -- either the lookup failed or the output
 * did not parse.
 *
 * Reported rather than dropped. A silent skip is how DEA-109 hid: the parser returned
 * NaN for every plugin costing a thousand tokens or more, `costWithoutUse` filtered
 * them out on `Number.isFinite`, and the report simply came back smaller with no
 * indication that the two most expensive entries were missing.
 */
function unpricedPlugins(ctx: AuditContext): string[] {
  return [...ctx.pluginCosts.entries()]
    .filter(([, c]) => !c || !Number.isFinite(c.alwaysOnTokens))
    .map(([id]) => id)
    .sort();
}

function printUnpriced(ids: readonly string[]): void {
  if (!ids.length) return;
  console.log(
    `${DIM}${ids.length} plugin${ids.length === 1 ? '' : 's'} could not be priced ` +
      `— cost findings exclude ${ids.length === 1 ? 'it' : 'them'}:${RESET}`,
  );
  for (const id of ids.slice(0, 8)) console.log(`  ${id}`);
  if (ids.length > 8) console.log(`  ${DIM}…and ${ids.length - 8} more${RESET}`);
  console.log();
}

function printFindings(findings: Finding[], ctx: AuditContext): void {
  const live = ctx.ws.projects.filter((p) => p.alive).length;
  console.log(
    `\n${BOLD}quartermaster${RESET} ${DIM}· ${live} live projects · ` +
      `${ctx.measurements.length} sessions · ${ctx.pluginCosts.size} plugins priced${RESET}\n`,
  );

  if (!findings.length) {
    console.log('  No findings. Every entry resolves to something you decided.\n');
    return;
  }

  for (const f of findings) {
    const tag = paint(f.severity.toUpperCase().padEnd(6), COLOR[f.severity] ?? '');
    console.log(`${tag} ${BOLD}${f.title}${RESET}`);
    if (f.project) console.log(`       ${DIM}${f.project}${RESET}`);
    console.log(`       ${f.detail}`);
    for (const e of f.evidence) console.log(`       ${DIM}·${RESET} ${e}`);
    if (f.fix) console.log(`       ${DIM}fix:${RESET} ${f.fix}`);
    console.log();
  }

  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    DIM +
      Object.entries(counts)
        .map(([s, n]) => `${n} ${s}`)
        .join(' · ') +
      RESET +
      '\n',
  );
}

function printCost(ctx: AuditContext): void {
  const profile = profileFrom(ctx.measurements);
  const d = profile.deferredToolChars;

  console.log(
    `\n${BOLD}baseline context${RESET} ${DIM}· measured from ${profile.sessionsAnalyzed} sessions${RESET}\n`,
  );

  if (!d.samples) {
    console.log('  No transcripts with a tool-name block were found.\n');
    return;
  }

  console.log(`  ${BOLD}MCP tool names, chars per session${RESET}`);
  console.log(
    `    min ${num(d.min)}  ·  median ${num(d.median)}  ·  p95 ${num(d.p95)}  ·  max ${num(d.max)}` +
      `   ${DIM}(n=${d.samples})${RESET}`,
  );
  console.log(
    `    ${DIM}A range, not a number: servers connect asynchronously and entrypoints differ.${RESET}\n`,
  );

  console.log(`  ${BOLD}by block${RESET}`);
  for (const [kind, dist] of Object.entries(profile.blockChars)) {
    console.log(
      `    ${kind.padEnd(18)} median ${num(dist.median).padStart(8)}  max ${num(dist.max).padStart(8)}` +
        `  ${DIM}n=${dist.samples}${RESET}`,
    );
  }

  console.log(`\n  ${BOLD}top servers by peak cost${RESET}`);
  console.log(`    ${DIM}${'server'.padEnd(42)}${'kind'.padEnd(11)}${'tools'.padStart(6)}${'peak'.padStart(9)}${RESET}`);
  for (const s of profile.servers.slice(0, 10)) {
    console.log(
      `    ${s.server.slice(0, 40).padEnd(42)}${s.kind.padEnd(11)}${String(s.tools).padStart(6)}${num(s.chars.max).padStart(9)}`,
    );
  }

  const c = profile.connectorOverhead;
  if (c.servers) {
    console.log(`\n  ${BOLD}claude.ai connector UUID overhead${RESET}`);
    console.log(
      `    ${c.servers} connectors · ${c.tools} tools · ${num(c.chars)} chars of pure identifier`,
    );
    console.log(
      `    ${DIM}= ${(c.shareOfPeakBlock * 100).toFixed(0)}% of the largest observed tool-name block${RESET}`,
    );
  }
  console.log();
}

/**
 * `qm effect` -- what each togglable extension would cost to switch, before anyone
 * switches it.
 *
 * A subcommand rather than a line in `qm audit`, and read-only like every other:
 * nothing here is a *finding*. A finding says the configuration is wrong, and "toggling
 * this skill needs /reload-plugins" says nothing is wrong at all. Folding it into the
 * audit would put ~500 rows of routine answers beside a dozen problems and bury them.
 *
 * It stages nothing and writes nothing. The changes classified are hypothetical -- see
 * `candidateChanges` -- because Phase 1b has no apply path to stage a real one.
 */
function printEffects(ctx: AuditContext): void {
  const report = effectReportFor(ctx);
  const rows = tally(report);

  console.log(
    `\n${BOLD}pending-change effects${RESET} ${DIM}· ${report.classifications.length} togglable ` +
      `entries · deferral measured from ${report.measuredSessions} of ${report.totalSessions} sessions${RESET}\n`,
  );

  console.log(
    `  ${DIM}${'change kind'.padEnd(14)}${'reload'.padStart(8)}${'restart'.padStart(9)}` +
      `${'unknown'.padStart(9)}${'none'.padStart(7)}${RESET}`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.kind.padEnd(14)}${String(r.reload).padStart(8)}${String(r.restart).padStart(9)}` +
        `${String(r.unknown).padStart(9)}${String(r.none).padStart(7)}`,
    );
  }

  // `none` last and named, because it is the one column that says the change would not
  // land at all. Zero everywhere until `--full` has asked `doctor` about the files.
  const nothing = report.classifications.filter((c) => c.effect === 'none');
  if (nothing.length) {
    console.log(`\n  ${BOLD}would not take effect at all${RESET}`);
    for (const c of nothing) console.log(`    ${c.evidence[0] ?? c.reason}`);
  }

  const restarts = report.classifications.filter((c) => c.effect === 'restart');
  console.log(`\n  ${BOLD}needs a restart${RESET}`);
  if (!restarts.length) {
    console.log(`    ${DIM}nothing${RESET}`);
  }
  for (const c of restarts) {
    console.log(`    ${c.reason}`);
    for (const e of c.evidence.slice(0, 6)) console.log(`      ${DIM}·${RESET} ${e}`);
  }

  const unknowns = report.classifications.filter((c) => c.effect === 'unknown');
  console.log(`\n  ${BOLD}could not tell${RESET} ${DIM}(${unknowns.length})${RESET}`);
  console.log(
    `    ${DIM}Nothing records tools that loaded eagerly, so an unmeasured server is${RESET}\n` +
      `    ${DIM}"could not tell", never "restart". Open a session in the project to measure it.${RESET}`,
  );
  for (const c of unknowns.slice(0, 8)) {
    const id = c.change.kind === 'mcp-server' ? c.change.name : 'id' in c.change ? c.change.id : '';
    console.log(`    ${c.change.kind.padEnd(11)} ${id}`);
  }
  if (unknowns.length > 8) console.log(`    ${DIM}…and ${unknowns.length - 8} more${RESET}`);
  console.log();
}

/** The workspace's whole hypothetical change set, classified. */
function effectReportFor(ctx: AuditContext): EffectReport {
  const denyRules: Array<{
    rules: readonly string[];
    source: string;
    sourceValidity: SettingsValidity;
    project?: string;
  }> = [];
  // Deduplicated by path, for the reason `contributingFiles` gives: `~` is a registered
  // project whose `.claude/settings.json` *is* `~/.claude/settings.json`, so one file
  // arrives twice and the tally counted its rules twice.
  const seen = new Set<string>();
  const addDeny = (file: SettingsFile | null, project?: string) => {
    const rules = file?.permissions?.deny;
    if (!file || !rules?.length || seen.has(file.path)) return;
    seen.add(file.path);
    denyRules.push({
      rules,
      source: file.path,
      sourceValidity: file.validity,
      ...(project ? { project } : {}),
    });
  };
  addDeny(ctx.ws.userSettings);
  for (const p of ctx.ws.projects) {
    addDeny(p.settings, p.path);
    addDeny(p.localSettings, p.path);
  }

  const changes = candidateChanges({
    skills: allSkillIds(buildSkillCatalog(ctx.ws, ctx.measurements, ctx.inventories)),
    plugins: allPluginIds(ctx.ws, ctx.inventories),
    mcpServers: allMcpServerNames(buildMcpCatalog(ctx.ws, ctx.inventories)),
    denyRules,
  });

  return classifyAll(changes, {
    index: buildDeferralIndex(ctx.measurements),
    inventories: ctx.inventories,
  });
}

function baselinePath(): string {
  return join(stateDir(), 'baseline.json');
}

/** Beside the baseline, for the same reason: it is this tool's state, not the user's. */
function oracleStatePath(): string {
  return join(stateDir(), 'oracle-run.json');
}

/** Drift is the diff, so only what moved is worth printing. */
function printDrift(
  drift: { appeared: Finding[]; resolved: string[]; unchanged: number },
  savedAt: string,
): void {
  console.log(`\n${BOLD}drift${RESET} ${DIM}since ${savedAt}${RESET}\n`);

  if (!drift.appeared.length && !drift.resolved.length) {
    console.log(`  Nothing changed. ${drift.unchanged} finding(s) still open.\n`);
    return;
  }

  for (const f of drift.appeared) {
    console.log(`${paint('NEW   ', COLOR[f.severity] ?? '')} ${BOLD}${f.title}${RESET}`);
    if (f.project) console.log(`       ${DIM}${f.project}${RESET}`);
  }
  for (const key of drift.resolved) {
    console.log(`${paint('GONE  ', '[32m')} ${DIM}${key}${RESET}`);
  }
  console.log(
    `\n${DIM}${drift.appeared.length} new · ${drift.resolved.length} resolved · ${drift.unchanged} unchanged${RESET}\n`,
  );
}

/**
 * `qm oracle` -- ask the live binary the question the resolver answers, and say nothing
 * when the answers still match (DEA-118).
 *
 * A distinct subcommand rather than a flag on `qm audit`, for two reasons. It is the one
 * path in this tool that can file an issue, and something that reaches outward must not
 * be one typo away from the command people run daily. And it needs none of what `audit`
 * builds -- no transcript measurement, no plugin pricing -- so it loads the workspace
 * itself and skips `buildContext` entirely.
 *
 * Not named `drift-check`: `qm audit --drift` already exists and means the diff against
 * a saved baseline of *our* findings. This is the opposite direction -- whether the
 * first-party behaviour our findings rest on has moved underneath them -- and two
 * neighbouring things both called drift is how someone runs the wrong one.
 *
 * Exit codes, because a scheduled job is read by machines: 0 agreed, 1 diverging, 2 the
 * check itself failed.
 */
async function oracle(opts: Options): Promise<void> {
  const statePath = oracleStatePath();

  if (opts.status) {
    console.log(statusReport(readRunState(statePath), new Date(), statePath));
    return;
  }

  // Constructed here and nowhere else. Dry run is not a mode this falls back to on
  // error -- an unconfigured `--file-issue` stops, because a scheduled job that quietly
  // downgrades to filing nothing is the silent failure this whole command is about.
  let file: IssueFiler | undefined;
  if (opts.fileIssue) {
    const cfg = linearConfigFromEnv(process.env);
    if ('error' in cfg) {
      console.error(`qm: --file-issue cannot file — ${cfg.error}`);
      process.exit(2);
    }
    file = linearFiler(cfg);
  }

  // No validity check here, deliberately (DEA-147). A settings file Claude Code discards
  // is precisely a divergence between this resolver and first-party, and that divergence
  // is what found the bug: the gate went red with 21 mismatches and stayed red until the
  // cause was named. Feeding the check its own answer would make the next occurrence
  // agree with itself and say nothing, which is the one outcome an oracle must not have.
  // It would also double the spawns -- `plugin list --json` per project, plus a `doctor`.
  const outcome = await runOracleCheck({
    ws: loadWorkspace(),
    read: liveOracle,
    statePath,
    now: new Date(),
    ...(file ? { file } : {}),
  });

  if (outcome.broken) {
    console.error(outcome.report);
    process.exitCode = 2;
    return;
  }

  // Silence is the answer when they agree. No all-clear line, no heartbeat: the run is
  // recorded in `statePath` and `qm oracle --status` is how you ask.
  if (!outcome.report) return;

  console.log(outcome.report);
  if (outcome.draft && !file) {
    console.log(
      `\n  Dry run — nothing was filed. Pass --file-issue to open this in Linear:\n` +
        `    ${outcome.draft.title}`,
    );
  }
  if (outcome.filed) console.log(`\n  Filed ${outcome.filed.identifier} — ${outcome.filed.url}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

/**
 * `qm set <id>=<value> ...` -- one project, one axis, one diff, one confirmation, one write.
 *
 * **Several targets in one invocation, and no state between invocations.** CLAUDE.md's
 * convention is that edits stage in memory and apply as one reviewed batch; a CLI meets
 * that by taking every target on one command line, showing one diff and applying once.
 * Staging to disk and applying in a later run would be a state machine with its own
 * staleness and abandonment problems, and nothing here needs one.
 *
 * **`--project` is required rather than defaulting to the working directory.** Every
 * other command defaults to the whole workspace and this one writes, so the difference
 * between auditing the wrong project and writing into it is the whole reason to make the
 * caller say which.
 *
 * **`--axis` is not inferred from the id either (QM-45).** `enabledPlugins` and
 * `skillOverrides` share a file and share the `on`/`off` spellings, and a plugin id and a
 * bare skill name are both just strings -- so a rule that guessed would guess wrong on the
 * first ambiguous name and write a live-looking entry into a key nothing reads. Measured
 * on 2.1.224: `skillOverrides` accepts any string key, writes it, and silently does
 * nothing for one it does not match.
 */
async function set(args: string[], opts: Options): Promise<void> {
  if (!opts.project) {
    console.error(
      'qm: set needs --project <path>. It writes, so the target is never inferred from the ' +
        'working directory.',
    );
    process.exit(2);
  }

  const requests = parseToggles(opts.axis, args);
  const target = resolve(opts.project);
  const ctx = buildContext(opts, targetOnlyValidity(target));

  const result = planToggles(ctx, opts.axis, target, requests);
  if (result.outcome === 'refused') {
    console.log(`\n${BOLD}qm set${RESET} ${DIM}· nothing was written${RESET}\n`);
    for (const r of result.refusals) {
      console.log(`  ${paint(r.code, COLOR['high'] ?? '')} ${r.message}`);
      for (const e of r.evidence) console.log(`      ${DIM}·${RESET} ${e}`);
      if (r.fix) console.log(`      ${DIM}fix:${RESET} ${r.fix}`);
      console.log();
    }
    process.exitCode = 1;
    return;
  }

  const { plan } = result;
  console.log(`\n${BOLD}qm set${RESET} ${DIM}· ${plan.project}${RESET}\n`);
  for (const line of describePlan(plan)) console.log(line);
  console.log();

  if (!opts.yes && !(await confirm('Apply this change? [y/N] '))) {
    console.log('\nNothing was written.\n');
    return;
  }

  const applied = applyPlan(plan, { now: new Date(), state: stateDir() });
  if (applied.outcome === 'refused') {
    console.log(`\n  ${paint(applied.code, COLOR['high'] ?? '')} ${applied.message}`);
    for (const e of applied.evidence) console.log(`      ${DIM}·${RESET} ${e}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log(`\n  wrote ${num(applied.bytes)} bytes to ${plan.target}`);
  console.log(`  ${DIM}backup${RESET} ${applied.backup}`);
  // The classifier's verdict, not a sentence about sessions. A blanket "takes effect next
  // session" is false for a toggle that /reload-plugins picks up, and this project does
  // not ship a confidently wrong statement (DEA-123).
  console.log(`  ${DIM}effect${RESET} ${planEffect(plan)}`);
  console.log(`  ${DIM}undo with${RESET} qm undo\n`);
}

/**
 * `<id>=<value>`, where the accepted values are the axis's own.
 *
 * Split on the last `=`, because an id may not contain one. The grammar is read off
 * `axis.spellings` rather than written out here: a list in this function would be a second
 * statement of which values the axis has, and the one that a four-valued write would have
 * to get past to collapse. So `--axis skill` accepts exactly the four states and nothing
 * else -- `true` is rejected here, not silently mapped onto `on`.
 */
function parseToggles(axis: Axis, args: readonly string[]): ToggleRequest[] {
  const grammar = `<id>=${[...axis.spellings.keys()].join('|')}`;
  if (!args.length) {
    console.error(`qm: set needs at least one ${grammar}`);
    process.exit(2);
  }
  return args.map((spec) => {
    const at = spec.lastIndexOf('=');
    const spelling = at === -1 ? '' : spec.slice(at + 1).toLowerCase();
    const value = axis.spellings.get(spelling);
    if (at <= 0 || value === undefined) {
      console.error(`qm: expected ${grammar}, got ${JSON.stringify(spec)}`);
      process.exit(2);
    }
    return { id: spec.slice(0, at), value };
  });
}

/** One `claude doctor` spawn, for the directory being written to and no other. */
function targetOnlyValidity(target: string): (dir: string) => ReadonlyMap<string, SettingsCheck> {
  const live = doctorSettingsValidity();
  const none: ReadonlyMap<string, SettingsCheck> = new Map();
  return (dir) => (dir === target ? live(dir) : none);
}

/**
 * The consent. Anything but `y`/`yes` is a no, including a closed stdin.
 *
 * `readline` rather than reading the descriptor, so this works the same when a person
 * types and when a script pipes -- and the `close` handler is what stops a run with no
 * stdin at all from hanging on a question nobody can answer.
 *
 * The answer is settled **before** `rl.close()`, and the order is the whole of it:
 * closing emits `close` synchronously, so closing first lets the no-stdin handler resolve
 * the promise and a piped `y` reads as a decline. Measured that way round first.
 */
function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((done) => {
    rl.on('close', () => done(false));
    rl.question(prompt, (answer) => {
      done(/^y(es)?$/i.test(answer.trim()));
      rl.close();
    });
  });
}

/**
 * `qm undo` -- put the last apply back, once.
 *
 * Loads no workspace: the record names the file, and re-reading 30 projects to restore
 * one of them would be paying `audit`'s price for a two-file operation.
 */
function undo(): void {
  const result = undoLast({ now: new Date(), state: stateDir() });

  if (result.outcome === 'nothing') {
    console.log(`\n${result.message}\n`);
    return;
  }
  if (result.outcome === 'refused') {
    console.log(`\n  ${paint(result.code, COLOR['high'] ?? '')} ${result.message}`);
    for (const e of result.evidence) console.log(`      ${DIM}·${RESET} ${e}`);
    console.log();
    process.exitCode = 1;
    return;
  }

  const { record } = result;
  console.log(`\n  restored ${num(result.bytes)} bytes to ${record.target}`);
  console.log(`  ${DIM}from${RESET} ${record.backup}`);
  for (const c of record.changes) {
    console.log(`  ${DIM}·${RESET} ${c.id}: ${showValue(c.to)} -> ${showValue(c.from)}`);
  }
  if (record.createdTarget) {
    console.log(
      `  ${DIM}the file did not exist before that apply; it is back to the empty settings ` +
        `it was created as, and was not removed${RESET}`,
    );
  }
  console.log();
}

/**
 * A foreground server, and no daemon behind it.
 *
 * Ctrl-C is handled rather than left to the default so the run returns through `main`
 * and the `finally` below reaches `flushPrices`. Without it, every price the grid paid
 * ~0.6s for would be discarded on exit and paid again on the next start.
 */
async function serve(ctx: AuditContext, port: number): Promise<void> {
  let server;
  try {
    server = await startServer(ctx, { port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(`qm: port ${port} is already in use. Free it, or pass --port <n>.`);
      process.exit(1);
    }
    throw err;
  }

  console.log(`\n${BOLD}quartermaster${RESET} ${DIM}· read-only · loopback only${RESET}`);
  console.log(`  ${server.url}`);

  // An absent filter must be reported rather than shown as an empty one: a category
  // dropdown offering nothing reads as "no plugin is categorised" instead of "the rubric
  // was not there to consult".
  const cat = server.categories;
  console.log(
    `\n${DIM}${
      cat.found
        ? `plugin categories: ${cat.matched}/${cat.total} named by project-optimizer's plugin-matrix.md`
        : 'plugin categories: plugin-matrix.md not found — the category filter is hidden'
    }${RESET}`,
  );
  console.log(`${DIM}Ctrl-C to stop.${RESET}`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      void server.close().then(resolve);
    });
  });
}

async function main(): Promise<void> {
  const { command, args, opts } = parseArgs(process.argv.slice(2));

  if (command === 'help' || process.argv.includes('--help')) {
    console.log(`
${BOLD}qm${RESET} -- audit which Claude Code extensions load where, and what they cost.

  qm audit    [--json] [--full] [--project <path>] [--drift] [--no-plugin-cost]
  qm cost     [--json] [--project <path>]
  qm effect   [--json]        what toggling each extension needs: reload, or a restart
  qm baseline [--full]        record today's findings, so --drift can diff against them
  qm serve    [--port <n>]    serve the grid on 127.0.0.1 until Ctrl-C
  qm oracle   [--status] [--file-issue]
  qm set      --project <path> [--axis plugin|skill] <id>=<value> [...] [--yes]
  qm undo

  --full    also scan git hygiene and project layout via project-optimizer, and ask
            claude doctor whether each project's settings files pass Claude Code's
            schema -- one spawn per project. Without it every file reads "not checked",
            which resolves the same way parsing alone always has.
  --no-github  skip GitHub checks in --full (for offline use or no gh CLI)

\`qm oracle\` re-asks \`claude plugin list --json\` in every registered project and compares
it against the resolver, which was built from reverse-engineered rules. It prints nothing
when they agree — \`--status\` reads the last run, which is how you tell a quiet check from
a dead one. \`--file-issue\` opens a Linear issue for a divergence and is the only thing in
this tool that reaches outside the machine; without it the run is a dry run. It checks the
per-directory \`enabled\` resolution and nothing else. Schedule it weekly with
scripts/install-oracle-schedule.sh.

\`qm set\` is the only command that writes, and it writes exactly one file:
<project>/.claude/settings.local.json. It prints the whole diff, says what the change
needs before it is live, and asks before applying. It refuses rather than write when
Claude Code would discard the target, when claude doctor reported on it in words this
release cannot place, or when the id already resolves to the value you asked for.
\`qm undo\` restores the last apply, once, and refuses if the file has changed since.

  --axis plugin   ${'enabledPlugins'}, on|off (true|false also accepted)   ${DIM}the default${RESET}
  --axis skill    ${'skillOverrides'}, on|name-only|user-invocable-only|off

Skills are four-valued, so \`--axis skill\` takes four spellings and no booleans — there is
no answer to which of \`on\` and \`name-only\` a \`true\` would mean. The id is the string
Claude Code publishes: \`<plugin>:<skill>\` for a plugin's skill, the bare directory name
for a personal one. A key it does not match is accepted, written, and does nothing.
Backups live beside the baseline in \${XDG_STATE_HOME:-~/.local/state}/claude-quartermaster.

Every other command is read-only. The first-party \`claude\` subcommands they invoke do
create ~/.claude.json on a machine that has none, and the run says so when that happens.
`);
    return;
  }

  // Before `buildContext`, which measures every transcript in the workspace. This
  // command reads none of that, and a weekly job should not pay for it.
  if (command === 'oracle') {
    await oracle(opts);
    return;
  }

  // Likewise: the undo record names its own file, so nothing about the workspace is read.
  if (command === 'undo') {
    undo();
    return;
  }

  if (command === 'set') {
    await set(args, opts);
    return;
  }

  const ctx = buildContext(opts);

  if (command === 'serve') {
    await serve(ctx, opts.port);
    return;
  }

  if (command === 'cost') {
    if (opts.json) {
      console.log(JSON.stringify(profileFrom(ctx.measurements), null, 2));
    } else {
      printCost(ctx);
    }
    return;
  }

  if (command === 'effect') {
    if (opts.json) {
      console.log(JSON.stringify(effectReportFor(ctx), null, 2));
    } else {
      printEffects(ctx);
    }
    return;
  }

  const scopedTo = opts.project ? resolve(opts.project) : null;

  // The standard turns the four onboarding moments into one path: a fresh directory,
  // an unconfigured repo, and a drifted one all differ only in starting state.
  // Grouped: "this project decided nothing" repeated across six projects is one piece
  // of work, and the same helper the delegation layer uses keeps that consistent.
  const standardFindings = groupByDetector(
    (scopedTo
      ? ctx.ws.projects.filter((p) => p.path === scopedTo).map((p) => checkProject(ctx, p))
      : checkAll(ctx)
    ).flatMap((r) => r.findings),
  );

  // Workspace-wide findings are not about the named project, so a scoped run drops them.
  const native = [...runAll(ctx), ...standardFindings].filter(
    (f) => !scopedTo || f.project === scopedTo,
  );

  // Delegated domains. Always ask the adapters what they cover, even without --full,
  // so the report can name what it did not examine; only actually run the scanners
  // when asked, since they cost ~0.65s per project plus network.
  const targets = opts.full
    ? ctx.ws.projects.filter((p) => p.alive).map((p) => p.path)
    : [];
  const adapters = opts.full
    ? [doctorAdapter(), projectOptimizerAdapter({ github: opts.github }), projectOptimizerJudgementAdapter()]
    : [doctorAdapter(), projectOptimizerJudgementAdapter()];

  if (opts.full) process.stderr.write(`  scanning ${targets.length} projects...\n`);
  const delegated: DelegationReport = await collect(adapters, targets);
  const findings = rank([...native, ...delegated.findings]);

  if (command === 'baseline') {
    const path = baselinePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(makeBaseline(findings, new Date().toISOString()), null, 2));
    const saved = makeBaseline(findings, new Date().toISOString());
    console.log(
      `saved ${saved.findings.length} distinct findings as the baseline\n  ${path}`,
    );
    return;
  }

  const baseline = opts.drift ? readBaseline(baselinePath()) : null;
  const drift = baseline ? compareToBaseline(findings, baseline) : null;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          projects: ctx.ws.projects.filter((p) => p.alive).length,
          sessions: ctx.measurements.length,
          unreadable: problems,
          unchecked: delegated.unchecked,
          // Beside `unchecked` and for its reason (DEA-148): a run without --full asks
          // `claude doctor` about no settings file at all, so `discarded-settings` emits
          // nothing and the absence has to be readable as "did not look" rather than as
          // "nothing wrong". Not a finding -- it has no severity, and it is a property of
          // this run rather than of the configuration.
          settingsValidity: settingsValidityTally(ctx.ws),
          // A settings file `doctor` reported on whose message this release does not
          // recognise (DEA-151). Beside the tally rather than inside it: those four
          // counts are validities, and this is the subset of one of them that means
          // "first-party said something new", which is the only way the classifier's
          // chosen failure -- lose a detection rather than invent one -- becomes visible.
          unclassifiedSettings: unclassifiedSettings(ctx.ws).map((f) => ({
            path: f.path,
            messages: f.schemaErrors.map((e) => `${e.key}: ${e.message}`),
          })),
          unpriced: unpricedPlugins(ctx),
          // Not a finding, and deliberately not routed through one: it has no severity
          // and says nothing about the user's configuration. It reports what this run
          // did -- null on every machine that already had the file, which is nearly all
          // of them.
          initialised: claudeCli.disclosure(),
          ...(drift ? { drift } : {}),
          findings,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.drift) {
    if (!baseline) {
      console.log('\nNo baseline saved. Run `qm baseline` first.\n');
      return;
    }
    printDrift(drift!, baseline.savedAt);
    return;
  }

  printFindings(findings, ctx);
  printUnpriced(unpricedPlugins(ctx));
  printSettingsValidity(ctx, opts.full);
  printUnchecked(delegated, opts.full);
  if (problems.length) {
    console.log(`${DIM}${problems.length} file(s) could not be parsed:${RESET}`);
    for (const p of problems.slice(0, 5)) console.log(`  ${p.path}`);
    console.log();
  }
}

/**
 * How many settings files were asked about, and how they answered (DEA-148).
 *
 * Prints on every audit, including one with no findings, because that is the run this
 * line exists for: without `--full` nothing asks `claude doctor` anything, every file is
 * `not-checked`, and `discarded-settings` is silent about a workspace it never examined.
 * A tally rather than a finding, for the reason the disclosure field is not one -- it has
 * no severity and describes the run.
 */
function printSettingsValidity(ctx: AuditContext, ranFull: boolean): void {
  const tally = settingsValidityTally(ctx.ws);
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  if (!total) return;

  const checked = total - tally['not-checked'];
  const parts = [
    `${tally.accepted} accepted`,
    `${tally['field-dropped']} field-dropped`,
    `${tally.discarded} discarded`,
    `${tally['not-checked']} not checked`,
  ];

  console.log(
    `${DIM}settings validity: ${total} file${total === 1 ? '' : 's'} — ${parts.join(' · ')}${RESET}`,
  );
  if (!checked) {
    console.log(
      `  ${DIM}nothing was validated${
        ranFull ? ' — claude doctor did not answer here' : '; pass --full to ask claude doctor'
      }. A file nobody checked is not a file that applies.${RESET}`,
    );
  }

  // The half of `not-checked` that is news rather than absence (DEA-151). An unrecognised
  // message costs a detection by design -- the alternative is inventing one on a live file
  // -- and this is what stops that cost being paid silently.
  const unclassified = unclassifiedSettings(ctx.ws);
  if (unclassified.length) {
    console.log(
      `  ${DIM}${unclassified.length} file${unclassified.length === 1 ? '' : 's'} reported by ` +
        'claude doctor in words this release does not recognise, so whether Claude Code ' +
        `still applies ${unclassified.length === 1 ? 'it' : 'them'} was not decided:${RESET}`,
    );
    for (const f of unclassified.slice(0, 4)) {
      console.log(`    ${DIM}${f.path}${RESET}`);
      for (const e of f.schemaErrors) console.log(`      ${DIM}${e.key}: ${e.message}${RESET}`);
    }
  }
  console.log();
}

/**
 * An unexamined domain must never read as a clean one. This prints even when there
 * are no findings at all.
 */
function printUnchecked(report: DelegationReport, ranFull: boolean): void {
  if (!report.unchecked.length) return;

  console.log(`${DIM}not examined:${RESET}`);
  for (const u of report.unchecked) {
    console.log(`  ${u.domain}`);
    console.log(`    ${DIM}${u.reason}${RESET}`);
    if (u.invoke) console.log(`    ${DIM}run${RESET} ${u.invoke} ${DIM}in a session${RESET}`);
  }
  if (!ranFull) {
    console.log(`  ${DIM}git, GitHub, and layout skipped — pass --full to scan them${RESET}`);
  }
  console.log();
}

try {
  await main();
} finally {
  // Every exit path, including the early returns: a price paid on this run must not be
  // paid again on the next one.
  flushPrices();

  // Here for the same reason, and not in `printFindings`: `baseline` and `serve` spawn
  // the same subcommands `audit` does, so a disclosure only `audit` makes is not one.
  // stderr rather than stdout so it survives `--json` and a redirect without either
  // corrupting the payload or being suppressed -- `--json` also carries it in the
  // report body, where a consumer can read it as a field.
  const init = claudeCli.disclosure();
  if (init) process.stderr.write(`\n${init.note}\n`);
}
