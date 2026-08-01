/**
 * The resolver's correctness gate.
 *
 * Hand-written expectations only prove the resolver agrees with whoever wrote them.
 * `claude plugin list --json` reports `enabled` already resolved for its working
 * directory, which makes it an external oracle: run it in each project, and every
 * (plugin, project) pair either matches our resolution or the resolver is wrong.
 *
 * Runs against the live machine, so it skips when the CLI is unavailable.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { loadWorkspace } from '../src/surfaces/read.ts';
import { resolvePlugin } from '../src/resolve.ts';
import type { Workspace, ProjectRecord } from '../src/surfaces/types.ts';

function claudeAvailable(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

interface FirstPartyPlugin {
  id: string;
  enabled: boolean;
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

describe('resolver matches `claude plugin list --json`', { skip: !available && 'claude CLI unavailable' }, () => {
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
    // any fresh clone, which is worse than not running it.
    if (live.length === 0) return t.skip('no registered projects on this machine');

    const mismatches: string[] = [];
    let compared = 0;
    let skipped = 0;

    for (const project of live) {
      const theirs = firstPartyView(project.path);
      if (!theirs) {
        skipped++;
        continue;
      }

      for (const plugin of theirs) {
        const ours = resolvePlugin(ws, project, plugin.id);
        compared++;
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

    console.log(
      `    compared ${compared} pairs across ${live.length - skipped} projects` +
        (skipped ? ` (${skipped} unreadable)` : ''),
    );
    // Projects existed but nothing could be compared -- the oracle is broken, and a
    // silent pass here would retire the only external check on the resolver.
    assert.ok(compared > 0, `${live.length} projects found but no pairs compared`);
    assert.deepEqual(mismatches, [], `\n  ${mismatches.length} mismatch(es):\n  ${mismatches.join('\n  ')}`);
  });
});
