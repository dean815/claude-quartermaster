/**
 * Every detector needs a case that fires and a case that does not. A detector only
 * ever tested on data that triggers it is indistinguishable from one that always
 * returns a finding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  duplicateAccessPaths,
  restatedEntries,
  orphanedProjectConfig,
  invertedDefaults,
  costWithoutUse,
  unscopedSkills,
  importsDoNotDefer,
  noPathScopedRules,
  bareDenyRules,
  oversizedMemory,
  runAll,
  rank,
  type AuditContext,
  type Finding,
} from '../src/detect.ts';
import { loadWorkspace } from '../src/surfaces/read.ts';
import { measureProject, measureTranscript } from '../src/cost/transcript.ts';
import { readInventories } from '../src/inventory.ts';
import type { ProjectRecord, SettingsFile, Workspace, ClaudeJson } from '../src/surfaces/types.ts';
import type { TranscriptMeasurement, ServerCost } from '../src/cost/transcript.ts';
import type { PluginCost, PluginCostIndex } from '../src/cost/plugins.ts';

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
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
  ...body,
});

function ctx(body: Partial<Workspace> = {}, extra: Partial<AuditContext> = {}): AuditContext {
  return {
    ws: {
      home: '/home',
      userSettings: null,
      userRules: [],
      personalSkills: [],
      claudeJson: claudeJson(),
      projects: [],
      ...body,
    },
    measurements: [],
    pluginCosts: new Map(),
    inventories: new Map(),
    ...extra,
  };
}

const server = (s: Partial<ServerCost> & { server: string }): ServerCost => ({
  kind: 'direct',
  tools: 10,
  chars: 500,
  uuidOverhead: 0,
  ...s,
});

const measurement = (servers: ServerCost[]): TranscriptMeasurement => ({
  path: '/p/s.jsonl',
  project: null,
  sessionId: 's',
  modifiedAt: 0,
  blocks: [{ kind: 'deferred_tools', chars: 0, items: 0 }],
  servers,
  needsAuth: [],
  pending: [],
  skills: null,
  totalChars: 0,
});

/**
 * `claude plugin details` always prints every inventory line, including `Hooks (0)`,
 * so a real parse yields `Hooks: 0` rather than an absent key. That distinction
 * matters: an absent key means "could not tell", which makes the usage counter
 * uninterpretable, while 0 means "provides no hooks" and makes it trustworthy.
 */
const cost = (id: string, tokens: number, counts: Record<string, number> = {}): PluginCost => ({
  id,
  version: '1',
  source: id,
  alwaysOnTokens: tokens,
  components: [],
  counts: { Hooks: 0, ...counts },
  mcpServers: [],
  mcpUncounted: false,
});

/**
 * A cost index that records every id asked about.
 *
 * Real pricing is a `claude plugin details` spawn per miss, so which ids a detector
 * asks about is the behaviour under test, not an implementation detail: the assertion
 * "this never got priced" is the only one that catches a detector paying for an answer
 * it discards.
 */
function recording(costs: Map<string, PluginCost | null>): PluginCostIndex & { asked: string[] } {
  const resolved = new Map<string, PluginCost | null>();
  const asked: string[] = [];
  return {
    asked,
    get(id: string) {
      asked.push(id);
      const c = costs.get(id) ?? null;
      resolved.set(id, c);
      return c;
    },
    entries: () => resolved.entries(),
    get size() {
      return resolved.size;
    },
  };
}

// ---------------------------------------------------------------------------

