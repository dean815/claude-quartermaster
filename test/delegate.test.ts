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
import type { Finding } from '../src/detect.ts';

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
