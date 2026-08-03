#!/usr/bin/env node
/**
 * `qm` -- read-only. Nothing here writes to any Claude Code config; the first-party
 * subcommands it invokes do initialise `~/.claude.json` on a machine that has none,
 * and the run discloses it. See `disclose.ts`.
 */
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
import { runAll, rank, type AuditContext, type Finding } from './detect.ts';
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
import { startServer, DEFAULT_PORT } from './view/server.ts';
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
  port: number;
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

function parseArgs(argv: string[]): { command: string; opts: Options } {
  // Guard the -1 case: `idx + 1` would be 0 and drop the command itself, so every
  // invocation without a value flag silently fell back to `audit`.
  const valueIdxOf = (flag: string) => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? -1 : idx + 1;
  };
  const projectIdx = valueIdxOf('--project');
  const portIdx = valueIdxOf('--port');
  const positional = argv.filter(
    (a, i) => !a.startsWith('-') && i !== projectIdx && i !== portIdx,
  );
  return {
    command: positional[0] ?? 'audit',
    opts: {
      json: argv.includes('--json'),
      withPluginCost: !argv.includes('--no-plugin-cost'),
      full: argv.includes('--full'),
      github: !argv.includes('--no-github'),
      drift: argv.includes('--drift'),
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
  const { command, opts } = parseArgs(process.argv.slice(2));

  if (command === 'help' || process.argv.includes('--help')) {
    console.log(`
${BOLD}qm${RESET} -- audit which Claude Code extensions load where, and what they cost.

  qm audit    [--json] [--full] [--project <path>] [--drift] [--no-plugin-cost]
  qm cost     [--json] [--project <path>]
  qm baseline [--full]        record today's findings, so --drift can diff against them
  qm serve    [--port <n>]    serve the grid on 127.0.0.1 until Ctrl-C

  --full    also scan git hygiene and project layout via project-optimizer
  --no-github  skip GitHub checks in --full (for offline use or no gh CLI)

Read-only: qm writes no Claude Code config. The first-party \`claude\` subcommands it
invokes do create ~/.claude.json on a machine that has none, and the run says so when
that happens.
`);
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