describe('duplicate-access-paths', () => {
  test('fires when two namespaces serve one service in the same session', () => {
    const f = duplicateAccessPaths(
      ctx({}, {
        measurements: [
          measurement([
            server({ server: 'claude_ai_Linear', kind: 'connector', chars: 1900 }),
            server({ server: 'linear-server', chars: 1200 }),
          ]),
        ],
      }),
    );
    assert.equal(f.length, 1);
    assert.match(f[0]!.title, /linear is reachable 2 ways/);
  });

  test('does not fire for one namespace', () => {
    const f = duplicateAccessPaths(
      ctx({}, { measurements: [measurement([server({ server: 'raindrop' })])] }),
    );
    assert.deepEqual(f, []);
  });

  /** The bug this replaced: two servers in *different* sessions are not duplicates. */
  test('does not fire across separate sessions', () => {
    const f = duplicateAccessPaths(
      ctx({}, {
        measurements: [
          measurement([server({ server: 'claude_ai_Robinhood' })]),
          measurement([server({ server: 'robinhood-trading' })]),
        ],
      }),
    );
    assert.deepEqual(f, []);
  });

  test('severity follows redundant chars, not namespace count', () => {
    const stubs = duplicateAccessPaths(
      ctx({}, {
        measurements: [
          measurement([
            server({ server: 'plugin_a_figma', kind: 'plugin', tools: 2, chars: 90 }),
            server({ server: 'plugin_b_figma', kind: 'plugin', tools: 2, chars: 90 }),
            server({ server: 'plugin_c_figma', kind: 'plugin', tools: 2, chars: 90 }),
          ]),
        ],
      }),
    );
    // Three namespaces, but all unauthenticated stubs -- cheap, so not high.
    assert.equal(stubs[0]!.severity, 'low');
    assert.match(stubs[0]!.detail, /unauthenticated stubs/);

    const real = duplicateAccessPaths(
      ctx({}, {
        measurements: [
          measurement([
            server({ server: 'claude_ai_Linear', chars: 2000 }),
            server({ server: 'linear-server', chars: 1200 }),
          ]),
        ],
      }),
    );
    assert.equal(real[0]!.severity, 'high');
  });
});

describe('cost-without-use', () => {
  const ws = {
    userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'a@m': true } }),
    projects: [project('/p')],
    claudeJson: claudeJson({ pluginUsage: { 'a@m': { usageCount: 0 } } }),
  };

  test('fires for an enabled, hookless, never-invoked plugin', () => {
    const f = costWithoutUse(ctx(ws, { pluginCosts: new Map([['a@m', cost('a@m', 500, { Skills: 2 })]]) }));
    assert.equal(f.length, 1);
    assert.match(f[0]!.title, /1 enabled plugin costs/);
  });

  /** A plugin that is off costs nothing, so it is not a finding. */
  test('does not fire for a disabled plugin', () => {
    const off = {
      ...ws,
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'a@m': false } }),
    };
    const f = costWithoutUse(ctx(off, { pluginCosts: new Map([['a@m', cost('a@m', 500)]]) }));
    assert.deepEqual(f, []);
  });

  /** usageCount counts hook firings, so zero proves nothing for a hook-provider. */
  test('does not fire when the plugin ships hooks', () => {
    const f = costWithoutUse(
      ctx(ws, { pluginCosts: new Map([['a@m', cost('a@m', 500, { Hooks: 2 })]]) }),
    );
    assert.deepEqual(f, []);
  });

  test('does not fire when the plugin has been invoked', () => {
    const used = { ...ws, claudeJson: claudeJson({ pluginUsage: { 'a@m': { usageCount: 7 } } }) };
    const f = costWithoutUse(ctx(used, { pluginCosts: new Map([['a@m', cost('a@m', 500)]]) }));
    assert.deepEqual(f, []);
  });

  /**
   * Enablement is already in memory; a price is a subprocess. Asking for one before
   * checking the free question is how a scoped audit ended up pricing all 42 plugins.
   */
  test('never asks the price of a plugin that is off everywhere', () => {
    const off = {
      ...ws,
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'a@m': false } }),
    };
    const costs = recording(new Map([['a@m', cost('a@m', 500)]]));
    assert.deepEqual(costWithoutUse(ctx(off, { pluginCosts: costs })), []);
    assert.deepEqual(costs.asked, []);
  });

  /**
   * The finding ranks plugins across every live project, so a run scoped to one
   * project drops it. Pricing for it would buy an answer the report never prints.
   */
  test('a scoped run reports nothing and prices nothing', () => {
    const costs = recording(new Map([['a@m', cost('a@m', 500, { Skills: 2 })]]));
    assert.deepEqual(costWithoutUse(ctx(ws, { pluginCosts: costs, scope: '/p' })), []);
    assert.deepEqual(costs.asked, []);
  });

  /** The same set either way -- the reordering only changes what gets paid for. */
  test('an unscoped run still fires, and prices only the enabled plugin', () => {
    const twoPlugins = {
      ...ws,
      userSettings: settings('/home/.claude/settings.json', {
        enabledPlugins: { 'a@m': true, 'b@m': false },
      }),
    };
    const costs = recording(
      new Map([
        ['a@m', cost('a@m', 500, { Skills: 2 })],
        ['b@m', cost('b@m', 900, { Skills: 3 })],
      ]),
    );
    const f = costWithoutUse(ctx(twoPlugins, { pluginCosts: costs }));
    assert.equal(f.length, 1);
    assert.match(f[0]!.title, /1 enabled plugin costs ~500 tok/);
    assert.deepEqual(costs.asked, ['a@m']);
  });
});

