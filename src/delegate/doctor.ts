/**
 * Delegation to `/doctor`.
 *
 * `/doctor` covers installation, unused extensions, duplicated or bloated memory
 * files, slow hooks, updates, and permissions -- and proposes CLAUDE.md trims against
 * Anthropic's own rubric. All of it is out of scope for quartermaster to reimplement.
 *
 * **It cannot be reached from a CLI, and the earlier plan was wrong to assume it could.**
 * Two things were measured:
 *
 * 1. `claude doctor`, the CLI subcommand, is installation-only -- version, path,
 *    update channel. It does not run the checkup. Its own closing line says to run
 *    `/doctor` in a session for that.
 * 2. `claude -p "/doctor" --max-turns 1` returns nothing. Unlike `/mcp`, which answers
 *    locally in one turn, `/doctor` is agentic. Granting it enough turns to produce
 *    output also grants it enough to apply fixes, and an audit tool must not mutate
 *    config as a side effect of reporting.
 *
 * So this adapter never shells out. It reports the domain as needing a session and
 * names the command, which keeps "not examined" visible instead of letting an
 * unchecked domain read as clean.
 */
import { claudeCli } from '../disclose.ts';

import type { Adapter, Availability } from './types.ts';

/**
 * Installation health only. Cheap, read-only, and not the checkup.
 *
 * This adapter runs on every audit, not only under `--full`, so on a machine without
 * `~/.claude.json` this is usually the spawn that creates it -- hence the funnel
 * rather than a bare `execFileSync` (DEA-140).
 */
export function installationSummary(): string | null {
  try {
    return claudeCli.run(['doctor'], { timeoutMs: 60_000 });
  } catch {
    return null;
  }
}

export function parseInstallationIssues(text: string): string[] {
  if (/No installation issues found/i.test(text)) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(warning|error|issue)/i.test(l));
}

export function doctorAdapter(): Adapter {
  return {
    name: 'doctor',
    domain: 'unused extensions, memory bloat, slow hooks, permissions, CLAUDE.md trims',
    async run(): Promise<Availability> {
      const text = installationSummary();
      if (text === null) {
        return {
          status: 'unavailable',
          reason: 'the claude CLI is not on PATH, so installation health was not examined',
        };
      }

      const issues = parseInstallationIssues(text);
      if (issues.length) {
        return {
          status: 'checked',
          findings: [
            {
              detector: 'installation-health',
              severity: 'medium',
              title: `claude doctor reported ${issues.length} installation issue${issues.length === 1 ? '' : 's'}`,
              detail: 'Reported by the first-party installation check, verbatim.',
              evidence: issues.slice(0, 8),
              fix: 'Run /doctor in a session for the full checkup, which can also fix it.',
            },
          ],
        };
      }

      // Installation is fine, but that is the small half of what /doctor does.
      return {
        status: 'needs-session',
        reason:
          'installation is healthy, but the checkup itself -- unused extensions, memory ' +
          'bloat, slow hooks, permissions -- runs only inside a session and can apply ' +
          'fixes, so it is not invoked from here',
        invoke: '/doctor',
      };
    },
  };
}
