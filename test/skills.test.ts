/**
 * The skill axis.
 *
 * The bug these guard against is quiet: `allSkillIds` derived the set from
 * `skillOverrides`, so it could only name a skill someone had already scoped, and on a
 * workspace that has scoped nothing it returned an empty array and an empty grid. Every
 * case below therefore sets no override at all -- if one of them starts passing because
 * a fixture gained a `skillOverrides` key, it has stopped testing the defect.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSkillCatalog,
  allSkillIds,
  countByPresence,
  skillPresenceIn,
  type SkillCatalog,
} from '../src/skills.ts';
import { resolveSkill } from '../src/resolve.ts';
import { loadWorkspace, readPersonalSkills } from '../src/surfaces/read.ts';
import { measureProject } from '../src/cost/transcript.ts';
import { readInventories } from '../src/inventory.ts';
import type { PluginInventory, PluginKeyBasis } from '../src/inventory.ts';
import type { TranscriptMeasurement } from '../src/cost/transcript.ts';
import type {
  ClaudeJson,
  PersonalSkill,
  SettingsFile,
  Workspace,
} from '../src/surfaces/types.ts';
import { project } from './factories.ts';

const settings = (path: string, body: Partial<SettingsFile> = {}): SettingsFile => ({
  path,
  // Nothing here is about validity, and `not-checked` is what resolves the way this
  // file resolved before DEA-147 existed. Never `accepted` -- these files were not checked.
  validity: 'not-checked',
  rest: {},
  ...body,
});

const claudeJson = (): ClaudeJson => ({
  path: '/home/.claude.json',
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
});

function workspace(body: Partial<Workspace> = {}): Workspace {
  return {
    home: '/home',
    userSettings: null,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(),
    projects: [],
    ...body,
  };
}

/** A measured session. `skills: null` is the listing that recorded only a count. */
function session(
  projectPath: string | null,
  skills: string[] | null,
  modifiedAt = 0,
  hadListing = true,
): TranscriptMeasurement {
  return {
    path: `/t/${modifiedAt}.jsonl`,
    project: projectPath,
    sessionId: String(modifiedAt),
    modifiedAt,
    blocks: hadListing ? [{ kind: 'skill_listing', chars: 100, items: skills?.length ?? 0 }] : [],
    servers: [],
    needsAuth: [],
    pending: [],
    skills,
    totalChars: 100,
  };
}

const personal = (id: string): PersonalSkill => ({ id, path: `/home/.claude/skills/${id}/SKILL.md` });

/**
 * `manifestName` defaults to `null` -- "no manifest could be read" -- because that is
 * what an install path pointing at nothing yields, and it keeps every pre-DEA-146 case
 * below asserting the id it always did. Pass a name to get the other branch.
 */
function inventory(
  id: string,
  skillNames: string[],
  otherNames: string[] = [],
  manifestName: string | null = null,
): PluginInventory {
  return {
    id,
    installPath: `/plugins/${id}`,
    version: '1',
    sha: null,
    manifestName,
    installed: [...skillNames, ...otherNames],
    enumerated: [
      {
        source: 'plugin-catalog-cache.json',
        names: [...skillNames, ...otherNames],
        skillNames,
        mcpServerNames: [],
        sha: null,
        version: '1',
        fetchedAt: null,
      },
    ],
  };
}

describe('the observed listing is the enumeration', () => {
  test('a skill no settings file mentions is still a row', () => {
    const p = project('/p');
    const cat = buildSkillCatalog(
      workspace({ projects: [p] }),
      [session('/p', ['deploy', 'triage'])],
      new Map(),
    );
    assert.deepEqual(allSkillIds(cat), ['deploy', 'triage']);
  });

  test('an unconfigured skill resolves to on, inherited', () => {
    const ws = workspace({ projects: [project('/p')] });
    const cat = buildSkillCatalog(ws, [session('/p', ['deploy'])], new Map());

    for (const id of allSkillIds(cat)) {
      const cell = resolveSkill(ws, ws.projects[0]!, id);
      assert.equal(cell.value, 'on');
      assert.equal(cell.origin, 'inherited');
      assert.deepEqual(cell.chain, []);
    }
  });

  /**
   * The circularity, from the other side. A deliberately-scoped skill must survive even
   * where no session happened to list it, or the fix trades one empty axis for another.
   */
  test('a skill only a settings override names is a row', () => {
    const user = settings('/home/.claude/settings.json', { skillOverrides: { legacy: 'off' } });
    const cat = buildSkillCatalog(workspace({ userSettings: user }), [], new Map());
    assert.deepEqual(allSkillIds(cat), ['legacy']);
    assert.equal(cat.entries[0]!.presence, 'installed-unobserved');
  });
});

