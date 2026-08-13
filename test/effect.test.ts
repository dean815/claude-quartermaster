/**
 * The pending-change classifier.
 *
 * The defect this guards against is not a crash, it is a tone: a tool that answers
 * "restart required" to a skill toggle trains the user to ignore it, and every wrong
 * answer in that direction looks like caution rather than a bug. So the gate below is
 * measured by mutants that are *plausibly* wrong -- each one is a rule someone could
 * write believing it safe -- and a mutant the gate accepts is a hole in the gate.
 *
 * The mutants are written here rather than by editing `src/`, and none of them is built
 * from the real classifier. A mutant that delegated to `classify` and patched the result
 * would agree with it wherever it was not patched, which is the DEA-133 defect: the
 * expectation and the code under test moving together.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classify,
  classifyAll,
  buildDeferralIndex,
  candidateChanges,
  deferralOf,
  pluginServerKeys,
  tally,
  worstEffect,
  type ClassifyInput,
  type Classification,
  type Effect,
  type PendingChange,
} from '../src/effect.ts';
import { isBareDenyRule } from '../src/detect.ts';
import { normalizeServerName } from '../src/cost/transcript.ts';
import type { TranscriptMeasurement, ServerCost } from '../src/cost/transcript.ts';
import type { PluginInventory } from '../src/inventory.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const server = (name: string, tools = 3): ServerCost => ({
  server: name,
  kind: name.startsWith('plugin_') ? 'plugin' : 'direct',
  tools,
  chars: name.length * tools,
  uuidOverhead: 0,
});

/** One session that deferred the named namespaces. */
const session = (id: string, namespaces: readonly string[]): TranscriptMeasurement => ({
  path: `/home/.claude/projects/-p/${id}.jsonl`,
  project: '/p',
  sessionId: id,
  modifiedAt: 1,
  blocks: [{ kind: 'deferred_tools', chars: 100, items: namespaces.length }],
  servers: namespaces.map((n) => server(n)),
  needsAuth: [],
  pending: [],
  skills: null,
  totalChars: 100,
});

/**
 * A session that recorded no deferred-tools block at all.
 *
 * Present so `measuredSessions` and `totalSessions` can diverge -- a report that used
 * one where it meant the other would still look right when they were equal.
 */
const unmeasuredSession = (id: string): TranscriptMeasurement => ({
  ...session(id, []),
  blocks: [{ kind: 'skill_listing', chars: 50, items: 3 }],
  servers: [],
});

const inventory = (
  id: string,
  mcpServerNames: string[] | null,
  manifestName: string | null = null,
): PluginInventory => ({
  id,
  installPath: `/plugins/${id}`,
  version: '1.0.0',
  sha: null,
  // `null` is "no manifest could be read", which is what an install path pointing at
  // nothing yields; the key then falls back to the marketplace id.
  manifestName,
  installed: [],
  // `null` is the "no source covers this plugin" case, which is not the same shape as
  // a source that covers it and lists nothing.
  enumerated:
    mcpServerNames === null
      ? []
      : [
          {
            source: 'plugin-catalog-cache.json',
            names: ['some-skill'],
            skillNames: ['some-skill'],
            mcpServerNames,
            sha: null,
            version: '1.0.0',
            fetchedAt: null,
          },
        ],
});

/**
 * The world every case below is classified against.
 *
 * `plugin_data_hex` and `raindrop` were deferred; `plugin_ghost_ghost` never was.
 * `carrier` provides a server that *was* deferred, `ghost` one that was not, `plain`
 * provides none, and `uncatalogued` has no source at all -- the four plugin branches.
 */
function input(): ClassifyInput {
  return {
    index: buildDeferralIndex([
      session('s1', ['plugin_data_hex', 'raindrop']),
      session('s2', ['plugin_data_hex']),
      unmeasuredSession('s3'),
    ]),
    inventories: new Map<string, PluginInventory>([
      ['data@m', inventory('data@m', ['hex'])],
      ['ghost@m', inventory('ghost@m', ['ghost'])],
      ['plain@m', inventory('plain@m', [])],
      ['uncatalogued@m', inventory('uncatalogued@m', null)],
    ]),
  };
}