describe('restated-entries', () => {
  const user = settings('/home/.claude/settings.json', { enabledPlugins: { a: true } });

  test('fires when a project repeats the inherited value', () => {
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { enabledPlugins: { a: true } }),
    });
    const f = restatedEntries(ctx({ userSettings: user, projects: [p] }));
    assert.equal(f.length, 1);
  });

  test('does not fire for a genuine override', () => {
    const p = project('/p', {
      settings: settings('/p/.claude/settings.json', { enabledPlugins: { a: false } }),
    });
    assert.deepEqual(restatedEntries(ctx({ userSettings: user, projects: [p] })), []);
  });
});

describe('orphaned-project-config', () => {
  test('fires for a dead path carrying a deny-list', () => {
    const dead = project('/gone', { alive: false, entry: { disabledMcpServers: ['x', 'y'] } });
    const f = orphanedProjectConfig(ctx({ projects: [dead] }));
    assert.equal(f.length, 1);
    assert.match(f[0]!.fix!, /claude project purge/);
  });

  test('does not fire for a dead path with no config', () => {
    const dead = project('/gone', { alive: false, entry: { hasTrustDialogAccepted: true } });
    assert.deepEqual(orphanedProjectConfig(ctx({ projects: [dead] })), []);
  });

  test('does not fire for a live path', () => {
    const live = project('/here', { entry: { disabledMcpServers: ['x'] } });
    assert.deepEqual(orphanedProjectConfig(ctx({ projects: [live] })), []);
  });
});

describe('inverted-defaults', () => {
  const user = settings('/home/.claude/settings.json', { enabledPlugins: { a: true } });
  const overriding = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      project(`/p${i}`, {
        settings: settings(`/p${i}/.claude/settings.json`, { enabledPlugins: { a: false } }),
      }),
    );

  test('fires when most of a big enough sample overrides', () => {
    const f = invertedDefaults(ctx({ userSettings: user, projects: overriding(5) }));
    assert.equal(f.length, 1);
    assert.match(f[0]!.title, /overridden in 5 of 5/);
  });

  /** Two out of three is not evidence. */
  test('stays silent below the sample minimum', () => {
    assert.deepEqual(invertedDefaults(ctx({ userSettings: user, projects: overriding(3) })), []);
  });
});

describe('unscoped-skills', () => {
  const withListing = (chars: number) => ({
    measurements: [
      {
        ...measurement([]),
        blocks: [{ kind: 'skill_listing' as const, chars, items: 100 }],
      },
    ],
  });

  test('fires when nothing sets skillOverrides', () => {
    const f = unscopedSkills(ctx({}, withListing(30_000)));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.severity, 'high');
  });

  test('does not fire once any project scopes a skill', () => {
    const p = project('/p', {
      localSettings: settings('/p/.claude/settings.local.json', {
        skillOverrides: { deploy: 'off' },
      }),
    });
    assert.deepEqual(unscopedSkills(ctx({ projects: [p] }, withListing(30_000))), []);
  });

  test('does not fire without a measured listing', () => {
    assert.deepEqual(unscopedSkills(ctx()), []);
  });
});

