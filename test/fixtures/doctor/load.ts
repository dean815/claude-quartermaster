/**
 * Read the committed `claude doctor` recording.
 *
 * Two gates run off these cases and they ask different questions: `validity.test.ts`
 * asks whether resolution matches first-party once validity is consulted, and
 * `discarded-settings.test.ts` asks what the detector says about the same files. Both
 * need the same three things -- the manifest, the recorded output with its capture path
 * rebased, and the settings files read with the validity that output produced -- so the
 * loader lives here with one body, next to the fixture it loads. The differential
 * fixture's `load.ts` is the same arrangement for the same reason.
 *
 * Nothing here interprets the recording. `settingsFromDoctor` is the real parser, called
 * with real arguments; a helper that decided validity itself would let both gates agree
 * with a broken classifier.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { settingsFromDoctor } from '../../../src/delegate/doctor.ts';
import { NOT_CHECKED, readSettings } from '../../../src/surfaces/read.ts';
import type { SettingsCheck, SettingsFile } from '../../../src/surfaces/types.ts';

export const FIXTURE_ROOT = import.meta.dirname;

export interface RecordedCase {
  name: string;
  note: string;
  /** `claude plugin list --json`, run in the probe directory holding exactly these files. */
  enabled: boolean;
  files: string[];
  /**
   * The release this one case was captured against, when it is not the manifest's.
   *
   * A recording is dated by construction, and the set grew after Claude Code moved. Left
   * as one field per case rather than re-capturing the original five against the new
   * release: re-recording to make a version number tidy would throw away the only
   * evidence that the block's shape survived a release, which is the thing a recording
   * is for.
   */
  claudeVersion?: string;
}

export interface Manifest {
  capturedAt: string;
  claudeVersion: string;
  plugin: string;
  /** `~/.claude/settings.json` as it stood at capture time, for the probed plugin only. */
  userScope: Record<string, boolean>;
  /** The cwd `doctor` printed paths against. Rebased onto each case's own directory. */
  recordedProjectDir: string;
  cases: RecordedCase[];
}

export const MANIFEST: Manifest = JSON.parse(
  readFileSync(join(FIXTURE_ROOT, 'manifest.json'), 'utf8'),
);

export const CASES = MANIFEST.cases;

export const caseDir = (c: RecordedCase) => join(FIXTURE_ROOT, c.name);
export const settingsPath = (c: RecordedCase) => join(caseDir(c), '.claude', 'settings.json');
export const localPath = (c: RecordedCase) => join(caseDir(c), '.claude', 'settings.local.json');

/**
 * The recorded `doctor` output, with the capture machine's probe path rebased onto this
 * case's own directory.
 *
 * The committed file is byte-verbatim; this is one substitution of one string the
 * manifest records, and it is the only thing standing between a recording made in a
 * scratch directory and a fixture that runs from any checkout. The messages themselves
 * are untouched, which is the half that matters -- the `›`, the trailing note, the
 * indented continuation.
 */
export function doctorText(c: RecordedCase): string {
  const raw = readFileSync(join(caseDir(c), 'doctor.txt'), 'utf8');
  return raw.replaceAll(MANIFEST.recordedProjectDir, caseDir(c));
}

/** The files a run in this case's directory speaks for -- both, whether or not they exist. */
export const covered = (c: RecordedCase) => [settingsPath(c), localPath(c)];

/** What the real parser makes of this case, keyed by absolute path. */
export function checksFor(c: RecordedCase): ReadonlyMap<string, SettingsCheck> {
  return settingsFromDoctor(doctorText(c), covered(c));
}

/** This case's settings files, each carrying the validity the recording produced. */
export function filesOf(c: RecordedCase): SettingsFile[] {
  const checks = checksFor(c);
  return [settingsPath(c), localPath(c)]
    .map((p) => readSettings(p, checks.get(p) ?? NOT_CHECKED))
    .filter((f): f is SettingsFile => f !== null);
}