/**
 * Every case the gate covers, and what it must answer.
 *
 * A literal. Comparing against a second run of `classify` would agree with itself
 * whatever the function does.
 */
const CASES: Array<{ label: string; change: PendingChange; expect: Effect }> = [
  // The restraint half. Every cache-safe kind, one by one, because the acceptance
  // criterion names them one by one.
  { label: 'skill', change: { kind: 'skill', id: 'dataviz' }, expect: 'reload' },
  { label: 'command', change: { kind: 'command', id: 'commit' }, expect: 'reload' },
  { label: 'agent', change: { kind: 'agent', id: 'Explore' }, expect: 'reload' },
  { label: 'hook', change: { kind: 'hook', id: 'SessionStart' }, expect: 'reload' },
  { label: 'lsp', change: { kind: 'lsp', id: 'tsserver' }, expect: 'reload' },
  { label: 'monitor', change: { kind: 'monitor', id: 'watch' }, expect: 'reload' },
  { label: 'theme', change: { kind: 'theme', id: 'dark' }, expect: 'reload' },

  // The deny-rule half -- the only route to `restart` there is.
  {
    label: 'bare deny rule',
    change: { kind: 'deny-rule', rules: ['Bash'], source: '/s.json', sourceValidity: 'accepted' },
    expect: 'restart',
  },
  {
    label: 'wildcard deny rule',
    change: { kind: 'deny-rule', rules: ['*'], source: '/s.json', sourceValidity: 'accepted' },
    expect: 'restart',
  },
  {
    label: 'scoped deny rule',
    change: { kind: 'deny-rule', rules: ['Bash(rm *)'], source: '/s.json', sourceValidity: 'accepted' },
    expect: 'reload',
  },
  {
    /** Already maximally specific. Telling the user to scope it is the DEA bug. */
    label: 'fully-qualified mcp deny rule',
    change: {
      kind: 'deny-rule',
      rules: ['mcp__robinhood-trading__place_equity_order'],
      source: '/s.json',
      sourceValidity: 'accepted',
    },
    expect: 'reload',
  },
  {
    label: 'mixed deny rules, one bare',
    change: {
      kind: 'deny-rule',
      rules: ['Bash(rm *)', 'WebFetch'],
      source: '/s.json',
      sourceValidity: 'accepted',
    },
    expect: 'restart',
  },

  /**
   * The DEA-147 half: the same bare rule, in a file Claude Code drops.
   *
   * Three cases and not one, because the interesting claim is the *boundary*. A rule
   * whose file is discarded is not in force, so changing it moves nothing -- but the
   * other two validities must keep answering `restart`, and a check written as "is the
   * validity anything other than accepted" passes the first row and fails these two.
   * `not-checked` is the one that matters most: it is what every file reads without
   * `--full`, so a classifier that rounded it to `none` would silence the tool's only
   * restart warning on every default run.
   */
  {
    label: 'bare deny rule in a discarded file',
    change: { kind: 'deny-rule', rules: ['Bash'], source: '/void.json', sourceValidity: 'discarded' },
    expect: 'none',
  },
  {
    label: 'bare deny rule in a field-dropped file',
    change: { kind: 'deny-rule', rules: ['Bash'], source: '/part.json', sourceValidity: 'field-dropped' },
    expect: 'restart',
  },
  {
    label: 'bare deny rule in an unchecked file',
    change: { kind: 'deny-rule', rules: ['Bash'], source: '/dunno.json', sourceValidity: 'not-checked' },
    expect: 'restart',
  },

  // The MCP half. `restart` appears in neither row, and that is the finding.
  {
    label: 'server observed deferred',
    change: { kind: 'mcp-server', name: 'plugin:data:hex' },
    expect: 'reload',
  },
  {
    label: 'server never observed',
    change: { kind: 'mcp-server', name: 'claude.ai Linear' },
    expect: 'unknown',
  },

  // The four plugin branches.
  { label: 'plugin whose server was deferred', change: { kind: 'plugin', id: 'data@m' }, expect: 'reload' },
  { label: 'plugin whose server was not', change: { kind: 'plugin', id: 'ghost@m' }, expect: 'unknown' },
  { label: 'plugin declaring no server', change: { kind: 'plugin', id: 'plain@m' }, expect: 'reload' },
  { label: 'plugin no source covers', change: { kind: 'plugin', id: 'uncatalogued@m' }, expect: 'unknown' },

  /**
   * The seam DEA-112 was promised, in the same three rows the deny-rule half has.
   *
   * The boundary is the claim: only `discarded` may answer `none`. `plain@m` is the row
   * that makes the first case say something -- it would be `reload` on its own merits, so
   * `none` can only have come from the target's validity -- and the two rows below it are
   * what a guard written as "the validity is not accepted" would get wrong. `not-checked`
   * matters most: it is what every file reads until something asks `doctor`, so rounding
   * it to `none` would make `qm set` refuse every write on a machine without the CLI.
   *
   * The fourth row is the state that has no file at all. `candidateChanges` classifies
   * the toggles the grid *could* stage, and a hypothetical names no path -- which is not
   * `not-checked` and must not read as `discarded` either.
   */
  {
    label: 'plugin written into a discarded file',
    change: {
      kind: 'plugin',
      id: 'plain@m',
      target: { source: '/void.json', sourceValidity: 'discarded' },
    },
    expect: 'none',
  },
  {
    label: 'plugin written into a field-dropped file',
    change: {
      kind: 'plugin',
      id: 'plain@m',
      target: { source: '/part.json', sourceValidity: 'field-dropped' },
    },
    expect: 'reload',
  },
  {
    label: 'plugin written into an unchecked file',
    change: {
      kind: 'plugin',
      id: 'plain@m',
      target: { source: '/dunno.json', sourceValidity: 'not-checked' },
    },
    expect: 'reload',
  },
  { label: 'plugin naming no target at all', change: { kind: 'plugin', id: 'plain@m' }, expect: 'reload' },

  /**
   * The same three rows on the skill axis (QM-45).
   *
   * `skill` is the second kind `qm set` writes, and it is the one where the validity
   * check has to run *before* `CACHE_SAFE_KINDS` rather than after: a skill toggle is
   * cache-safe and, in a discarded file, decides nothing. Those are not the same answer,
   * and a branch order that reached the cache-safe run first would give `reload` to a
   * change that never happens -- which is `qm set`'s refusal and this classifier saying
   * opposite things about one file. The `reload` rows below are what stops the fix from
   * being "call every skill toggle `none`".
   */
  {
    label: 'skill written into a discarded file',
    change: {
      kind: 'skill',
      id: 'dataviz',
      target: { source: '/void.json', sourceValidity: 'discarded' },
    },
    expect: 'none',
  },
  {
    label: 'skill written into a field-dropped file',
    change: {
      kind: 'skill',
      id: 'dataviz',
      target: { source: '/part.json', sourceValidity: 'field-dropped' },
    },
    expect: 'reload',
  },
  {
    label: 'skill written into an unchecked file',
    change: {
      kind: 'skill',
      id: 'dataviz',
      target: { source: '/dunno.json', sourceValidity: 'not-checked' },
    },
    expect: 'reload',
  },
];