describe('imports-do-not-defer', () => {
  test('fires on an @path import', () => {
    const p = project('/p', {
      claudeMd: { path: '/p/CLAUDE.md', bytes: 10, lines: 5, imports: ['docs/style.md'] },
    });
    assert.equal(importsDoNotDefer(ctx({ projects: [p] })).length, 1);
  });

  test('does not fire without imports', () => {
    const p = project('/p', { claudeMd: { path: '/p/CLAUDE.md', bytes: 10, lines: 5, imports: [] } });
    assert.deepEqual(importsDoNotDefer(ctx({ projects: [p] })), []);
  });
});

describe('no-path-scoped-rules', () => {
  const big = project('/p', {
    claudeMd: { path: '/p/CLAUDE.md', bytes: 9000, lines: 300, imports: [] },
  });

  test('fires for a long CLAUDE.md with no rules anywhere', () => {
    assert.equal(noPathScopedRules(ctx({ projects: [big] })).length, 1);
  });

  test('does not fire once a rule file exists', () => {
    const withRule = project('/p', {
      ...big,
      rules: [{ path: '/p/.claude/rules/a.md', paths: ['src/**'], bytes: 10, lines: 3 }],
    });
    assert.deepEqual(noPathScopedRules(ctx({ projects: [withRule] })), []);
  });

  test('does not fire for a short CLAUDE.md', () => {
    const small = project('/p', {
      claudeMd: { path: '/p/CLAUDE.md', bytes: 100, lines: 40, imports: [] },
    });
    assert.deepEqual(noPathScopedRules(ctx({ projects: [small] })), []);
  });
});

describe('bare-deny-rules', () => {
  test('fires on an unscoped tool name', () => {
    const user = settings('/home/.claude/settings.json', { permissions: { deny: ['Bash'] } });
    const f = bareDenyRules(ctx({ userSettings: user }));
    assert.equal(f.length, 1);
  });

  test('does not fire on a scoped rule', () => {
    const user = settings('/home/.claude/settings.json', {
      permissions: { deny: ['Bash(rm *)', 'Read(.env)'] },
    });
    assert.deepEqual(bareDenyRules(ctx({ userSettings: user })), []);
  });
});

describe('oversized-memory', () => {
  test('fires past the load limit', () => {
    const p = project('/p', {
      memory: { path: '/m/MEMORY.md', bytes: 30_000, lines: 400, overLineLimit: true, overByteLimit: true },
    });
    assert.equal(oversizedMemory(ctx({ projects: [p] })).length, 1);
  });

  test('does not fire within it', () => {
    const p = project('/p', {
      memory: { path: '/m/MEMORY.md', bytes: 1_000, lines: 40, overLineLimit: false, overByteLimit: false },
    });
    assert.deepEqual(oversizedMemory(ctx({ projects: [p] })), []);
  });
});

describe('ranking', () => {
  test('orders by severity', () => {
    const mk = (severity: any) => ({ detector: 'x', severity, title: '', detail: '', evidence: [] });
    const ordered = rank([mk('low'), mk('high'), mk('info'), mk('medium')]);
    assert.deepEqual(ordered.map((f) => f.severity), ['high', 'medium', 'low', 'info']);
  });

  test('a clean workspace produces no findings', () => {
    assert.deepEqual(runAll(ctx()), []);
  });
});

/**
 * Detectors against whatever real workspace this machine has.
 *
 * An earlier version asserted facts about one specific machine -- that Linear was
 * reachable four ways, that 35 project entries were orphaned. Those passed here and
 * would fail on any fresh clone, which makes the suite untrustworthy to everyone else.
 *
 * Each test now derives its own ground truth from the loaded workspace by a route that
 * does not go through the detector, then checks the detector agrees, and skips when
 * the workspace has nothing of that kind to say. That keeps the real-data coverage
 * without encoding one person's configuration as the expected answer.
 */
