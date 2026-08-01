#!/usr/bin/env node
/**
 * `qm` -- read-only. Nothing here writes to any Claude Code config.
 */
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

import { loadWorkspace, problems } from './surfaces/read.ts';
import { measureProject } from './cost/transcript.ts';
import { profileFrom } from './cost/summary.ts';
import { parsePluginDetails, pluginLookupName, type PluginCost } from './cost/plugins.ts';
import { PluginCostCache } from './cache.ts';
import { runAll, rank, type AuditContext, type Finding } from './detect.ts';
import { allPluginIds } from './resolve.ts';
import { collect, groupByDetector, type DelegationReport } from './delegate/types.ts';
import {
  projectOptimizerAdapter,
  projectOptimizerJudgementAdapter,
} from './delegate/projectOptimizer.ts';
import { doctorAdapter } from './delegate/doctor.ts';
import {
  checkProject,
  checkAll,
  makeBaseline,
  compareToBaseline,
  readBaseline,
} from './standard.ts';
import type { TranscriptMeasurement } from './cost/transcript.ts';

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
  project: string | null;
}

function parseArgs(argv: string[]): { command: string; opts: Options } {
  const idx = argv.indexOf('--project');
  // Guard the -1 case: `idx + 1` would be 0 and drop the command itself, so every
  // invocation without --project silently fell back to `audit`.
  const valueIdx = idx === -1 ? -1 : idx + 1;
  const positional = argv.filter((a, i) => !a.startsWith('-') && i !== valueIdx);
  return {
    command: positional[0] ?? 'audit',
    opts: {
      json: argv.includes('--json'),
      withPluginCost: !argv.includes('--no-plugin-cost'),
      full: argv.includes('--full'),
      github: !argv.includes('--no-github'),
      drift: argv.includes('--drift'),
      project: idx !== -1 ? (argv[idx + 1] ?? null) : null,
    },
  };
}

/** Fetch per-plugin cost, cached by version so repeat runs are instant. */
function collectPluginCosts(ids: string[], quiet: boolean): Map<string, PluginCost | null> {
  const cache = new PluginCostCache();
  const out = new Map<string, PluginCost | null>();

  let installed: Array<{ id: string; version: string | null; installPath?: string }> = [];
  try {
    installed = JSON.parse(
      execFileSync('claude', ['plugin', 'list', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000,
      }),
    );
  } catch {
    return out; // No CLI, no component cost. Detectors that need it stay quiet.
  }

  const versions = new Map(installed.map((p) => [p.id, p.version ?? null]));
  // `plugin details` resolves the manifest name, which can differ in case from the
  // lowercased marketplace id -- see pluginLookupName.
  const paths = new Map(installed.map((p) => [p.id, p.installPath ?? null]));
  let fetched = 0;

  for (const id of ids) {
    const version = versions.get(id) ?? null;
    const hit = cache.get(id, version);
    if (hit) {
      out.set(id, hit);
      continue;
    }
    try {
      const text = execFileSync('claude', ['plugin', 'details', pluginLookupName(id, paths.get(id))], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000,
      });
      const parsed = parsePluginDetails(id, text);
      cache.set(id, version, parsed);
      out.set(id, parsed);
      fetched++;
      if (!quiet && fetched % 10 === 0) process.stderr.write(`  priced ${fetched} plugins...\n`);
    } catch {
      out.set(id, null);
    }
  }

  cache.flush();
  return out;
}

function buildContext(opts: Options): AuditContext {
  const home = homedir();
  const target = opts.project ? resolve(opts.project) : null;

  if (target && !existsSync(target)) {
    console.error(`qm: no such directory: ${target}`);
    process.exit(2);
  }

  // A brand-new project is absent from `~/.claude.json`, so it has to be named
  // explicitly or `--project` silently audits the whole workspace instead.
  const ws = loadWorkspace(target ? { extraProjectPaths: [target] } : {});

  const targets = target
    ? ws.projects.filter((p) => p.path === target)
    : ws.projects.filter((p) => p.alive);

  const measurements: TranscriptMeasurement[] = [];
  for (const p of targets) measurements.push(...measureProject(home, p.path));

  const pluginCosts = opts.withPluginCost
    ? collectPluginCosts(allPluginIds(ws), opts.json)
    : new Map<string, PluginCost | null>();

  return { ws, measurements, pluginCosts };
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

function baselinePath(): string {
  const base = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  return join(base, 'claude-quartermaster', 'baseline.json');
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

async function main(): Promise<void> {
  const { command, opts } = parseArgs(process.argv.slice(2));

  if (command === 'help' || process.argv.includes('--help')) {
    console.log(`
${BOLD}qm${RESET} -- audit which Claude Code extensions load where, and what they cost.

  qm audit    [--json] [--full] [--project <path>] [--drift] [--no-plugin-cost]
  qm cost     [--json] [--project <path>]
  qm baseline [--full]        record today's findings, so --drift can diff against them

  --full    also scan git hygiene and project layout via project-optimizer
  --no-github  skip GitHub checks in --full (for offline use or no gh CLI)

Read-only. Nothing here writes to any Claude Code config.
`);
    return;
  }

  const ctx = buildContext(opts);

  if (command === 'cost') {
    if (opts.json) {
      console.log(JSON.stringify(profileFrom(ctx.measurements), null, 2));
    } else {
      printCost(ctx);
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
          unpriced: unpricedPlugins(ctx),
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
  printUnchecked(delegated, opts.full);
  if (problems.length) {
    console.log(`${DIM}${problems.length} file(s) could not be parsed:${RESET}`);
    for (const p of problems.slice(0, 5)) console.log(`  ${p.path}`);
    console.log();
  }
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

await main();
