/**
 * Point `loadWorkspace` at the committed differential fixture.
 *
 * The fixture records its projects under `/Users/testuser`, a path that exists on no
 * machine, so `loadWorkspace({ home })` alone reports all 66 entries as dead. Dead
 * projects are silently skipped by the gate, which would turn a broken replay into a
 * green one. Rebasing that prefix onto the fixture's own `home/` is the whole contract,
 * and it lives here rather than in prose so there is one copy of it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadWorkspace } from '../../../src/surfaces/read.ts';
import type { Workspace } from '../../../src/surfaces/types.ts';

export const FIXTURE_ROOT = import.meta.dirname;
export const FIXTURE_HOME = join(FIXTURE_ROOT, 'home');

/** The home path the fixture was anonymised onto. Also the `~`-is-a-project key. */
const RECORDED_HOME = '/Users/testuser';

export function loadFixtureWorkspace(): Workspace {
  return loadWorkspace({
    home: FIXTURE_HOME,
    projectPathResolver: (recorded) =>
      recorded === RECORDED_HOME || recorded.startsWith(RECORDED_HOME + '/')
        ? join(FIXTURE_HOME, recorded.slice(RECORDED_HOME.length))
        : null,
  });
}

/** `claude plugin list --json` as it answered for each project, keyed by fixture path. */
export function readOracle(): Record<string, Array<{ id: string; enabled: boolean }>> {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'oracle.json'), 'utf8'));
}

export interface FixtureManifest {
  projectEntries: number;
  oracleProjects: number;
  pairs: number;
  plugins: number;
  /** Counted by *winning* scope, which is what mutation sensitivity follows. */
  decidedByScope: Record<'user' | 'project' | 'local' | 'default', number>;
  probeProjects: string[];
}

/**
 * What the generator counted when it wrote the fixture.
 *
 * The gate asserts against these rather than against constants in the test file. A
 * hand-copied count goes stale the moment the fixture is regenerated, and a count
 * derived from `oracle.json` itself moves with every shrink and so asserts nothing.
 * Written by the generator and committed, a shrink shows up as a diff in a tracked
 * file — which someone has to look at — instead of a number nobody remembered to edit.
 */
export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
}