describe('installed is not the same as observed', () => {
  const ws = workspace({
    projects: [project('/p')],
    personalSkills: [personal('deploy'), personal('never-loaded')],
  });
  const cat = buildSkillCatalog(ws, [session('/p', ['deploy'])], new Map());

  test('a skill on disk that no listing names is kept as its own category', () => {
    assert.deepEqual(countByPresence(cat), {
      observed: 1,
      'installed-unobserved': 1,
      stale: 0,
    });
    const entry = cat.entries.find((e) => e.id === 'never-loaded')!;
    assert.equal(entry.presence, 'installed-unobserved');
    assert.equal(entry.onDisk, true);
    assert.equal(entry.sessions, 0, 'no session listed it, so nothing shows it loading');
  });

  test('it stays on the axis rather than vanishing', () => {
    assert.deepEqual(allSkillIds(cat), ['deploy', 'never-loaded']);
  });

  test('and is not reported as present in any project', () => {
    const entry = cat.entries.find((e) => e.id === 'never-loaded')!;
    assert.deepEqual(entry.activeIn, []);
    assert.equal(skillPresenceIn(cat, entry, '/p'), 'unobserved');
  });
});

/**
 * Unioning every session ever would return the scratch skills the context-audit harness
 * creates and deletes -- 291 of them on the machine this was built against, against 428
 * real ones. They are excluded by being old rather than by matching their names, so a
 * real skill that shares their shape is never swallowed.
 */
describe('a listing is evidence about its own moment', () => {
  const ws = workspace({ projects: [project('/p')] });
  const cat = buildSkillCatalog(
    ws,
    [session('/p', ['deploy', 'scratch'], 1), session('/p', ['deploy'], 2)],
    new Map(),
  );

  test('only the newest listing per project decides what is current', () => {
    assert.deepEqual(allSkillIds(cat), ['deploy']);
  });

  test('what dropped out is kept as stale rather than dropped', () => {
    const entry = cat.entries.find((e) => e.id === 'scratch')!;
    assert.equal(entry.presence, 'stale');
    assert.equal(entry.sessions, 1);
    assert.deepEqual(entry.observedIn, ['/p']);
  });

  test('but an installed skill missing from the newest listing is not stale', () => {
    const withDisk = buildSkillCatalog(
      workspace({ projects: [project('/p')], personalSkills: [personal('scratch')] }),
      [session('/p', ['deploy', 'scratch'], 1), session('/p', ['deploy'], 2)],
      new Map(),
    );
    const entry = withDisk.entries.find((e) => e.id === 'scratch')!;
    assert.equal(entry.presence, 'installed-unobserved');
    assert.equal(entry.sessions, 1, 'it did load once; sessions is what says so');
  });
});

describe('a project with no usable listing cannot be spoken for', () => {
  test('a count-only listing is measured and uninformative', () => {
    const cat = buildSkillCatalog(
      workspace({ projects: [project('/p'), project('/q')] }),
      [session('/p', ['deploy']), session('/q', null)],
      new Map(),
    );
    assert.equal(cat.countOnlyListings, 1);
    assert.deepEqual(cat.measuredProjects, ['/p']);

    const entry = cat.entries.find((e) => e.id === 'deploy')!;
    assert.equal(skillPresenceIn(cat, entry, '/p'), 'observed');
    assert.equal(
      skillPresenceIn(cat, entry, '/q'),
      'unmeasured',
      'no names were recorded for /q, which is not the same as the skill being absent',
    );
  });

  test('a session with no project attribution counts but makes nothing current', () => {
    const cat = buildSkillCatalog(workspace(), [session(null, ['deploy'])], new Map());
    const entry = cat.entries.find((e) => e.id === 'deploy')!;
    assert.equal(entry.sessions, 1);
    assert.deepEqual(entry.observedIn, []);
    assert.equal(entry.presence, 'stale', 'nothing installed says it exists, and no project is current');
  });
});

/**
 * The install tree flattens skills, commands and agents into one name list, so it cannot
 * mint skill ids. Only the catalog records the kind.
 */
