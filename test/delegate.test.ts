import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import { collect, groupByDetector, type Adapter } from '../src/delegate/types.ts';
import {
  definitionalFindings,
  isScannable,
  findScanScript,
  scanProjects,
  type ProjectScan,
} from '../src/delegate/projectOptimizer.ts';
import { parseInstallationIssues, doctorAdapter } from '../src/delegate/doctor.ts';
import { rankOf, type Finding, type Rank, type Severity } from '../src/detect.ts';

const scan = (body: Partial<ProjectScan> = {}): ProjectScan => ({
  project: { path: '/p', name: 'p' },
  git: { isRepo: true, remote: null, branch: 'main', commits: 5, hasGitignore: true },
  claude: { hasClaudeMd: true, claudeMdBytes: 100, hasProjectSettings: true },
  layout: { hasReadme: true, hasLicense: true, rootFileCount: 5 },
  github: { checked: false, exists: false },
  ...body,
});

const finding = (detector: string, project?: string): Finding => ({
  detector,
  severity: 'medium',
  title: 't',
  detail: 'd',
  evidence: ['e'],
  ...(project ? { project } : {}),
});

/**
 * The whole point of the availability type: an unchecked domain must be
 * distinguishable from a clean one.
 */
describe('unchecked is not the same as clean', () => {
  const unavailable: Adapter = {
    name: 'x',
    domain: 'git hygiene',
    async run() {
      return { status: 'unavailable', reason: 'not installed' };
    },
  };
  const needsSession: Adapter = {
    name: 'y',
    domain: 'memory bloat',
    async run() {
      return { status: 'needs-session', reason: 'agentic', invoke: '/doctor' };
    },
  };
  const clean: Adapter = {
    name: 'z',
    domain: 'layout',
    async run() {
      return { status: 'checked', findings: [] };
    },
  };

  test('an unavailable adapter surfaces its domain as unchecked', async () => {
    const r = await collect([unavailable], ['/p']);
    assert.deepEqual(r.findings, []);
    assert.equal(r.unchecked.length, 1);
    assert.equal(r.unchecked[0]!.domain, 'git hygiene');
  });

  test('a needs-session adapter names the command to run', async () => {
    const r = await collect([needsSession], ['/p']);
    assert.equal(r.unchecked[0]!.invoke, '/doctor');
  });

  test('an adapter that ran clean is NOT listed as unchecked', async () => {
    const r = await collect([clean], ['/p']);
    assert.deepEqual(r.unchecked, []);
  });

  test('mixed adapters keep findings and unchecked domains separate', async () => {
    const r = await collect([unavailable, needsSession, clean], ['/p']);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.unchecked.map((u) => u.domain), ['git hygiene', 'memory bloat']);
  });
});

describe('groupByDetector', () => {
  test('collapses three or more of one detector', () => {
    const grouped = groupByDetector([
      finding('no-gitignore', '/a'),
      finding('no-gitignore', '/b'),
      finding('no-gitignore', '/c'),
    ]);
    assert.equal(grouped.length, 1);
    assert.match(grouped[0]!.title, /\(3 projects\)/);
    assert.deepEqual(grouped[0]!.evidence, ['/a', '/b', '/c']);
    assert.equal(grouped[0]!.project, undefined);
  });

  test('leaves one or two alone so per-project context survives', () => {
    const grouped = groupByDetector([finding('no-readme', '/a'), finding('no-readme', '/b')]);
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0]!.project, '/a');
  });

  test('does not merge different detectors', () => {
    const grouped = groupByDetector([
      finding('a', '/1'),
      finding('a', '/2'),
      finding('a', '/3'),
      finding('b', '/1'),
    ]);
    assert.equal(grouped.length, 2);
  });
});

describe('definitional findings', () => {
  test('a tracked credential file is high severity', () => {
    const f = definitionalFindings(scan({ layout: { ...scan().layout, riskyTracked: ['.env'] } }));
    assert.equal(f[0]!.detector, 'tracked-secret');
    assert.equal(f[0]!.severity, 'high');
  });

  test('public with no license fires only when GitHub was actually checked', () => {
    const checked = scan({
      layout: { ...scan().layout, hasLicense: false },
      github: { checked: true, exists: true, visibility: 'PUBLIC' },
    });
    assert.ok(definitionalFindings(checked).some((f) => f.detector === 'public-without-license'));

    // Unchecked GitHub must not be read as "not public".
    const unchecked = scan({
      layout: { ...scan().layout, hasLicense: false },
      github: { checked: false, exists: false },
    });
    assert.ok(!definitionalFindings(unchecked).some((f) => f.detector === 'public-without-license'));
  });

  test('a private repo with no license is not a finding', () => {
    const priv = scan({
      layout: { ...scan().layout, hasLicense: false },
      github: { checked: true, exists: true, visibility: 'PRIVATE' },
    });
    assert.ok(!definitionalFindings(priv).some((f) => f.detector === 'public-without-license'));
  });

  test('a missing .gitignore fires only inside a repo', () => {
    const repo = scan({ git: { ...scan().git, hasGitignore: false } });
    assert.ok(definitionalFindings(repo).some((f) => f.detector === 'no-gitignore'));

    const notRepo = scan({ git: { ...scan().git, isRepo: false, hasGitignore: false } });
    assert.deepEqual(definitionalFindings(notRepo), []);
  });

  test('a fresh repo with no commits is not chided for a missing README', () => {
    const fresh = scan({
      git: { ...scan().git, commits: 0 },
      layout: { ...scan().layout, hasReadme: false },
    });
    assert.ok(!definitionalFindings(fresh).some((f) => f.detector === 'no-readme'));
  });

  test('a healthy project produces nothing', () => {
    assert.deepEqual(definitionalFindings(scan()), []);
  });
});

