/**
 * Delegation to `project-optimizer`.
 *
 * Its `audit` skill is model-driven, but the facts underneath it come from a plain
 * shell script that emits JSON and changes nothing. So quartermaster calls the script
 * rather than the skill: deterministic, ~0.65s per project, no agent session.
 *
 * **The boundary, and the decision it settles.** The script reports facts; the skill
 * applies the Blocking / Gap / Polish judgement. Encoding that judgement here would
 * fork it, and two copies of a severity rubric drift the moment either is edited.
 *
 * So the split is: quartermaster reports only findings that are *definitional* -- a
 * public repo with no license is a licensing problem by definition, a tracked `.env`
 * is a leak by definition. Anything needing taste (is this CLAUDE.md any good, is this
 * layout sensible, are these topics right) stays with the skill and is reported as
 * available-in-session rather than answered here.
 *
 * That is the "orchestrate, don't absorb" answer to the open question, with the line
 * drawn at objectivity rather than convenience.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import type { Finding, Severity } from '../detect.ts';
import type { Adapter, Availability } from './types.ts';

/** Shape emitted by `scripts/scan-project.sh`. Only the fields used are declared. */
export interface ProjectScan {
  project: { path: string; name: string };
  git: {
    isRepo: boolean;
    remote: string | null;
    branch: string | null;
    commits: number;
    hasGitignore: boolean;
  };
  claude: { hasClaudeMd: boolean; claudeMdBytes: number; hasProjectSettings: boolean };
  layout: {
    hasReadme: boolean;
    hasLicense: boolean;
    riskyTracked?: string[];
    largeTracked?: string[];
    strayFiles?: string[];
    rootFileCount: number;
  };
  github: {
    checked: boolean;
    exists: boolean;
    visibility?: string;
    license?: string | null;
    archived?: boolean;
  };
}

const PLUGIN_CACHE = join(homedir(), '.claude', 'plugins', 'cache', 'claude-project-optimizer');

