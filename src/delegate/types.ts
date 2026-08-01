/**
 * Delegation.
 *
 * Quartermaster owns extensions, cost, and cross-project resolution. It does not own
 * CLAUDE.md quality, git hygiene, or project layout -- `/doctor` and
 * `project-optimizer` already do those, and rebuilding them would mean maintaining a
 * second opinion that silently drifts from the first.
 *
 * Every adapter reports its availability explicitly. A domain that could not be
 * checked says so; it never silently passes. "No findings" and "not checked" are
 * different answers and the report must never conflate them.
 */
import type { Finding } from '../detect.ts';

export type Availability =
  /** Ran, and these are its findings. */
  | { status: 'checked'; findings: Finding[] }
  /** Could not run. The domain is unexamined -- not clean. */
  | { status: 'unavailable'; reason: string }
  /** Needs a live Claude session; the CLI cannot reach it. */
  | { status: 'needs-session'; reason: string; invoke: string };

export interface Adapter {
  name: string;
  /** What this adapter is responsible for, for the "not checked" line. */
  domain: string;
  run(projectPaths: readonly string[]): Promise<Availability>;
}

/**
 * Group repeats of one detector into a single finding.
 *
 * Scanning 22 projects produced four identical "no .gitignore" entries. The fix is the
 * same for all of them, so they are one item of work, not four findings.
 */
export function groupByDetector(findings: readonly Finding[]): Finding[] {
  const byDetector = new Map<string, Finding[]>();
  for (const f of findings) {
    byDetector.set(f.detector, [...(byDetector.get(f.detector) ?? []), f]);
  }

  return [...byDetector.values()].flatMap((group): Finding[] => {
    if (group.length < 3) return group;
    // Drop `project` rather than set it undefined -- the grouped finding spans several.
    const { project: _project, ...first } = group[0]!;
    return [
      {
        ...first,
        title: `${first.title} (${group.length} projects)`,
        evidence: group.map((f) => f.project ?? f.evidence[0] ?? '(unknown)'),
      },
    ];
  });
}

export interface DelegationReport {
  adapters: Array<{ name: string; domain: string; result: Availability }>;
  findings: Finding[];
  /** Domains nothing examined, so the report can say what it does not know. */
  unchecked: Array<{ domain: string; reason: string; invoke?: string }>;
}

export async function collect(
  adapters: readonly Adapter[],
  projects: readonly string[],
): Promise<DelegationReport> {
  const results = await Promise.all(
    adapters.map(async (a) => ({ name: a.name, domain: a.domain, result: await a.run(projects) })),
  );

  return {
    adapters: results,
    findings: groupByDetector(
      results.flatMap((r) => (r.result.status === 'checked' ? r.result.findings : [])),
    ),
    unchecked: results
      .filter((r) => r.result.status !== 'checked')
      .map((r) => ({
        domain: r.domain,
        reason: (r.result as { reason: string }).reason,
        ...(r.result.status === 'needs-session' ? { invoke: r.result.invoke } : {}),
      })),
  };
}