describe('detectors agree with the live workspace', () => {
  const ws = loadWorkspace();
  const measurements = ws.projects
    .filter((p) => p.alive)
    .flatMap((p) => measureProject(homedir(), p.path));
  // Real inventories rather than an empty map: this block exists to run the detectors
  // against what is actually on this machine, and an empty map would make
  // `inventory-mismatch` silently uncomparable everywhere -- present in the suite,
  // exercising nothing.
  const live: AuditContext = {
    ws,
    measurements,
    pluginCosts: new Map(),
    inventories: readInventories(homedir()),
  };

  const settingsFiles = [
    ws.userSettings,
    ...ws.projects.flatMap((p) => [p.settings, p.localSettings]),
  ].filter((f): f is NonNullable<typeof f> => Boolean(f));

  test('every service with two live namespaces is reported, and no other', (t) => {
    // Independent derivation: group each session's servers by service and keep the
    // ones with more than one namespace present at the same time.
    const expected = new Set<string>();
    for (const m of measurements) {
      const byService = new Map<string, number>();
      for (const s of m.servers) {
        if (s.kind === 'builtin') continue;
        const svc = s.server
          .replace(/^claude_ai_/, '')
          .replace(/^plugin_[^_]+_/, '')
          .replace(/-(trading|server|mcp)$/, '')
          .toLowerCase();
        byService.set(svc, (byService.get(svc) ?? 0) + 1);
      }
      for (const [svc, n] of byService) if (n > 1) expected.add(svc);
    }
    if (!expected.size) return t.skip('no duplicated services in this workspace');

    const reported = new Set(duplicateAccessPaths(live).map((f) => f.title.split(' is reachable')[0]));
    assert.deepEqual([...reported].sort(), [...expected].sort());
  });

  test('orphan count matches an independent count of dead entries with config', (t) => {
    const dead = ws.projects.filter(
      (p) =>
        !p.alive &&
        Boolean(
          p.entry?.disabledMcpServers?.length ||
            p.entry?.enabledMcpServers?.length ||
            p.entry?.allowedTools?.length,
        ),
    );
    const f = orphanedProjectConfig(live);
    if (!dead.length) return assert.deepEqual(f, [], 'no dead entries, so no finding');

    assert.equal(f.length, 1);
    assert.match(f[0]!.title, new RegExp(`^${dead.length} of `));
  });

  test('unscoped-skills fires exactly when nothing sets skillOverrides', (t) => {
    const anyOverride = settingsFiles.some(
      (f) => f.skillOverrides && Object.keys(f.skillOverrides).length > 0,
    );
    const hasListing = measurements.some((m) =>
      m.blocks.some((b) => b.kind === 'skill_listing'),
    );
    if (!hasListing) return t.skip('no measured skill listing on this machine');

    assert.equal(unscopedSkills(live).length, anyOverride ? 0 : 1);
  });

  test('no-path-scoped-rules fires only with a long CLAUDE.md and no rules anywhere', (t) => {
    const anyRules = ws.userRules.length > 0 || ws.projects.some((p) => p.rules.length > 0);
    const anyLong = ws.projects.some((p) => p.alive && (p.claudeMd?.lines ?? 0) > 200);
    if (!anyLong) return t.skip('no CLAUDE.md over 200 lines on this machine');

    assert.equal(noPathScopedRules(live).length, anyRules ? 0 : 1);
  });

  test('running every detector on real data throws nothing', () => {
    assert.doesNotThrow(() => runAll(live));
  });
});

/**
 * Guards the distinction the `Hooks` key encodes. An absent key means the inventory
 * could not be read, which makes the usage counter uninterpretable; 0 means the plugin
 * genuinely ships no hooks. Conflating them would let a hook-heavy plugin be reported
 * as never used.
 */