type Classifier = (change: PendingChange, input: ClassifyInput) => Classification;

/** Every case the classifier and the expectation disagree about, named. */
function diff(classifier: Classifier): string[] {
  const out: string[] = [];
  const i = input();
  for (const c of CASES) {
    const got = classifier(c.change, i).effect;
    if (got !== c.expect) out.push(`${c.label}: expected ${c.expect}, got ${got}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('classification', () => {
  test('answers every case the way the issue says it must', () => {
    assert.deepEqual(diff(classify), []);
  });

  /**
   * The headline, asserted as an absence so it cannot pass by accident. If a later
   * change adds a predicate that guesses non-deferral, this is what goes red.
   */
  test('and nothing but a bare deny rule ever reaches restart', () => {
    const i = input();
    for (const c of CASES) {
      if (c.change.kind === 'deny-rule') continue;
      assert.notEqual(
        classify(c.change, i).effect,
        'restart',
        `${c.label} classified as restart; only a bare deny rule may`,
      );
    }
  });

  test('carries the sample count behind every observed answer', () => {
    const i = input();
    const observed = classify({ kind: 'mcp-server', name: 'plugin:data:hex' }, i);
    assert.equal(observed.effect, 'reload');
    assert.equal(observed.sessions, 2, 'two sessions deferred plugin_data_hex');

    // The third session recorded no deferred-tools block, so it is not a denominator.
    assert.equal(i.index.measuredSessions, 2);
    assert.equal(i.index.totalSessions, 3);
    assert.match(observed.evidence[0]!, /2 of 2 measured sessions/);
  });

  test('and reports zero samples where the answer rests on no observation', () => {
    const i = input();
    assert.equal(classify({ kind: 'skill', id: 'dataviz' }, i).sessions, 0);
    assert.equal(
      classify({ kind: 'mcp-server', name: 'claude.ai Linear' }, i).sessions,
      0,
    );
  });
});

/**
 * Flipping one observation must flip the classification -- the mutation the issue names.
 *
 * Both directions, because a classifier hard-wired to `unknown` passes the first half
 * and a classifier hard-wired to `reload` passes the second.
 */
describe('the classification follows the observation', () => {
  const change: PendingChange = { kind: 'mcp-server', name: 'plugin:data:hex' };

  test('observed deferred -> reload; drop the observation -> unknown', () => {
    const observed: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['plugin_data_hex'])]),
      inventories: new Map(),
    };
    const withoutIt: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['raindrop'])]),
      inventories: new Map(),
    };
    assert.equal(classify(change, observed).effect, 'reload');
    assert.equal(classify(change, withoutIt).effect, 'unknown');
  });

  test('and a plugin follows its server', () => {
    const inventories = new Map([['data@m', inventory('data@m', ['hex'])]]);
    const observed: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['plugin_data_hex'])]),
      inventories,
    };
    const withoutIt: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['raindrop'])]),
      inventories,
    };
    assert.equal(classify({ kind: 'plugin', id: 'data@m' }, observed).effect, 'reload');
    assert.equal(classify({ kind: 'plugin', id: 'data@m' }, withoutIt).effect, 'unknown');
  });
});

/**
 * The config-key-to-namespace join, pinned against Claude Code's own spelling.
 *
 * Literals taken from tool names observed on disk, not from a second call to
 * `normalizeServerName` -- reading the expectation back through the function that
 * produces it agrees with itself whatever the function does. Hyphens are in here
 * deliberately: `plugin_pdf-viewer_pdf` keeps its, and a normaliser that mapped `-` to
 * `_` the way the punctuation before it is mapped would break the join silently.
 */
describe('the forward join is exact', () => {
  const OBSERVED: Array<[string, string]> = [
    ['plugin:data:hex', 'plugin_data_hex'],
    ['plugin:pdf-viewer:pdf', 'plugin_pdf-viewer_pdf'],
    ['plugin:adobe-for-creativity:Adobe for creativity', 'plugin_adobe-for-creativity_Adobe_for_creativity'],
    ['claude.ai raindrop.io', 'claude_ai_raindrop_io'],
    ['claude.ai Uber Eats', 'claude_ai_Uber_Eats'],
    ['gemini-api-docs-mcp', 'gemini-api-docs-mcp'],
    ['computer-use', 'computer-use'],
  ];

  for (const [key, namespace] of OBSERVED) {
    test(`${key} -> ${namespace}`, () => {
      assert.equal(normalizeServerName(key), namespace);
      const i: ClassifyInput = {
        index: buildDeferralIndex([session('s1', [namespace])]),
        inventories: new Map(),
      };
      assert.equal(
        deferralOf(i.index, key).evidence,
        'observed-deferred',
        `${key} did not join to the namespace its own tools use`,
      );
    });
  }
});

describe('plugin component sources', () => {
  test('no source covering a plugin is not the same as a source listing nothing', () => {
    assert.equal(pluginServerKeys(inventory('x@m', null)), null);
    assert.deepEqual(pluginServerKeys(inventory('x@m', [])), []);
    assert.deepEqual(pluginServerKeys(inventory('x@m', ['srv'])), ['plugin:x:srv']);
  });

  test('and an id absent from the inventory reads as uncovered', () => {
    assert.equal(pluginServerKeys(undefined), null);
  });

  /**
   * The key the classifier joins on is the plugin's manifest name (DEA-145), and this
   * is the case that decides a verdict rather than a label.
   *
   * `plugin:Notion:notion` is a literal -- Claude Code's spelling, counted 389 times in
   * the `needsAuthMcpServers` arrays of the transcripts this was measured against, where
   * `plugin:notion:notion` appears zero times. Keyed the old way, the busiest MCP server
   * on that machine joined to a namespace no session ever published and classified
   * `unknown`; keyed this way it is `observed-deferred`, so a plugin toggle is `reload`.
   */
  test('and the key carries the manifest name where one was read', () => {
    const notion = inventory('notion@claude-plugins-official', ['notion'], 'Notion');
    assert.deepEqual(pluginServerKeys(notion), ['plugin:Notion:notion']);

    const i: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['plugin_Notion_notion'])]),
      inventories: new Map([[notion.id, notion]]),
    };
    const c = classify({ kind: 'plugin', id: notion.id }, i);
    assert.equal(c.effect, 'reload');
    assert.deepEqual(c.evidence, [
      'plugin:Notion:notion -> plugin_Notion_notion: tools deferred in 1 of 1 measured sessions',
    ]);

    // The same plugin keyed from its marketplace id -- the state before DEA-145, and
    // what an unreadable manifest still produces. It must not silently keep the verdict.
    const guessed = inventory('notion@claude-plugins-official', ['notion']);
    assert.deepEqual(pluginServerKeys(guessed), ['plugin:notion:notion']);
    assert.equal(
      classify({ kind: 'plugin', id: guessed.id }, { ...i, inventories: new Map([[guessed.id, guessed]]) })
        .effect,
      'unknown',
    );
  });
});

describe('combining sub-answers', () => {
  test('unknown outranks reload, restart outranks both', () => {
    assert.equal(worstEffect([]), 'reload');
    assert.equal(worstEffect(['reload', 'reload']), 'reload');
    assert.equal(worstEffect(['reload', 'unknown']), 'unknown');
    assert.equal(worstEffect(['unknown', 'restart']), 'restart');
  });

  /**
   * `none` is below `reload`, and the seed is the first element rather than `reload` --
   * otherwise a list of nothing-but-`none` would round up to `reload` and claim a
   * discarded file's change takes effect on the next reload.
   */
  test('and none is the floor, not a value the seed swallows', () => {
    assert.equal(worstEffect(['none']), 'none');
    assert.equal(worstEffect(['none', 'none']), 'none');
    assert.equal(worstEffect(['none', 'reload']), 'reload');
    assert.equal(worstEffect(['none', 'restart']), 'restart');
  });
});

describe('the report', () => {
  test('tallies by kind and effect', () => {
    const changes = candidateChanges({
      skills: ['a', 'b'],
      plugins: ['data@m', 'ghost@m'],
      mcpServers: ['plugin:data:hex', 'claude.ai Linear'],
      denyRules: [
        { rules: ['Bash'], source: '/s.json', sourceValidity: 'accepted' },
        { rules: ['Bash'], source: '/void.json', sourceValidity: 'discarded' },
      ],
    });
    const report = classifyAll(changes, input());

    assert.deepEqual(tally(report), [
      { kind: 'skill', none: 0, reload: 2, restart: 0, unknown: 0 },
      { kind: 'plugin', none: 0, reload: 1, restart: 0, unknown: 1 },
      { kind: 'mcp-server', none: 0, reload: 1, restart: 0, unknown: 1 },
      { kind: 'deny-rule', none: 1, reload: 0, restart: 1, unknown: 0 },
    ]);
    assert.equal(report.measuredSessions, 2);
    assert.equal(report.totalSessions, 3);
  });
});

// ---------------------------------------------------------------------------
// The mutations the gate is measured by
// ---------------------------------------------------------------------------

const stub = (change: PendingChange, effect: Effect): Classification => ({
  change,
  effect,
  reason: 'mutant',
  sessions: 0,
  evidence: [],
});

/**
 * Independent reimplementations, each embodying one wrong rule.
 *
 * Deliberately not written as `(c, i) => { const r = classify(c, i); ... }`. A mutant
 * built on the real classifier inherits every branch it does not touch, so the gate
 * would be measuring the patch rather than the rule.
 */
interface Mutation {
  name: string;
  classifier: Classifier;
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    /**
     * The behaviour the whole issue exists to prevent: anything a plugin can carry is
     * treated as cache-affecting, so every component toggle shouts "restart".
     */
    name: 'a component toggle needs a restart',
    classifier: (c) => stub(c, c.kind === 'deny-rule' ? 'restart' : 'restart'),
    names: /^(skill|command|agent|hook|lsp|monitor|theme): expected reload, got restart$/,
  },
  {
    /** Narrower, and the one most likely to be written by hand: skills only. */
    name: 'a skill toggle alone needs a restart',
    classifier: (c, i) => (c.kind === 'skill' ? stub(c, 'restart') : classify(c, i)),
    names: /^skill: expected reload, got restart$/,
  },
  {
    /**
     * The failure the issue names in full: `unknown` collapsed into the scarier answer.
     * It satisfies the issue's letter -- three states, a restart verdict for
     * non-deferred servers -- and reproduces exactly the cry-wolf behaviour.
     */
    name: 'an unmeasured server needs a restart',
    classifier: (c, i) => {
      const real = classify(c, i);
      return real.effect === 'unknown' ? stub(c, 'restart') : real;
    },
    names: /^(server never observed|plugin whose server was not|plugin no source covers): expected unknown, got restart$/,
  },
  {
    /**
     * The same collapse reached from the other side: default to restart and let an
     * observation talk you down. Identical output to the row above on this fixture, and
     * here because it is the shape someone writes when they think of `unknown` as a
     * fallback rather than an answer.
     */
    name: 'restart unless proven otherwise',
    classifier: (c, i) => {
      if (c.kind !== 'mcp-server' && c.kind !== 'plugin') return classify(c, i);
      return classify(c, i).effect === 'reload' ? stub(c, 'reload') : stub(c, 'restart');
    },
    names: /expected unknown, got restart$/,
  },
  {
    /**
     * A plugin no source covers, rounded down to "provides no MCP server". The `null`
     * and `[]` distinction `pluginServerKeys` draws, deleted.
     */
    name: 'an uncatalogued plugin provides no server',
    classifier: (c, i) =>
      c.kind === 'plugin' && !i.inventories.get(c.id)?.enumerated.length
        ? stub(c, 'reload')
        : classify(c, i),
    names: /^plugin no source covers: expected unknown, got reload$/,
  },
  {
    /** The deny predicate, unscoped: a scoped rule read as bare. */
    name: 'every deny rule counts as bare',
    classifier: (c, i) =>
      c.kind === 'deny-rule' ? stub(c, c.rules.length ? 'restart' : 'reload') : classify(c, i),
    names: /^(scoped deny rule|fully-qualified mcp deny rule): expected reload, got restart$/,
  },
  {
    /** The other direction: the restart half deleted, so nothing ever warns. */
    name: 'no deny rule counts as bare',
    classifier: (c, i) => (c.kind === 'deny-rule' ? stub(c, 'reload') : classify(c, i)),
    names: /^(bare deny rule|wildcard deny rule|mixed deny rules, one bare): expected restart, got reload$/,
  },
  {
    /**
     * The `mcp__` exception dropped -- the regression that told the user to "scope" the
     * rules stopping Claude from placing trades.
     */
    name: 'a fully-qualified mcp rule counts as bare',
    classifier: (c, i) => {
      if (c.kind !== 'deny-rule') return classify(c, i);
      const bare = c.rules.filter((r) => !r.includes('(') && r.trim() !== '');
      return stub(c, bare.length ? 'restart' : 'reload');
    },
    names: /^fully-qualified mcp deny rule: expected reload, got restart$/,
  },
  {
    /** A mixed rule set answered by its first entry rather than its worst. */
    name: 'a mixed rule set is answered by its first rule',
    classifier: (c, i) => {
      if (c.kind !== 'deny-rule') return classify(c, i);
      return stub(c, c.rules[0] && isBareDenyRule(c.rules[0]) ? 'restart' : 'reload');
    },
    names: /^mixed deny rules, one bare: expected restart, got reload$/,
  },
  {
    /**
     * DEA-147's own regression: validity read but not consulted, so a rule in a file
     * Claude Code drops still shouts "restart". This is the state before the branch
     * existed, and it is the direction that costs the user a restart for nothing.
     */
    name: 'a discarded file\'s deny rules still need a restart',
    classifier: (c, i) => {
      if (c.kind !== 'deny-rule') return classify(c, i);
      return stub(c, c.rules.some(isBareDenyRule) ? 'restart' : 'reload');
    },
    names: /^bare deny rule in a discarded file: expected none, got restart$/,
  },
  {
    /**
     * The far more dangerous direction, and the one the whole issue is about: anything
     * short of `accepted` is treated as void. It reads as caution and it silences the
     * restart warning on every run without `--full`, where nothing is checked at all.
     */
    name: 'any file not confirmed valid is treated as discarded',
    classifier: (c, i) => {
      if (c.kind !== 'deny-rule') return classify(c, i);
      if (c.sourceValidity !== 'accepted') return stub(c, 'none');
      return stub(c, c.rules.some(isBareDenyRule) ? 'restart' : 'reload');
    },
    names: /^bare deny rule in (a field-dropped|an unchecked) file: expected restart, got none$/,
  },
  {
    /**
     * The plugin half of the same pair (DEA-112): the target's validity read and not
     * consulted, so a write into a file Claude Code refuses reports what it would have
     * cost had it landed. `qm set` refuses precisely when this branch says `none`, so
     * deleting it does not merely mislabel a row -- it lets the write through.
     */
    name: "a discarded target still costs what the plugin costs",
    classifier: (c, i) =>
      c.kind === 'plugin' ? classify({ kind: 'plugin', id: c.id }, i) : classify(c, i),
    names: /^plugin written into a discarded file: expected none, got reload$/,
  },
  {
    /** And the dangerous direction, as above: anything short of `accepted` reads as void. */
    name: 'any plugin target not confirmed valid is treated as discarded',
    classifier: (c, i) => {
      if (c.kind !== 'plugin') return classify(c, i);
      if (c.target && c.target.sourceValidity !== 'accepted') return stub(c, 'none');
      return classify(c, i);
    },
    names: /^plugin written into (a field-dropped|an unchecked) file: expected reload, got none$/,
  },
  {
    /**
     * The join broken the way it was actually broken before DEA-123: `.` left alone, so
     * `claude.ai Linear` never matches `claude_ai_Linear`. It does not show on this
     * fixture's expectations -- `claude.ai Linear` is expected `unknown` either way --
     * which is why the forward-join suite pins the mapping as a literal instead.
     */
    name: 'the forward join ignores dots',
    classifier: (c, i) => {
      if (c.kind !== 'mcp-server') return classify(c, i);
      const ns = c.name.replaceAll(':', '_').replaceAll(' ', '_');
      return stub(c, i.index.byNamespace.has(ns) ? 'reload' : 'unknown');
    },
    // Pinned by the forward-join suite, not by this gate. Asserted below.
    names: /never fires/,
  },
];

describe('the gate fails when the classifier is wrong', () => {
  for (const mutation of MUTATIONS) {
    if (mutation.names.source === 'never fires') continue;
    test(mutation.name, () => {
      const failures = diff(mutation.classifier);
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

  /**
   * The one mutation this gate cannot catch, recorded rather than deleted.
   *
   * A dot-blind join gives the same answer on every case above, because no case pairs a
   * dotted config key with an observation of it. Saying so here, and pinning the mapping
   * in the forward-join suite, is the honest alternative to a mutation list that looks
   * complete because the case it misses was quietly dropped.
   */
  test('the dot-blind join is invisible to this gate, and caught by the join suite', () => {
    const dotBlind = MUTATIONS.find((m) => m.name === 'the forward join ignores dots')!;
    assert.deepEqual(
      diff(dotBlind.classifier),
      [],
      'this gate now distinguishes the dot-blind join -- move it into MUTATIONS',
    );

    const i: ClassifyInput = {
      index: buildDeferralIndex([session('s1', ['claude_ai_raindrop_io'])]),
      inventories: new Map(),
    };
    const change: PendingChange = { kind: 'mcp-server', name: 'claude.ai raindrop.io' };
    assert.equal(classify(change, i).effect, 'reload');
    assert.equal(dotBlind.classifier(change, i).effect, 'unknown');
  });

  /** The positive control every mutation above is measured against. */
  test('and passes when it is not', () => {
    assert.deepEqual(diff(classify), []);
  });
});