describe('plugin components', () => {
  const inv = new Map([['acme@market', inventory('acme@market', ['build'], ['deploy-cmd'])]]);

  test('a catalogued plugin skill is namespaced by the plugin, and says how it knew', () => {
    const cat = buildSkillCatalog(workspace(), [], inv);
    assert.deepEqual(allSkillIds(cat), ['acme:build']);
    assert.equal(cat.entries[0]!.fromPlugin, 'acme@market');
    // This factory reads no manifest, so `acme` is the id prefix standing in for a name
    // nobody could look up -- which the row has to say, since it cannot be seen in `acme`.
    assert.equal(cat.entries[0]!.keyBasis, 'marketplace-id');
  });

  test('a command is not turned into a skill', () => {
    const cat = buildSkillCatalog(workspace(), [], inv);
    assert.equal(cat.entries.some((e) => e.id === 'acme:deploy-cmd'), false);
  });

  test('the observed id and the catalogued id are the same row', () => {
    const cat = buildSkillCatalog(
      workspace({ projects: [project('/p')] }),
      [session('/p', ['acme:build'])],
      inv,
    );
    assert.equal(cat.entries.length, 1);
    assert.equal(cat.entries[0]!.presence, 'observed');
    assert.equal(cat.entries[0]!.fromPlugin, 'acme@market');
  });
});

// ---------------------------------------------------------------------------
// The plugin half of a skill id (DEA-146)
// ---------------------------------------------------------------------------

/**
 * `readInventories` over a constructed install tree: a plugin whose manifest name its
 * marketplace id does not predict, *and* which enumerates skills.
 *
 * Constructed, because no plugin on the machine this was written against has both
 * properties -- `notion@claude-plugins-official` ships `"name": "Notion"` and contributes
 * zero `skillNames`, so a gate taken from live data passes with the defect fully present.
 * That is DEA-133's shape, a guard that runs only where it must pass, and the reason this
 * fixture exists at all: the bug is latent here and a catalog refresh is enough to fire
 * it.
 *
 * Read off disk rather than through the hand-built factory below because the defect was
 * that nothing on this path ever consulted a manifest; a factory setting `manifestName`
 * tests the plumbing downstream of the read and would have passed every day the bug
 * existed. The install path is the `cased` fixture `mcp.test.ts` already reads, for the
 * same reason it shares `readManifestName`: one manifest shape, not two.
 */
