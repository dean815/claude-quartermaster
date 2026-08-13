/**
 * The ids this repo mints, against the names Claude Code publishes (QM-45).
 *
 * `qm set --axis skill` writes a `skillOverrides` key, and `skillOverrides` matches on
 * **exactly** the string first-party publishes: `<plugin>:<skill>` for a plugin's skill,
 * the bare directory name for a personal one. A key it does not match is accepted,
 * written, and does nothing -- DEA-145's failure mode, reachable on this axis today.
 * Measured on 2.1.224 with a headless run's `skill_listing` record as the oracle:
 * `deepgram:api` and `artifact-design` both took effect; bare `docs`, for the plugin skill
 * `deepgram:docs`, was accepted and silently did nothing.
 *
 * So what makes the write axis safe is an *agreement* -- that every id `allSkillIds`
 * emits is a name a listing has carried -- and nothing in this suite asserted it. That is
 * what this file is. It is deliberately not a re-derivation of the key form: the form was
 * measured, and a test that recomputed it would agree with whatever the code does.
 *
 * ## Both sides are recordings
 *
 * The published names are verbatim first-party output (`published-names.json`, with its
 * own provenance note). The plugin manifests are the real files, copied out of the
 * install tree -- `notion@claude-plugins-official` ships `"name": "Notion"`, which its
 * marketplace id does not predict, and `superpowers@claude-plugins-official` ships a name
 * that matches its id prefix. The two together are the minimum that tells a manifest read
 * apart from an id split.
 *
 * **One thing here is not a recording and says so.** The live catalog cache enumerates
 * *zero* skills for notion, so no id the repo builds today has a namespace its
 * marketplace id fails to predict -- checked across all 42 installed plugins, and it is
 * why the live join (177 ids, 0 unmatched) cannot fail under the mutation below. The
 * fixture's catalog entry gives notion the skill names first-party already publishes
 * under `Notion:`, which is the state one catalog refresh away. The names are
 * first-party's; putting them in the catalog is ours, and it is the whole reason a
 * constructed fixture exists rather than a live measurement.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readInventories, type PluginInventory } from '../src/inventory.ts';
import { readPersonalSkills } from '../src/surfaces/read.ts';
import { allSkillIds, buildSkillCatalog } from '../src/skills.ts';
import { SKILL_AXIS, editsFor } from '../src/toggle.ts';
import type { ClaudeJson, PersonalSkill, Workspace } from '../src/surfaces/types.ts';

// ---------------------------------------------------------------------------
// The recorded halves
// ---------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, 'fixtures', 'skill-keys');

const RECORDED: { recordedFrom: string; names: string[] } = JSON.parse(
  readFileSync(join(FIXTURE, 'published-names.json'), 'utf8'),
);

/** Every name a `skill_listing` was recorded carrying. The right-hand side of the join. */
const PUBLISHED = new Set(RECORDED.names);

/**
 * What each fixture plugin provides, as its catalog entry would say.
 *
 * The bare skill names only. The namespace -- the half under test -- is never written
 * here: it comes from the manifest on disk, through `readManifestName`, which is the read
 * the defect this guards against skips.
 */
const CATALOGUED: Record<string, string[]> = {
  'notion@claude-plugins-official': ['create-page', 'search'],
  'superpowers@claude-plugins-official': ['writing-plans', 'test-driven-development', 'brainstorming'],
};

/** Personal skills, as directory names -- which is the id `skillOverrides` uses. */
const PERSONAL = ['context-audit'];

/** Which fixture manifest directory each id installs from. */
const INSTALLED_FROM: Record<string, string> = {
  'notion@claude-plugins-official': join(FIXTURE, 'plugins', 'notion'),
  'superpowers@claude-plugins-official': join(FIXTURE, 'plugins', 'superpowers'),
};

let home = '';