/**
 * Regression: scanning `~` walks the whole home tree and never returns, which made
 * every `--full` run take exactly the timeout.
 */
describe('home directory is not scannable', () => {
  test('excludes the home directory and filesystem root', () => {
    assert.equal(isScannable(homedir()), false);
    assert.equal(isScannable('/'), false);
    assert.equal(isScannable('/Users/someone/code/thing'), true);
  });

  test('scanProjects skips it without hanging', async (t) => {
    const script = findScanScript();
    if (!script) return t.skip('project-optimizer not installed');
    const started = Date.now();
    const scans = await scanProjects(script, [homedir()], { github: false, timeoutMs: 5_000 });
    assert.deepEqual(scans, []);
    assert.ok(Date.now() - started < 2_000, 'should return immediately, not time out');
  });
});

describe('doctor adapter', () => {
  test('a clean installation still reports the checkup as needing a session', async () => {
    const r = await doctorAdapter().run([]);
    // Either the CLI is absent, or it is healthy and the real checkup is in-session.
    assert.ok(r.status !== 'checked' || r.findings.length > 0);
    if (r.status === 'needs-session') assert.equal(r.invoke, '/doctor');
  });

  test('parses issue lines and recognises the healthy message', () => {
    assert.deepEqual(parseInstallationIssues('No installation issues found.'), []);
    assert.deepEqual(parseInstallationIssues('Warning: something\nok line\nError: other'), [
      'Warning: something',
      'Error: other',
    ]);
  });
});

/**
 * The one rubric (QM-55).
 *
 * `Severity` owns how bad a finding is; `Rank` is the three words the audit skill reports
 * it in. These used to be two independent scales in two repos, and the merge found them
 * already disagreeing -- so the value of these tests is that a future edit to either has
 * to move the other deliberately.
 */
describe('severity renders as one rank', () => {
  /** Total, so no severity can be added without deciding how it reports. */
  test('every severity maps, and only info is unranked', () => {
    const all: Severity[] = ['high', 'medium', 'low', 'info'];
    const seen = new Map<Severity, Rank | null>(all.map((s) => [s, rankOf(s)]));
    assert.deepEqual([...seen.values()], ['Blocking', 'Gap', 'Polish', null]);
    // Stated as a property and not just as the list above: an `info` finding describes the
    // run rather than the configuration, so it is not something to act on and not ranked.
    assert.equal(rankOf('info'), null);
    for (const s of all.filter((x) => x !== 'info')) {
      assert.notEqual(rankOf(s), null, `${s} must rank`);
    }
  });

  /**
   * The disagreement the merge exposed, pinned so reversing it stays a decision.
   *
   * The skill's `Gap` bucket used to name "no README" while `definitionalFindings` priced
   * it `low`. `low` won. Asserted on the *detector's own severity* rather than on the
   * mapping alone, because the two together are what a reader sees -- pinning only
   * `rankOf('low')` would leave someone free to reprice the detector and call it a
   * rendering change.
   */
  test('a missing README is Polish, and a missing .gitignore is a Gap', () => {
    const noReadme = definitionalFindings(
      scan({ layout: { ...scan().layout, hasReadme: false } }),
    ).find((f) => f.detector === 'no-readme');
    assert.ok(noReadme, 'no-readme did not fire');
    assert.equal(noReadme.severity, 'low');
    assert.equal(rankOf(noReadme.severity), 'Polish');

    const noGitignore = definitionalFindings(
      scan({ git: { ...scan().git, hasGitignore: false } }),
    ).find((f) => f.detector === 'no-gitignore');
    assert.ok(noGitignore, 'no-gitignore did not fire');
    assert.equal(noGitignore.severity, 'medium');
    assert.equal(rankOf(noGitignore.severity), 'Gap');
  });

  /** The two that are harmful by definition, and must never render below Blocking. */
  test('a tracked secret and an unlicensed public repo are both Blocking', () => {
    const secret = definitionalFindings(
      scan({ layout: { ...scan().layout, riskyTracked: ['.env'] } }),
    ).find((f) => f.detector === 'tracked-secret');
    assert.ok(secret);
    assert.equal(rankOf(secret.severity), 'Blocking');

    const unlicensed = definitionalFindings(
      scan({
        github: { checked: true, exists: true, visibility: 'PUBLIC' } as never,
        layout: { ...scan().layout, hasLicense: false },
      }),
    ).find((f) => f.detector === 'public-without-license');
    assert.ok(unlicensed);
    assert.equal(rankOf(unlicensed.severity), 'Blocking');
  });
});
