/**
 * What a project is expected to have decided.
 *
 * This is the piece that makes onboarding stop being a separate feature. A project is
 * "onboarded" when its audit is clean; drift is findings coming back. So the four
 * moments -- brand-new project, existing repo seen for the first time, re-onboarding
 * after drift, and deciding what a project warrants -- are one code path: check the
 * project against the standard. Only the starting state differs.
 *
 * **Scope is deliberately narrow.** Every expectation here is about extension
 * configuration, which is quartermaster's domain. Archetype classification, layout,
 * git hygiene, and the Blocking/Gap/Polish ranking belong to `project-optimizer`,
 * which already has a signal table for them; duplicating it would fork a rubric.
 * The delegation layer reports those, it does not re-decide them.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { ProjectRecord } from './surfaces/types.ts';
import type { AuditContext, Finding, Severity } from './detect.ts';
import { resolvePlugin, allPluginIds } from './resolve.ts';

export type ExpectationStatus = 'met' | 'unmet' | 'not-applicable';

export interface ExpectationResult {
  id: string;
  status: ExpectationStatus;
  evidence: string[];
  /** Present when unmet. */
  finding?: Omit<Finding, 'project'>;
}

export interface Expectation {
  id: string;
  title: string;
  check(ctx: AuditContext, project: ProjectRecord): ExpectationResult;
}

const na = (id: string, why: string): ExpectationResult => ({
  id,
  status: 'not-applicable',
  evidence: [why],
});

const met = (id: string, evidence: string[]): ExpectationResult => ({ id, status: 'met', evidence });

const unmet = (
  id: string,
  evidence: string[],
  finding: { severity: Severity; title: string; detail: string; fix?: string },
): ExpectationResult => ({
  id,
  status: 'unmet',
  evidence,
  finding: { detector: id, evidence, ...finding },
});

/**
 * The brand-new-project expectation.
 *
 * A project with no settings file has not decided anything -- it silently inherits
 * every global default. That is fine as a deliberate choice and invisible as an
 * accident, so the audit states what is being inherited and what it costs.
 */
export const decisionsRecorded: Expectation = {
  id: 'no-decisions-recorded',
  title: 'The project has made at least one explicit extension decision',
  check(ctx, project) {
    const hasSettings = Boolean(project.settings || project.localSettings);
    const enabled = allPluginIds(ctx.ws).filter((id) => resolvePlugin(ctx.ws, project, id).value);

    if (hasSettings) {
      return met(this.id, [`${enabled.length} plugins active`, 'project settings present']);
    }

    const priced = enabled
      .map((id) => ctx.pluginCosts.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c) && Number.isFinite(c!.alwaysOnTokens));
    const tokens = priced.reduce((n, c) => n + c.alwaysOnTokens, 0);

    return unmet(
      this.id,
      [
        `${enabled.length} plugins inherited from the global default`,
        priced.length
          ? `~${tokens.toLocaleString('en-US')} tok/session across ${priced.length} priced plugins`
          : 'plugin cost not priced in this run',
        'no .claude/settings.json or settings.local.json',
        project.registered ? 'registered project' : 'not yet registered — Claude Code has not run here',
      ],
      {
        severity: 'medium',
        title: 'No extension decisions recorded for this project',
        detail:
          'Everything here is inherited. That is a reasonable default, but it is not a ' +
          'decision anyone made, and it will not track changes to the global default.',
        fix: 'Scope what this project needs in .claude/settings.local.json.',
      },
    );
  },
};

/**
 * Writes land in `settings.local.json`, so it needs to be ignored or every batch edit
 * shows up as git churn. Claude Code adds it to the global excludes file
 * automatically, but a repo can override that.
 */
export const localSettingsIgnored: Expectation = {
  id: 'local-settings-not-ignored',
  title: 'settings.local.json is git-ignored',
  check(_ctx, project) {
    if (!existsSync(join(project.path, '.git'))) {
      return na(this.id, 'not a git repository');
    }
    const rel = '.claude/settings.local.json';
    try {
      // `check-ignore` consults global excludes too, which is where Claude Code writes.
      execFileSync('git', ['-C', project.path, 'check-ignore', '-q', rel], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      return met(this.id, [`${rel} is ignored`]);
    } catch {
      return unmet(
        this.id,
        [`${rel} is not ignored`],
        {
          severity: 'low',
          title: 'settings.local.json is not git-ignored',
          detail:
            'Local scoping edits land in this file. If it is tracked, every change to ' +
            'which extensions load becomes a commit, and machine-local choices leak to ' +
            'everyone working on the repo.',
          fix: 'echo ".claude/settings.local.json" >> .gitignore',
        },
      );
    }
  },
};

/*
 * Deliberately absent: a "restates the inherited value" expectation.
 *
 * The `restatedEntries` detector already reports exactly that. An earlier draft had
 * both, and the audit printed the same three plugins twice under two names -- the
 * duplication this project exists to find, reproduced inside the project. When an
 * expectation and a detector would say the same thing, the detector wins; the standard
 * only covers what nothing else checks.
 */

export const STANDARD: readonly Expectation[] = [decisionsRecorded, localSettingsIgnored];

export interface ProjectReport {
  project: string;
  registered: boolean;
  results: ExpectationResult[];
  findings: Finding[];
}

export function checkProject(ctx: AuditContext, project: ProjectRecord): ProjectReport {
  const results = STANDARD.map((e) => e.check(ctx, project));
  return {
    project: project.path,
    registered: project.registered,
    results,
    findings: results
      .filter((r) => r.status === 'unmet' && r.finding)
      .map((r) => ({ ...r.finding!, project: project.path })),
  };
}

export function checkAll(ctx: AuditContext): ProjectReport[] {
  return ctx.ws.projects.filter((p) => p.alive).map((p) => checkProject(ctx, p));
}

// ---------------------------------------------------------------------------
// Drift

/**
 * A baseline is the set of finding identities at a moment in time. Comparing against
 * it turns "re-onboarding after drift" into a diff rather than a fresh judgement.
 *
 * Identity is `detector + project`, not the full text: titles carry counts that move
 * for uninteresting reasons, and a finding whose count changed is the same finding.
 */
export interface Baseline {
  version: 1;
  savedAt: string;
  findings: string[];
}

export function findingKey(f: Finding): string {
  return f.key ?? `${f.detector} ${f.project ?? '*'}`;
}

export function makeBaseline(findings: readonly Finding[], savedAt: string): Baseline {
  return { version: 1, savedAt, findings: [...new Set(findings.map(findingKey))].sort() };
}

export interface Drift {
  appeared: Finding[];
  resolved: string[];
  unchanged: number;
}

export function compareToBaseline(findings: readonly Finding[], baseline: Baseline): Drift {
  const before = new Set(baseline.findings);
  const now = new Map(findings.map((f) => [findingKey(f), f]));

  return {
    appeared: [...now.entries()].filter(([k]) => !before.has(k)).map(([, f]) => f),
    resolved: [...before].filter((k) => !now.has(k)),
    unchanged: [...now.keys()].filter((k) => before.has(k)).length,
  };
}

export function readBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}
