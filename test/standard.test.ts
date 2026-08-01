/**
 * The standard, and drift.
 *
 * The claim being tested is that the four onboarding moments are one code path:
 * a brand-new directory, an unconfigured repo, a drifted one, and "what should this
 * project get" differ only in starting state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decisionsRecorded,
  checkProject,
  makeBaseline,
  compareToBaseline,
  findingKey,
  STANDARD,
} from '../src/standard.ts';
import type { AuditContext, Finding } from '../src/detect.ts';
import type { ProjectRecord, SettingsFile, Workspace, ClaudeJson } from '../src/surfaces/types.ts';
import type { PluginCost } from '../src/cost/plugins.ts';

const settings = (path: string, body: Partial<SettingsFile> = {}): SettingsFile => ({
  path,
  rest: {},
  ...body,
});

const project = (path: string, body: Partial<ProjectRecord> = {}): ProjectRecord => ({
  path,
  alive: true,
  registered: true,
  settings: null,
  localSettings: null,
  mcpJson: null,
  entry: null,
  rules: [],
  memory: null,
  claudeMd: null,
  ...body,
});

const claudeJson = (body: Partial<ClaudeJson> = {}): ClaudeJson => ({
  path: '/home/.claude.json',
  mcpServers: {},
  projects: {},
  skillUsage: {},
  pluginUsage: {},
  ...body,
});

const cost = (id: string, tokens: number): PluginCost => ({
  id,
  version: '1',
  source: id,
  alwaysOnTokens: tokens,
  components: [],
  counts: { Hooks: 0 },
  mcpServers: [],
  mcpUncounted: false,
});

function ctx(ws: Partial<Workspace>, pluginCosts = new Map<string, PluginCost | null>()): AuditContext {
  return {
    ws: {
      home: '/home',
      userSettings: null,
      userRules: [],
      claudeJson: claudeJson(),
      projects: [],
      ...ws,
    },
    measurements: [],
    pluginCosts,
    inventories: new Map(),
  };
}

const finding = (detector: string, extra: Partial<Finding> = {}): Finding => ({
  detector,
  severity: 'medium',
  title: 't',
  detail: 'd',
  evidence: [],
  ...extra,
});

describe('decisions-recorded — the brand-new project moment', () => {
  const user = settings('/home/.claude/settings.json', {
    enabledPlugins: { 'a@m': true, 'b@m': true, 'c@m': false },
  });
  const costs = new Map([
    ['a@m', cost('a@m', 300)],
    ['b@m', cost('b@m', 200)],
  ]);

  test('a directory with no settings is unmet, and states what it inherits', () => {
    const p = project('/fresh', { registered: false });
    const r = decisionsRecorded.check(ctx({ userSettings: user, projects: [p] }, costs), p);

    assert.equal(r.status, 'unmet');
    assert.match(r.evidence[0]!, /2 plugins inherited/);
    assert.match(r.evidence[1]!, /~500 tok/);
    assert.match(r.evidence[3]!, /not yet registered/);
  });

  test('a registered project says so instead', () => {
    const p = project('/known');
    const r = decisionsRecorded.check(ctx({ userSettings: user, projects: [p] }, costs), p);
    assert.match(r.evidence[3]!, /registered project/);
  });

  test('any settings file at all satisfies it', () => {
    const p = project('/decided', {
      localSettings: settings('/decided/.claude/settings.local.json', {
        enabledPlugins: { 'a@m': false },
      }),
    });
    const r = decisionsRecorded.check(ctx({ userSettings: user, projects: [p] }, costs), p);
    assert.equal(r.status, 'met');
  });

  test('says so plainly when cost is unavailable rather than implying zero', () => {
    const p = project('/fresh');
    const r = decisionsRecorded.check(ctx({ userSettings: user, projects: [p] }), p);
    assert.match(r.evidence[1]!, /not priced/);
  });
});

describe('the standard stays inside quartermaster\'s domain', () => {
  test('holds no archetype, layout, or git-hygiene expectations', () => {
    // Those belong to project-optimizer, which already has a signal table for them.
    const ids = STANDARD.map((e) => e.id);
    for (const foreign of ['archetype', 'layout', 'readme', 'license', 'topics']) {
      assert.ok(!ids.some((id) => id.includes(foreign)), `${foreign} should be delegated`);
    }
  });

  /** An earlier draft duplicated the restated-entries detector and printed it twice. */
  test('does not restate what a detector already reports', () => {
    const ids = STANDARD.map((e) => e.id);
    assert.ok(!ids.includes('redundant-overrides'));
    assert.ok(!ids.includes('restated-entries'));
  });
});

describe('checkProject', () => {
  test('emits findings only for unmet expectations, tagged with the project', () => {
    const p = project('/fresh');
    const report = checkProject(
      ctx({ userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { x: true } }), projects: [p] }),
      p,
    );
    assert.ok(report.findings.length >= 1);
    for (const f of report.findings) assert.equal(f.project, '/fresh');
    assert.equal(report.results.filter((r) => r.status === 'unmet').length, report.findings.length);
  });
});

describe('drift', () => {
  test('an unchanged set reports no movement', () => {
    const findings = [finding('a', { project: '/p' }), finding('b')];
    const drift = compareToBaseline(findings, makeBaseline(findings, 'then'));
    assert.deepEqual(drift.appeared, []);
    assert.deepEqual(drift.resolved, []);
    assert.equal(drift.unchanged, 2);
  });

  test('a new finding appears and a fixed one resolves', () => {
    const before = makeBaseline([finding('a', { project: '/p' }), finding('gone')], 'then');
    const now = [finding('a', { project: '/p' }), finding('new')];
    const drift = compareToBaseline(now, before);

    assert.deepEqual(drift.appeared.map((f) => f.detector), ['new']);
    assert.deepEqual(drift.resolved, ['gone *']);
    assert.equal(drift.unchanged, 1);
  });

  test('the same detector in different projects is tracked separately', () => {
    const before = makeBaseline([finding('x', { project: '/a' })], 'then');
    const drift = compareToBaseline(
      [finding('x', { project: '/a' }), finding('x', { project: '/b' })],
      before,
    );
    assert.equal(drift.appeared.length, 1);
    assert.equal(drift.appeared[0]!.project, '/b');
  });

  /**
   * Regression: without an explicit key, every workspace-wide finding from one
   * detector collapsed to `detector *`, so swapping one duplicated service for
   * another read as no change.
   */
  test('an explicit key separates workspace-wide findings from one detector', () => {
    const linear = finding('duplicate-access-paths', { key: 'duplicate-access-paths linear' });
    const notion = finding('duplicate-access-paths', { key: 'duplicate-access-paths notion' });

    assert.notEqual(findingKey(linear), findingKey(notion));

    const drift = compareToBaseline([notion], makeBaseline([linear], 'then'));
    assert.equal(drift.appeared.length, 1);
    assert.deepEqual(drift.resolved, ['duplicate-access-paths linear']);
    assert.equal(drift.unchanged, 0);
  });

  test('identity ignores counts in the title, which move for dull reasons', () => {
    const before = makeBaseline([finding('n', { project: '/p', title: '3 things' })], 'then');
    const drift = compareToBaseline([finding('n', { project: '/p', title: '7 things' })], before);
    assert.equal(drift.unchanged, 1);
    assert.deepEqual(drift.appeared, []);
  });

  test('a baseline round-trips through JSON', () => {
    const b = makeBaseline([finding('a', { project: '/p' })], 'then');
    assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  });
});
