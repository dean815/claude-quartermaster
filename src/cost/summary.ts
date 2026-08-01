/**
 * Aggregating measured cost across sessions and projects.
 *
 * One session is a sample, not a measurement of the workspace. Servers connect
 * asynchronously and entrypoints differ, so the same project can report wildly
 * different baselines minutes apart. Everything here reports distributions, and
 * `sessions` is always carried alongside so a figure drawn from two samples cannot be
 * mistaken for one drawn from two hundred.
 */
import type { TranscriptMeasurement, ServerKind } from './transcript.ts';
import { measureProject, unauthenticatedButListed } from './transcript.ts';

export interface Distribution {
  samples: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { samples: 0, min: 0, p25: 0, median: 0, p75: 0, p95: 0, max: 0 };
  }
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  return {
    samples: s.length,
    min: s[0]!,
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    p95: q(0.95),
    max: s.at(-1)!,
  };
}

export interface AggregateServerCost {
  server: string;
  kind: ServerKind;
  /** Sessions this server published tools in. */
  sessions: number;
  tools: number;
  /** Char cost when present. Constant per server in practice, but measured not assumed. */
  chars: Distribution;
  uuidOverhead: number;
}

export interface CostProfile {
  sessionsAnalyzed: number;
  projectsAnalyzed: number;
  /** Per-session totals for the tool-name block. The headline is a range, not a point. */
  deferredToolChars: Distribution;
  deferredToolCount: Distribution;
  blockChars: Record<string, Distribution>;
  servers: AggregateServerCost[];
  /**
   * claude.ai connectors namespace every tool with a 36-char UUID. It carries no
   * meaning to the model and is charged on every tool name the connector publishes.
   */
  connectorOverhead: {
    servers: number;
    tools: number;
    chars: number;
    /** Share of the largest session's tool-name block that is UUID alone. */
    shareOfPeakBlock: number;
  };
  /** Servers reported unauthenticated that nonetheless published tool names. */
  payingForUnauthenticated: AggregateServerCost[];
}

export function profileFrom(measurements: readonly TranscriptMeasurement[]): CostProfile {
  const withTools = measurements.filter((m) =>
    m.blocks.some((b) => b.kind === 'deferred_tools'),
  );

  const charsOf = (m: TranscriptMeasurement, kind: string) =>
    m.blocks.find((b) => b.kind === kind)?.chars ?? 0;

  const blockChars: Record<string, Distribution> = {};
  for (const kind of [
    'deferred_tools',
    'mcp_instructions',
    'skill_listing',
    'agent_listing',
    'hook_output',
  ]) {
    const vals = measurements.map((m) => charsOf(m, kind)).filter((n) => n > 0);
    if (vals.length) blockChars[kind] = distribution(vals);
  }

  // Fold per-server costs across sessions.
  const byServer = new Map<
    string,
    { kind: ServerKind; sessions: number; tools: number; chars: number[]; uuid: number }
  >();
  const needyEverywhere = new Set<string>();

  for (const m of measurements) {
    for (const s of m.servers) {
      const acc = byServer.get(s.server) ?? {
        kind: s.kind,
        sessions: 0,
        tools: 0,
        chars: [],
        uuid: 0,
      };
      acc.sessions += 1;
      acc.tools = Math.max(acc.tools, s.tools);
      acc.chars.push(s.chars);
      acc.uuid = Math.max(acc.uuid, s.uuidOverhead);
      byServer.set(s.server, acc);
    }

    // Must be same-session. A server can need auth in one session and be connected in
    // the next, so unioning the two sets across sessions manufactures overlap that
    // never existed -- it reported 31 servers where the per-session answer is 0.
    for (const s of unauthenticatedButListed(m)) needyEverywhere.add(s.server);
  }

  const servers: AggregateServerCost[] = [...byServer.entries()]
    .map(([server, a]) => ({
      server,
      kind: a.kind,
      sessions: a.sessions,
      tools: a.tools,
      chars: distribution(a.chars),
      uuidOverhead: a.uuid,
    }))
    .sort((a, b) => b.chars.max - a.chars.max);

  const connectors = servers.filter((s) => s.kind === 'connector');
  const peakBlock = Math.max(0, ...withTools.map((m) => charsOf(m, 'deferred_tools')));
  const uuidChars = connectors.reduce((n, s) => n + s.uuidOverhead, 0);

  return {
    sessionsAnalyzed: measurements.length,
    projectsAnalyzed: new Set(measurements.map((m) => m.path.split('/').at(-2))).size,
    deferredToolChars: distribution(withTools.map((m) => charsOf(m, 'deferred_tools'))),
    deferredToolCount: distribution(
      withTools.map((m) => m.blocks.find((b) => b.kind === 'deferred_tools')!.items),
    ),
    blockChars,
    servers,
    connectorOverhead: {
      servers: connectors.length,
      tools: connectors.reduce((n, s) => n + s.tools, 0),
      chars: uuidChars,
      shareOfPeakBlock: peakBlock ? uuidChars / peakBlock : 0,
    },
    payingForUnauthenticated: servers.filter((s) => needyEverywhere.has(s.server)),
  };
}

/** Measure every session recorded for the given projects. */
export function profileProjects(home: string, projectPaths: readonly string[]): CostProfile {
  const all: TranscriptMeasurement[] = [];
  for (const p of projectPaths) all.push(...measureProject(home, p));
  return profileFrom(all);
}