function inventoriesFromDisk(id: string, skillNames: string[]): Map<string, PluginInventory> {
  const dir = mkdtempSync(join(tmpdir(), 'qm-skills-'));
  try {
    const plugins = join(dir, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(plugins, 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [id]: [
            {
              installPath: join(import.meta.dirname, 'fixtures', 'plugin-manifests', 'cased'),
              version: '0.1.0',
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(plugins, 'plugin-catalog-cache.json'),
      JSON.stringify({
        catalog: {
          plugins: { [id]: { components: { skills: skillNames.map((name) => ({ name })) } } },
        },
      }),
    );
    return readInventories(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOTION = 'notion@claude-plugins-official';

/**
 * `Notion:create-page` is a literal, and it is somebody else's fact: it is what Claude
 * Code writes into the `names` array of a `skill_listing` record, on 438 of this
 * machine's sessions, against 0 for `notion:create-page`. Deriving the expectation from
 * the code under test would put the same expression on both sides of the comparison
 * (DEA-133), and it is exactly the expression at fault.
 */
describe('a skill id carries the plugin manifest name, not the marketplace id', () => {
  test('a plugin whose manifest disagrees with its id mints the manifest ids', () => {
    const cat = buildSkillCatalog(workspace(), [], inventoriesFromDisk(NOTION, ['create-page', 'search']));

    assert.deepEqual(allSkillIds(cat), ['Notion:create-page', 'Notion:search']);
    for (const e of cat.entries) {
      assert.equal(e.fromPlugin, NOTION);
      assert.equal(e.keyBasis, 'manifest', 'a name read off a manifest must not read as assumed');
    }
  });

  /**
   * The cost of getting it wrong, which is not merely a mislabelled row: the observed id
   * and the catalogued id have to be the same row. Building the catalogued one from the
   * id prefix splits one skill into two -- one `observed` and one `installed-unobserved`,
   * the second of them carrying a `skillOverrides` key no config file would ever match.
   */
  test('and the id a listing carries is that same row, not a second one', () => {
    const cat = buildSkillCatalog(
      workspace({ projects: [project('/p')] }),
      [session('/p', ['Notion:create-page'])],
      inventoriesFromDisk(NOTION, ['create-page']),
    );

    assert.deepEqual(allSkillIds(cat), ['Notion:create-page']);
    assert.equal(cat.entries[0]!.presence, 'observed');
    assert.equal(cat.entries[0]!.sessions, 1);
    assert.equal(
      cat.entries.some((e) => e.id === 'notion:create-page'),
      false,
      'the id-derived spelling is a second row for one skill, and nothing can write it',
    );
  });
});

/**
 * The gate, and the two mutations it has to catch.
 *
 * One plugin of each kind, which is the minimum that makes the mutations distinguishable
 * from each other: `Notion` has a manifest that disagrees with its id, `humanizer` has no
 * readable manifest at all. Hand-built here rather than read off disk, because what is
 * under test is the derivation and not the read.
 */
function scenario(): Map<string, PluginInventory> {
  return new Map([
    [NOTION, inventory(NOTION, ['create-page', 'search'], [], 'Notion')],
    ['humanizer@agent-toolkit', inventory('humanizer@agent-toolkit', ['humanize'])],
  ]);
}

/** What that catalog's axis is, written out. Sorted the way `allSkillIds` sorts. */
const EXPECTED_SKILL_IDS = ['humanizer:humanize', 'Notion:create-page', 'Notion:search'];

/**
 * How each plugin row's id was arrived at, written out separately.
 *
 * A second expectation rather than a richer `EXPECTED_SKILL_IDS`, because the axis is the
 * thing that *cannot* see this: `humanizer:humanize` reads identically whether the plugin
 * half was read from a manifest or assumed from the id, so a gate over ids alone passes a
 * build that has stopped telling the two apart.
 */
const EXPECTED_BASIS: ReadonlyArray<readonly [string, PluginKeyBasis]> = [
  ['Notion:create-page', 'manifest'],
  ['Notion:search', 'manifest'],
  ['humanizer:humanize', 'marketplace-id'],
];

/** Every row the expectation and the axis disagree about, named. */
function diff(actual: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of EXPECTED_SKILL_IDS) if (!actual.includes(id)) out.push(`missing row ${id}`);
  for (const id of actual) if (!EXPECTED_SKILL_IDS.includes(id)) out.push(`extra row ${id}`);
  return out;
}

/** Every plugin row whose id came from somewhere the expectation did not say. */
function basisDiff(cat: SkillCatalog): string[] {
  const out: string[] = [];
  const got = new Map(
    cat.entries.filter((e) => e.fromPlugin !== null).map((e) => [e.id, e.keyBasis]),
  );
  for (const [id, basis] of EXPECTED_BASIS) {
    const seen = got.get(id);
    if (seen === undefined) out.push(`no plugin row ${id}`);
    else if (seen !== basis) out.push(`${id} spelled from ${seen}, expected ${basis}`);
  }
  for (const [id, basis] of got) {
    if (!EXPECTED_BASIS.some(([n]) => n === id)) out.push(`extra plugin row ${id} (${basis})`);
  }
  return out;
}

/** Both halves of the gate: what the rows are called, and where each name came from. */
function gateFailures(inv: Map<string, PluginInventory>): string[] {
  const cat = buildSkillCatalog(workspace(), [], inv);
  return [...diff(allSkillIds(cat)), ...basisDiff(cat)];
}

interface Mutation {
  name: string;
  /** Mutates the inventories in place. The catalog is built afterwards. */
  apply: (inv: Map<string, PluginInventory>) => void;
  /** What the divergence must say, so a gate failing for another reason shows. */
  names: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    /**
     * DEA-146 itself, from the only side a test can reach without editing source: a
     * reader that opens no manifest and splits the marketplace id instead.
     *
     * Latent rather than live on the machine this was written against, which is what a
     * constructed fixture is for -- the same mutation applied to the live workspace
     * changes nothing, because the one plugin it would affect enumerates no skills.
     */
    name: 'build the plugin half of a skill id from the marketplace id',
    apply: (inv) => {
      for (const i of inv.values()) i.manifestName = i.id.split('@')[0]!;
    },
    names: /^(missing row Notion:create-page|extra row notion:create-page)$/,
  },
  {
    /**
     * The fallback promoted to a reading -- as if `readManifestName` returned the id
     * prefix instead of `null` when it could not open the file.
     *
     * `diff` reports nothing for this one: the rows are identical, because the fallback
     * id *is* the id-derived id. Only `basisDiff` can see it, which is the case for
     * carrying the basis as a field rather than looking it up. Left unnoticed it is the
     * `usageCount` mistake -- "couldn't tell" recorded as a confirmed value.
     */
    name: 'treat an unreadable manifest as a confirmed name',
    apply: (inv) => {
      for (const i of inv.values()) i.manifestName ??= i.id.split('@')[0]!;
    },
    names: /^humanizer:humanize spelled from manifest, expected marketplace-id$/,
  },
];

describe('the gate fails when the plugin half is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const inv = scenario();
      mutation.apply(inv);

      const failures = gateFailures(inv);
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
   * The claim the second mutation's comment makes, asserted rather than described. If
   * this ever goes red the rows caught the promotion on their own and `keyBasis` has
   * stopped being the only thing standing between a guess and a measurement -- which
   * would be worth knowing, and is not what happens today.
   */
  test('and the fallback mutation is invisible to the row set, which is why the field exists', () => {
    const inv = scenario();
    for (const i of inv.values()) i.manifestName ??= i.id.split('@')[0]!;
    assert.deepEqual(diff(allSkillIds(buildSkillCatalog(workspace(), [], inv))), []);
  });

  /** The positive control the two above are measured against. */
  test('and passes when nothing is lost', () => {
    assert.deepEqual(gateFailures(scenario()), []);
  });
});

/**
 * Nine of the 88 entries under `~/.claude/skills/` on the machine this was built against
 * are symlinks into `~/.agents/skills/`. A dirent calls those symlinks and not
 * directories, so reading the kind off the dirent silently loses every skill installed
 * that way.
 */
describe('personal skills on disk', () => {
  test('a symlinked skill directory counts', () => {
    const home = mkdtempSync(join(tmpdir(), 'qm-skills-'));
    try {
      const skills = join(home, '.claude', 'skills');
      mkdirSync(join(skills, 'plain'), { recursive: true });
      writeFileSync(join(skills, 'plain', 'SKILL.md'), '# plain');

      const elsewhere = join(home, '.agents', 'skills', 'linked');
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, 'SKILL.md'), '# linked');
      symlinkSync(elsewhere, join(skills, 'linked'));

      // A directory alongside them that holds no SKILL.md is not a skill.
      mkdirSync(join(skills, 'scratch'));

      assert.deepEqual(
        readPersonalSkills(home).map((s) => s.id),
        ['linked', 'plain'],
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no skills directory is an empty list, not a throw', () => {
    assert.deepEqual(readPersonalSkills(join(tmpdir(), 'qm-absent-home')), []);
  });
});

/**
 * Against whatever this machine actually has. Ground truth is derived without going
 * through the catalog, so the assertions cannot be satisfied by the code under test
 * agreeing with itself.
 */
describe('the catalog agrees with the live workspace', () => {
  const ws = loadWorkspace();
  const live = ws.projects.filter((p) => p.alive);
  const measurements = live.flatMap((p) => measureProject(homedir(), p.path));
  const inventories = readInventories(homedir());
  const cat = buildSkillCatalog(ws, measurements, inventories);

  test('the axis is not empty when anything has been measured or installed', (t) => {
    if (!ws.personalSkills.length && !measurements.some((m) => m.skills)) {
      return t.skip('no skills on disk and no measured listing on this machine');
    }
    assert.ok(allSkillIds(cat).length > 0, 'the defect was an axis of zero rows');
  });

  test('every skill on disk is a row', (t) => {
    if (!ws.personalSkills.length) return t.skip('no personal skills on this machine');
    const ids = new Set(cat.entries.map((e) => e.id));
    const missing = ws.personalSkills.filter((s) => !ids.has(s.id)).map((s) => s.id);
    assert.deepEqual(missing, []);
  });

  test('every id in the newest listing of a measured project is observed', (t) => {
    const newest = new Map<string, TranscriptMeasurement>();
    for (const m of measurements) {
      if (!m.skills || m.project === null) continue;
      const held = newest.get(m.project);
      if (!held || m.modifiedAt > held.modifiedAt) newest.set(m.project, m);
    }
    if (!newest.size) return t.skip('no measured listing carries names on this machine');

    const expected = new Set<string>();
    for (const [, m] of newest) for (const id of m.skills!) expected.add(id);

    const observed = new Set(
      cat.entries.filter((e) => e.presence === 'observed').map((e) => e.id),
    );
    assert.deepEqual([...observed].sort(), [...expected].sort());
  });

  test('nothing resolves to anything but on/inherited while no override is set', (t) => {
    const anyOverride = [ws.userSettings, ...ws.projects.flatMap((p) => [p.settings, p.localSettings])]
      .some((f) => f?.skillOverrides && Object.keys(f.skillOverrides).length > 0);
    if (anyOverride) return t.skip('this workspace sets skillOverrides, so the default is not the whole story');

    const ids = allSkillIds(cat);
    if (!ids.length || !live.length) return t.skip('nothing to resolve on this machine');

    for (const p of live) {
      for (const id of ids) {
        const cell = resolveSkill(ws, p, id);
        assert.equal(cell.value, 'on');
        assert.equal(cell.origin, 'inherited');
      }
    }
  });
});