describe('missing hook inventory is treated conservatively', () => {
  test('stays silent when the Hooks line could not be parsed', () => {
    const ws = {
      userSettings: settings('/home/.claude/settings.json', { enabledPlugins: { 'a@m': true } }),
      projects: [project('/p')],
      claudeJson: claudeJson({ pluginUsage: { 'a@m': { usageCount: 0 } } }),
    };
    const noHookKey: PluginCost = {
      id: 'a@m',
      version: '1',
      source: 'a@m',
      alwaysOnTokens: 500,
      components: [],
      counts: { Skills: 2 },
      mcpServers: [],
      mcpUncounted: false,
    };
    assert.deepEqual(costWithoutUse(ctx(ws, { pluginCosts: new Map([['a@m', noHookKey]]) })), []);
  });
});

// ---------------------------------------------------------------------------
// duplicate-access-paths: the gate, and the mutations it is measured by (DEA-142)
// ---------------------------------------------------------------------------

const TRANSCRIPTS = join(import.meta.dirname, 'fixtures', 'transcripts');

/**
 * Two recorded sessions, and the configuration that produced them.
 *
 * Measured through `measureTranscript` rather than hand-built `ServerCost`s, because
 * the property under test is *what reached the transcript*. A hand-built measurement
 * would let the test decide that, which is the same defect as reading a value back
 * through the function that wrote it.
 *
 * The config deliberately names more than the sessions do: `claude.ai Robinhood` is in
 * `claudeAiMcpEverConnected` and `robinhood-trading` has a launch spec, so a detector
 * reading config pairs them. `/mcp` hid the connector, it published no tool name, and
 * the session records one namespace. The two names collapse to `robinhood` under
 * `serviceOf`, so nothing but the hiding keeps that finding away.
 */
function scenario() {
  return {
    ws: {
      claudeJson: claudeJson({
        mcpServers: {
          'robinhood-trading': { type: 'http', url: 'https://agent.robinhood.test/mcp/trading' },
          'linear-server': { type: 'http', url: 'https://mcp.linear.test/mcp' },
          n8n: { type: 'http', url: 'https://self-hosted.n8n.test/mcp-server/http' },
        },
        claudeAiMcpEverConnected: ['claude.ai Robinhood'],
      }),
      // The project half of the URL source. `linear` repeats the user server's endpoint
      // exactly; `n8n-mcp` collapses onto `n8n` by name while pointing somewhere else.
      projects: [
        project('/p', {
          mcpJson: {
            path: '/p/.mcp.json',
            mcpServers: {
              linear: { type: 'http', url: 'https://mcp.linear.test/mcp' },
              'n8n-mcp': { type: 'http', url: 'https://cloud.n8n.test/mcp' },
            },
          },
        }),
      ],
    } satisfies Partial<Workspace>,
    measurements: [
      measureTranscript(join(TRANSCRIPTS, 'hidden-connector.jsonl')),
      measureTranscript(join(TRANSCRIPTS, 'duplicate-launch-urls.jsonl')),
    ],
  };
}

type Scenario = ReturnType<typeof scenario>;

const findingsOf = (s: Scenario): Finding[] =>
  duplicateAccessPaths(ctx(s.ws, { measurements: s.measurements }));

/** The namespace lines only — the URL-disagreement line is evidence, not a namespace. */
function namespacesOf(f: Finding): string[] {
  return f.evidence.filter((e) => / — \d+ tools,/.test(e)).map((e) => e.split(' — ')[0]!);
}

const describeFinding = (f: Finding): string =>
  `${f.key} | ${f.basis} | ${[...namespacesOf(f)].sort().join(', ')}`;

/**
 * What that workspace's findings are, written out.
 *
 * A literal, and the whole gate: key, basis, and the namespaces the finding is about.
 * Every mutation below is measured against this rather than against a second run of
 * the detector, which would agree with itself whatever the detector does.
 *
 * `robinhood` is absent, and that absence is the point of the first fixture.
 */