/** Locate the newest installed copy without hard-coding a version. */
export function findScanScript(root = PLUGIN_CACHE): string | null {
  const base = join(root, 'project-optimizer');
  if (!existsSync(base)) return null;
  const versions = readdirSync(base).sort().reverse();
  for (const v of versions) {
    const candidate = join(base, v, 'scripts', 'scan-project.sh');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function scanProject(script: string, projectPath: string): ProjectScan | null {
  try {
    const out = execFileSync('bash', [script, projectPath], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out) as ProjectScan;
  } catch {
    return null;
  }
}

/**
 * Directories that are registered as projects but are not projects.
 *
 * Running `claude` in `~` registers the home directory in `~/.claude.json`, and a
 * layout scan of `~` walks the entire home tree. It never finished: every `--full`
 * run took exactly 60.0s, which was one scan hitting the timeout while the other 21
 * completed in about three seconds between them.
 *
 * This is the same `~`-is-a-project quirk that forces the same-file dedup in the
 * resolver, showing up in a different layer.
 */
export function isScannable(path: string, home = homedir()): boolean {
  return path !== home && path !== '/';
}

export async function scanProjects(
  script: string,
  paths: readonly string[],
  { concurrency = 8, github = true, timeoutMs = 20_000 }: {
    concurrency?: number;
    github?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<ProjectScan[]> {
  const queue = paths.filter((p) => isScannable(p));
  const out: ProjectScan[] = [];
  // GitHub checks were briefly made opt-in on the theory that their two network calls
  // per project were what made `--full` slow. They were not: the cost was one scan of
  // the home directory hitting the timeout. With that excluded, adding GitHub takes the
  // whole run from 4.8s to 5.2s, so it is on by default and `--no-github` is the escape
  // hatch for offline use or a machine without `gh`.
  const args = github ? [] : ['--no-github'];

  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const { stdout } = await execFileAsync('bash', [script, path, ...args], {
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
        });
        out.push(JSON.parse(stdout) as ProjectScan);
      } catch {
        // A project that is unreadable or too slow is skipped, not fatal.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * Findings that follow from the facts alone.
 *
 * Each is true by definition rather than by judgement, which is what makes it safe to
 * state here instead of deferring to the skill.
 */
export function definitionalFindings(scan: ProjectScan): Finding[] {
  const out: Finding[] = [];
  const project = scan.project.path;

  const risky = scan.layout.riskyTracked ?? [];
  if (risky.length) {
    out.push({
      detector: 'tracked-secret',
      severity: 'high',
      title: `${risky.length} file${risky.length === 1 ? '' : 's'} matching a credential pattern ${risky.length === 1 ? 'is' : 'are'} tracked in git`,
      detail:
        'Committed credentials stay in history after deletion. Rotate the secret, then ' +
        'remove the file from tracking.',
      project,
      evidence: risky.slice(0, 8),
      fix: 'git rm --cached <file> && add it to .gitignore, then rotate the credential.',
    });
  }

  if (scan.github.checked && scan.github.exists && scan.github.visibility === 'PUBLIC' && !scan.layout.hasLicense) {
    out.push({
      detector: 'public-without-license',
      severity: 'high',
      title: 'Repository is public with no license file',
      detail:
        'Without a license, default copyright applies and nobody may legally use the ' +
        'code. This is a property of the repo, not a matter of taste.',
      project,
      evidence: [`visibility: ${scan.github.visibility}`, 'LICENSE: absent'],
    });
  }

  if (scan.git.isRepo && !scan.git.hasGitignore) {
    out.push({
      detector: 'no-gitignore',
      severity: 'medium',
      title: 'Git repository has no .gitignore',
      detail: 'Nothing is preventing build output, dependencies, or local settings from being committed.',
      project,
      evidence: ['.gitignore: absent'],
    });
  }

  if (scan.git.isRepo && scan.git.commits > 0 && !scan.layout.hasReadme) {
    out.push({
      detector: 'no-readme',
      severity: 'low',
      title: 'Repository has commits but no README',
      detail: 'Anyone arriving at the repo, including a future session, has no entry point.',
      project,
      evidence: [`${scan.git.commits} commits`, 'README: absent'],
    });
  }

  return out;
}

export function projectOptimizerAdapter(opts: { github?: boolean } = {}): Adapter {
  return {
    name: 'project-optimizer',
    domain: 'git hygiene, GitHub setup, project layout, CLAUDE.md quality',
    async run(projectPaths) {
      const script = findScanScript();
      if (!script) {
        return {
          status: 'unavailable',
          reason: 'project-optimizer is not installed, so git, GitHub, and layout were not examined',
        } satisfies Availability;
      }
      if (!projectPaths.length) {
        return {
          status: 'unavailable',
          reason: 'no projects were selected for scanning',
        } satisfies Availability;
      }

      const scans = await scanProjects(script, projectPaths, { github: opts.github ?? true });
      if (!scans.length) {
        return {
          status: 'unavailable',
          reason: 'project-optimizer scan produced no readable output',
        } satisfies Availability;
      }

      return {
        status: 'checked',
        findings: scans.flatMap(definitionalFindings),
      } satisfies Availability;
    },
  };
}

/**
 * The judgement half, which stays with the skill.
 *
 * Reported as needing a session rather than guessed at, so the report is explicit
 * about the difference between "checked and clean" and "not examined".
 */
export function projectOptimizerJudgementAdapter(): Adapter {
  return {
    name: 'project-optimizer:audit',
    domain: 'onboarding gaps and drift requiring judgement',
    async run() {
      return {
        status: 'needs-session',
        reason:
          'ranking gaps as blocking / gap / polish, and drift against the onboarding ' +
          'registry, is the skill\'s judgement and is deliberately not duplicated here',
        invoke: '/project-optimizer:audit',
      } satisfies Availability;
    },
  };
}

const SEVERITY: Severity[] = ['high', 'medium', 'low', 'info'];
export { SEVERITY };
