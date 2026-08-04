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
} from '../src/skills.ts';
import { resolveSkill } from '../src/resolve.ts';
import { loadWorkspace, readPersonalSkills } from '../src/surfaces/read.ts';
import { measureProject } from '../src/cost/transcript.ts';
import { readInventories } from '../src/inventory.ts';
import type { PluginInventory } from '../src/inventory.ts';
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

function inventory(id: string, skillNames: string[], otherNames: string[] = []): PluginInventory {
  return {
    id,
    installPath: `/plugins/${id}`,
    version: '1',
    sha: null,
    manifestName: null,
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

  test('a catalogued plugin skill is namespaced by the plugin short name', () => {
    const cat = buildSkillCatalog(workspace(), [], inv);
    assert.deepEqual(allSkillIds(cat), ['acme:build']);
    assert.equal(cat.entries[0]!.fromPlugin, 'acme@market');
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