const EXPECTED_FINDINGS = [
  'duplicate-access-paths figma | name | plugin_design_figma, plugin_product-management_figma',
  'duplicate-access-paths linear | url | linear, linear-server',
  'duplicate-access-paths n8n | name | n8n, n8n-mcp',
];

/** Every finding the expectation and the detector disagree about, named. */
function diff(actual: readonly Finding[]): string[] {
  const out: string[] = [];
  const got = new Map(actual.map((f) => [f.key!, describeFinding(f)]));
  const want = new Map(EXPECTED_FINDINGS.map((line) => [line.split(' | ')[0]!, line]));

  for (const [key, line] of want) {
    const seen = got.get(key);
    if (!seen) {
      out.push(`missing finding ${key}`);
      continue;
    }
    if (seen === line) continue;
    const [, wantBasis, wantNs] = line.split(' | ');
    const [, gotBasis, gotNs] = seen.split(' | ');
    out.push(
      wantBasis !== gotBasis
        ? `basis changed for ${key}: ${wantBasis} -> ${gotBasis}`
        : `namespaces changed for ${key}: ${wantNs} -> ${gotNs}`,
    );
  }
  for (const key of got.keys()) if (!want.has(key)) out.push(`extra finding ${key}`);
  return out;
}

describe('duplicate-access-paths reports what loaded, and says how it matched', () => {
  test('the findings are exactly what the sessions support', () => {
    assert.deepEqual(diff(findingsOf(scenario())), []);
  });

  /**
   * The degradation, pinned as a stated property. It has been true by construction
   * since the detector was written -- a hidden namespace publishes nothing, so there is
   * no second path to find -- and nothing asserted it, which makes it an accident.
   */
  test('a connector /mcp hid produces no finding, though config names both paths', () => {
    const s = scenario();
    const found = findingsOf(s).map((f) => f.key);
    assert.equal(found.includes('duplicate-access-paths robinhood'), false);
    // …and the config really does name both, so the silence is about the transcript.
    assert.ok(s.ws.claudeJson.claudeAiMcpEverConnected.includes('claude.ai Robinhood'));
    assert.ok('robinhood-trading' in s.ws.claudeJson.mcpServers);
  });

  test('one service vendored by two plugins produces exactly one finding', () => {
    const figma = findingsOf(scenario()).filter((f) => f.key === 'duplicate-access-paths figma');
    assert.equal(figma.length, 1);
    assert.equal(figma[0]!.basis, 'name');
    assert.match(figma[0]!.detail, /inferred/);
  });

  test('a shared launch URL is reported as exact, and the URL is shown', () => {
    const linear = findingsOf(scenario()).find((f) => f.key === 'duplicate-access-paths linear')!;
    assert.equal(linear.basis, 'url');
    assert.match(linear.detail, /which is exact/);
    assert.match(linear.detail, /https:\/\/mcp\.linear\.test\/mcp/);
  });

  /**
   * Asymmetric on purpose. A URL match proves one access path; a mismatch proves
   * nothing, because one service can sit behind two endpoints. So it annotates and
   * never suppresses.
   */
  test('launch URLs that disagree stay inferred and say they disagree', () => {
    const n8n = findingsOf(scenario()).find((f) => f.key === 'duplicate-access-paths n8n')!;
    assert.equal(n8n.basis, 'name');
    assert.ok(n8n.evidence.some((e) => /launch URLs disagree/.test(e)), n8n.evidence.join(' / '));
  });

  test('the fix borrows the first-party command only where it reaches', () => {
    const f = findingsOf(scenario());
    const linear = f.find((x) => x.key === 'duplicate-access-paths linear')!;
    assert.match(linear.fix!, /^claude mcp remove linear-server/);

    // Nothing in the figma group is a user-scope server, so `claude mcp remove` is not
    // the command to print at it.
    const figma = f.find((x) => x.key === 'duplicate-access-paths figma')!;
    assert.doesNotMatch(figma.fix!, /^claude mcp remove/);
  });
});

