import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCell,
  precedenceOf,
  SCOPES,
  type ChainLink,
  type SkillValue,
} from '../src/model.ts';

const at = <V>(scope: ChainLink<V>['scope'], value: V): ChainLink<V> => ({
  scope,
  value,
  source: `/fake/${scope}.json`,
});

describe('precedence', () => {
  test('ascends user -> project -> local', () => {
    assert.ok(precedenceOf('user') < precedenceOf('project'));
    assert.ok(precedenceOf('project') < precedenceOf('local'));
  });

  test('every declared scope is orderable', () => {
    const ranks = SCOPES.map(precedenceOf);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(new Set(ranks).size, SCOPES.length);
  });
});

/**
 * The six states the README's A-F table describes, expressed in the two-axis model.
 * If this block passes, replacing A-F lost nothing.
 */
describe('A-F equivalence for binary values', () => {
  const cases: Array<[string, ChainLink<boolean>[], boolean, string]> = [
    ['A  on, inherited from global', [at('user', true)], true, 'inherited'],
    ['B  on at project, global also on', [at('user', true), at('project', true)], true, 'restated'],
    ['C  on at project, global off', [at('user', false), at('project', true)], true, 'overridden'],
    ['D  off at project, global on', [at('user', true), at('project', false)], false, 'overridden'],
    ['E  off, inherited from global', [at('user', false)], false, 'inherited'],
    ['F  off at project, global also off', [at('user', false), at('project', false)], false, 'restated'],
  ];

  for (const [name, links, value, origin] of cases) {
    test(name, () => {
      const cell = resolveCell(links, false);
      assert.equal(cell.value, value);
      assert.equal(cell.origin, origin);
    });
  }
});

describe('absence', () => {
  test('no links at all falls back and reads as inherited', () => {
    const cell = resolveCell<boolean>([], false);
    assert.deepEqual(cell, { value: false, origin: 'inherited', chain: [] });
  });

  test('a project entry with no global entry is an override, not a restatement', () => {
    // Nothing to inherit, so enabling here is a real decision.
    const cell = resolveCell([at('project', true)], false);
    assert.equal(cell.value, true);
    assert.equal(cell.origin, 'overridden');
  });

  test('a project entry matching the fallback is a restatement', () => {
    // Disabling something that was already off by default does nothing.
    const cell = resolveCell([at('project', false)], false);
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'restated');
  });
});

describe('local beats project', () => {
  test('local wins and the chain records both', () => {
    const cell = resolveCell([at('user', true), at('project', true), at('local', false)], false);
    assert.equal(cell.value, false);
    assert.equal(cell.origin, 'overridden');
    assert.deepEqual(
      cell.chain.map((l) => l.scope),
      ['user', 'project', 'local'],
    );
  });

  test('local restating what project already set still counts as project-level', () => {
    // Both are project scopes, so the comparison is against the user value.
    const cell = resolveCell([at('user', false), at('project', true), at('local', true)], false);
    assert.equal(cell.value, true);
    assert.equal(cell.origin, 'overridden');
  });

  test('input order does not matter', () => {
    const forward = resolveCell([at('user', true), at('local', false)], false);
    const reversed = resolveCell([at('local', false), at('user', true)], false);
    assert.deepEqual(forward, reversed);
  });
});

/**
 * The reason A-F was replaced: skills carry four values, so origin has to be
 * independent of the value domain.
 */
describe('four-valued skills', () => {
  test('name-only at project against on at user is an override', () => {
    const cell = resolveCell<SkillValue>([at('user', 'on'), at('project', 'name-only')], 'on');
    assert.equal(cell.value, 'name-only');
    assert.equal(cell.origin, 'overridden');
  });

  test('off restated at project is still redundant', () => {
    const cell = resolveCell<SkillValue>([at('user', 'off'), at('local', 'off')], 'on');
    assert.equal(cell.value, 'off');
    assert.equal(cell.origin, 'restated');
  });

  test('an absent override resolves to on, inherited', () => {
    const cell = resolveCell<SkillValue>([], 'on');
    assert.equal(cell.value, 'on');
    assert.equal(cell.origin, 'inherited');
  });

  test('every skill value survives a round trip at project scope', () => {
    for (const v of ['on', 'name-only', 'user-invocable-only', 'off'] as const) {
      const cell = resolveCell<SkillValue>([at('project', v)], 'on');
      assert.equal(cell.value, v);
      assert.equal(cell.origin, v === 'on' ? 'restated' : 'overridden');
    }
  });
});

describe('provenance', () => {
  test('the chain keeps the file that set each value', () => {
    const cell = resolveCell([at('user', true), at('local', false)], false);
    assert.deepEqual(
      cell.chain.map((l) => l.source),
      ['/fake/user.json', '/fake/local.json'],
    );
  });

  test('resolveCell does not mutate its input', () => {
    const links = [at('local', false), at('user', true)];
    const snapshot = structuredClone(links);
    resolveCell(links, false);
    assert.deepEqual(links, snapshot);
  });
});