before(() => {
  home = mkdtempSync(join(tmpdir(), 'qm-skill-keys-'));
  const plugins = join(home, '.claude', 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({
      plugins: Object.fromEntries(
        Object.entries(INSTALLED_FROM).map(([id, path]) => [
          id,
          [{ installPath: path, version: '0.0.0' }],
        ]),
      ),
    }),
  );
  writeFileSync(
    join(plugins, 'plugin-catalog-cache.json'),
    JSON.stringify({
      catalog: {
        plugins: Object.fromEntries(
          Object.entries(CATALOGUED).map(([id, skills]) => [
            id,
            { components: { skills: skills.map((name) => ({ name })) } },
          ]),
        ),
      },
    }),
  );
  for (const id of PERSONAL) {
    mkdirSync(join(home, '.claude', 'skills', id), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', id, 'SKILL.md'), '---\nname: x\n---\n');
  }
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

const claudeJson = (): ClaudeJson => ({
  path: join('/nowhere', '.claude.json'),
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
});

function workspace(personalSkills: PersonalSkill[]): Workspace {
  return {
    home,
    userSettings: null,
    userRules: [],
    personalSkills,
    claudeJson: claudeJson(),
    projects: [],
  };
}

/**
 * The axis, built the way the grid and the write path build it.
 *
 * No measurements are passed: a listing would put its own names into the catalog, and an
 * id that came *from* a listing matches a published name by identity. Only the ids this
 * repo *constructs* are worth joining, so only those are built.
 */
function repoBuiltIds(mutate: (inv: Map<string, PluginInventory>) => void = () => {}): string[] {
  const inv = readInventories(home);
  mutate(inv);
  const ws = workspace(readPersonalSkills(home));
  return allSkillIds(buildSkillCatalog(ws, [], inv));
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

/** Whether first-party has been recorded publishing this exact string. */
type Join = (id: string, published: ReadonlySet<string>) => boolean;

const exactJoin: Join = (id, published) => published.has(id);

/** Every id the join says first-party has never published, named. */
function unmatched(ids: readonly string[], join: Join = exactJoin): string[] {
  return ids.filter((id) => !join(id, PUBLISHED)).map((id) => `${id} matches no published name`);
}

describe('every id the repo builds is a key Claude Code matches', () => {
  test('the fixture axis is what it is meant to be', () => {
    // A literal, and it is where the manifest read shows: `Notion` is not `notion`, and
    // nothing in `CATALOGUED` above spells it.
    assert.deepEqual(repoBuiltIds(), [
      'context-audit',
      'Notion:create-page',
      'Notion:search',
      'superpowers:brainstorming',
      'superpowers:test-driven-development',
      'superpowers:writing-plans',
    ]);
  });

  test('and every one of them joins a recorded published name', () => {
    const ids = repoBuiltIds();
    const failures = unmatched(ids);
    assert.deepEqual(failures, [], `\n  ${failures.length} unmatched:\n  ${failures.join('\n  ')}`);
    console.log(
      `    skill-keys: ${ids.length} repo-built ids, ${PUBLISHED.size} recorded published names, ` +
        `${ids.length} matched, 0 unmatched`,
    );
  });

  /**
   * The join tied to the write, rather than left as a property of the grid.
   *
   * `editsFor` is what turns an id into bytes, and this asserts the path it produces is
   * `skillOverrides.<published name>` -- so the agreement above is an agreement about the
   * key that lands in the file and not about a display string that happens to look like
   * one.
   */
  test('and the edit each one produces keys on that same published name', () => {
    for (const id of repoBuiltIds()) {
      const [edit] = editsFor(SKILL_AXIS, null, [{ id, value: 'off' }]);
      assert.deepEqual(edit, { path: ['skillOverrides'], value: { [id]: 'off' } });
      assert.ok(PUBLISHED.has(id), `${id} would be written and matched by nothing`);
    }
  });
});

// ---------------------------------------------------------------------------
// The mutations
// ---------------------------------------------------------------------------

/**
 * The defect, applied where a test can reach it: a reader that opens no manifest and
 * splits the marketplace id instead.
 *
 * This is DEA-145/QM-35 on the skill axis, and the difference from the same mutation in
 * `skills.test.ts` is what the failure is measured *against*. There it is a hand-written
 * list of expected ids; here it is a set of strings Claude Code was recorded emitting. A
 * gate against our own expectation can be satisfied by editing the expectation.
 */
const fromMarketplaceId = (inv: Map<string, PluginInventory>) => {
  for (const i of inv.values()) i.manifestName = i.id.split('@')[0]!;
};

/**
 * Joins that look like the real one and are not.
 *
 * Each is a plausible loosening -- the kind someone reaches for when a comparison "nearly
 * works" -- and each is asserted to stop the mutation above being visible. That is what
 * "the join, broken" means here: not that it throws, but that it goes on returning zero
 * unmatched while the ids are wrong. A join is only doing work if there is something it
 * refuses.
 *
 * Both members erase the namespace, one by folding its case and one by ignoring it, and
 * that is not a coincidence in the choice: **the namespace is the only part of the id
 * this defect touches**, so a loosening that leaves it comparable stays a working gate.
 * A substring join (`n.includes(id) || id.includes(n)`) was tried and still catches the
 * mutation, which is why it is not in this list -- it is a worse join that happens to
 * remain sufficient here, and shipping it as a caught case would have been a mutation
 * adjusted to fit its assertion.
 */
const LOOSE_JOINS: Array<{ name: string; join: Join }> = [
  {
    name: 'case-insensitive',
    join: (id, published) => [...published].some((n) => n.toLowerCase() === id.toLowerCase()),
  },
  {
    name: 'bare-skill-name, namespace ignored',
    join: (id, published) => {
      const bare = id.slice(id.indexOf(':') + 1);
      return [...published].some((n) => n === bare || n.endsWith(`:${bare}`));
    },
  },
];

describe('the gate fails when the plugin half of the key is wrong', () => {
  test('building the namespace from the marketplace id breaks the join', () => {
    const ids = repoBuiltIds(fromMarketplaceId);
    const failures = unmatched(ids);

    assert.ok(
      failures.length > 0,
      'a marketplace-id namespace cost nothing — that is a hole in the gate, not a mutation ' +
        'to delete',
    );
    // Named, so a gate reddening for some other reason is not mistaken for this working.
    assert.deepEqual(failures.sort(), [
      'notion:create-page matches no published name',
      'notion:search matches no published name',
    ]);
    // The control: the plugin whose manifest name *is* its id prefix is unaffected, which
    // is what makes the failure about the read rather than about the mutation touching
    // everything.
    assert.ok(ids.includes('superpowers:writing-plans'));
    assert.ok(ids.includes('context-audit'));
    console.log(`    caught the marketplace-id namespace (${failures.length}): ${failures[0]}`);
  });

  for (const { name, join } of LOOSE_JOINS) {
    test(`a ${name} join stops seeing it`, () => {
      // Sound on the healthy axis -- a loosening that rejected correct ids would be
      // caught by everything, and would not be the interesting failure.
      assert.deepEqual(unmatched(repoBuiltIds(), join), []);

      const loosened = unmatched(repoBuiltIds(fromMarketplaceId), join);
      assert.deepEqual(
        loosened,
        [],
        `the ${name} join still caught the mutation, so it is not the loosening this ` +
          'documents — check the case before relaxing the assertion',
      );
      console.log(`    a ${name} join reports 0 unmatched on ids nothing would match`);
    });
  }
});