interface Mutation {
  name: string;
  /** The finding set a detector carrying this defect would return. */
  run: (s: Scenario) => Finding[];
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    /**
     * The redundancy claim, made falsifiable. First-party's `/mcp` compares connectors
     * against user servers, so a detector that deferred to it entirely would drop every
     * plugin-vs-plugin pair -- six of the eleven findings on the machine DEA-142 was
     * measured on, and the reason the detector was kept.
     */
    name: 'defer to first-party and stop reporting plugin-vs-plugin pairs',
    run: (s) => findingsOf(s).filter((f) => !namespacesOf(f).every((n) => n.startsWith('plugin_'))),
    names: /^missing finding duplicate-access-paths figma$/,
  },
  {
    /**
     * Reading configuration instead of transcripts, expressed as the input such a
     * detector would build: `claudeAiMcpEverConnected` names the connector, `mcpServers`
     * names the user server, and a config-driven pass pairs them without ever asking
     * whether either published a tool name. Mutating the measurement rather than the
     * source is the move `mcp.test.ts` makes with "count servers from disabled plugins
     * too" -- construct the output the broken implementation would produce, and require
     * the gate to reject it.
     */
    name: 'pair the hidden connector from config, as a config-reading detector would',
    run: (s) => {
      const session = s.measurements.find((m) =>
        m.servers.some((x) => x.server === 'robinhood-trading'),
      )!;
      session.servers.push(
        server({ server: 'claude_ai_Robinhood', kind: 'connector', tools: 40, chars: 1600 }),
      );
      return findingsOf(s);
    },
    names: /^extra finding duplicate-access-paths robinhood$/,
  },
  {
    /**
     * Confidence inflation, which is the failure `basis` exists to prevent. A detector
     * that called every match exact would read identically in the report and be wrong
     * about two findings in three here.
     */
    name: 'call every match exact',
    run: (s) => findingsOf(s).map((f) => ({ ...f, basis: 'url' as const })),
    names: /^basis changed for duplicate-access-paths (figma|n8n): name -> url$/,
  },
  {
    /**
     * The other half of the URL source. If `urlIndex` read only `~/.claude.json`, the
     * `linear` pair would have one URL between them and the exact match would quietly
     * become an inferred one -- an under-claim, which no report ever complains about.
     */
    name: 'read only the user-scope half of the URL source',
    run: (s) => {
      s.ws.projects[0]!.mcpJson = null;
      return findingsOf(s);
    },
    names: /^basis changed for duplicate-access-paths linear: url -> name$/,
  },
];

describe('the gate fails when the duplicate detector is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const failures = diff(mutation.run(scenario()));
      assert.ok(
        failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate -- that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      assert.ok(
        failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${failures.join('; ')}`,
      );
      console.log(`    caught "${mutation.name}" (${failures.length}): ${failures[0]}`);
    });
  }

  /** The positive control the four above are measured against. */
  test('and passes when nothing is wrong', () => {
    assert.deepEqual(diff(findingsOf(scenario())), []);
  });
});

describe('bare-deny-rules ignores fully-qualified MCP tools', () => {
  test('does not flag an mcp__server__tool rule', () => {
    // These are already as specific as a rule can be, and there is no scoped form to
    // suggest. Flagging them produced advice to loosen trade-blocking guardrails.
    const user = settings('/home/.claude/settings.json', {
      permissions: {
        deny: ['mcp__robinhood-trading__place_equity_order', 'mcp__x__exercise_option'],
      },
    });
    assert.deepEqual(bareDenyRules(ctx({ userSettings: user })), []);
  });

  test('still flags a bare built-in tool name alongside them', () => {
    const user = settings('/home/.claude/settings.json', {
      permissions: { deny: ['mcp__x__y', 'Bash'] },
    });
    const f = bareDenyRules(ctx({ userSettings: user }));
    assert.equal(f.length, 1);
    assert.equal(f[0]!.evidence.length, 1);
    assert.match(f[0]!.evidence[0]!, /"Bash"/);
  });
});
