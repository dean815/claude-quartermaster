/**
 * Delegation to `/doctor`.
 *
 * `/doctor` covers installation, unused extensions, duplicated or bloated memory
 * files, slow hooks, updates, and permissions -- and proposes CLAUDE.md trims against
 * Anthropic's own rubric. All of it is out of scope for quartermaster to reimplement.
 *
 * **The checkup cannot be reached from a CLI, and the earlier plan was wrong to assume
 * it could.** Two things were measured:
 *
 * 1. `claude doctor`, the CLI subcommand, does not run the checkup. Its own closing line
 *    says to run `/doctor` in a session for that.
 * 2. `claude -p "/doctor" --max-turns 1` returns nothing. Unlike `/mcp`, which answers
 *    locally in one turn, `/doctor` is agentic. Granting it enough turns to produce
 *    output also grants it enough to apply fixes, and an audit tool must not mutate
 *    config as a side effect of reporting.
 *
 * So the *checkup* is reported as needing a session, which keeps "not examined" visible
 * instead of letting an unchecked domain read as clean.
 *
 * **What the subcommand does emit was described here as installation-only -- version,
 * path, update channel -- and that was incomplete (DEA-147).** Measured against 2.1.221:
 * it also prints an `Invalid settings` block naming the exact file and key path for
 * every settings file that fails Claude Code's schema. Facts about the block, each of
 * which the parser below depends on:
 *
 * - It is **per working directory**. A run in a valid project prints no block; a run in
 *   `~/claude/claude-quartermaster` while thirteen *other* projects held invalid files
 *   named none of them. So validity costs one spawn per project, not one per machine.
 * - It covers `settings.json` and `settings.local.json` in the same run, one entry each.
 * - The separator is `›` (U+203A), not `>`.
 * - Some entries carry an indented `Suggested fix:` continuation. Not one line per error.
 * - **`No installation issues found.` still prints when settings are invalid**, and the
 *   entries begin with `- `, so `parseInstallationIssues` matches nothing and the block
 *   is invisible to it. That function is left alone: installation health and settings
 *   validity are different domains, and the block sits between them in the output only
 *   by accident of layout.
 *
 * Nothing here turns the block into a finding. Reporting a discarded file to the user is
 * DEA-148; this builds the model it will read.
 */
import { join } from 'node:path';

import { claudeCli } from '../disclose.ts';

import type { SettingsValidity } from '../surfaces/types.ts';
import type { Adapter, Availability } from './types.ts';

/**
 * Installation health only. Cheap, read-only, and not the checkup.
 *
 * This adapter runs on every audit, not only under `--full`, so on a machine without
 * `~/.claude.json` this is usually the spawn that creates it -- hence the funnel
 * rather than a bare `execFileSync` (DEA-140).
 */
export function installationSummary(): string | null {
  try {
    return claudeCli.run(['doctor'], { timeoutMs: 60_000 });
  } catch {
    return null;
  }
}

export function parseInstallationIssues(text: string): string[] {
  if (/No installation issues found/i.test(text)) return [];
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(warning|error|issue)/i.test(l));
}

// ---------------------------------------------------------------------------
// Settings validity (DEA-147)
// ---------------------------------------------------------------------------

/** The header the block opens with. Nothing else in the output uses this line. */
const BLOCK_HEADER = 'Invalid settings';

/** U+203A, between the file path and the key path. Not `>`. */
const SEPARATOR = ' › ';

/**
 * The whole discriminator between "one key dropped" and "the file voided".
 *
 * First-party prose with no version guarantee behind it, pinned here so the day it
 * changes is one edit and not a hunt. When it does change, every `field-dropped` file
 * starts classifying `discarded` -- which is the direction that reports live overrides
 * as void, so `test/validity.test.ts` measures exactly that mutation.
 */
export const FIELD_IGNORED_NOTE = 'This field was ignored.';

/** One entry of the `Invalid settings` block. */
export interface SettingsError {
  /** Absolute path of the settings file, as `doctor` printed it. */
  path: string;
  /** Dotted key path -- `permissions.deny`, `extraKnownMarketplaces.<id>.source`. */
  key: string;
  /** The message after the key, verbatim and on its own line. */
  message: string;
  /** Indented continuations of that entry -- `Suggested fix: ...` -- verbatim. */
  notes: string[];
  /** Whether `message` ends in the note. The one thing that decides the two classes. */
  fieldIgnored: boolean;
}

/**
 * Every entry of the `Invalid settings` block, or none when there is no block.
 *
 * Ends at the first blank line, because the block is followed by one; a line that is
 * neither a new entry nor an indented continuation ends it too, so a release that drops
 * the blank line degrades to reading fewer entries rather than swallowing the rest of
 * the output as notes.
 */
export function parseInvalidSettings(text: string): SettingsError[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === BLOCK_HEADER);
  if (start === -1) return [];

  const out: SettingsError[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;

    if (line.startsWith('- ')) {
      const entry = line.slice(2);
      const at = entry.indexOf(SEPARATOR);
      // No separator means this is not an entry of the shape we know how to read.
      // Stopping is the honest response: a half-read block would report the files it
      // did parse as the complete set, and silence about a file reads as `accepted`.
      if (at === -1) break;
      const path = entry.slice(0, at);
      const rest = entry.slice(at + SEPARATOR.length);
      const colon = rest.indexOf(': ');
      if (colon === -1) break;
      const message = rest.slice(colon + 2).trim();
      out.push({
        path,
        key: rest.slice(0, colon),
        message,
        notes: [],
        fieldIgnored: message.endsWith(FIELD_IGNORED_NOTE),
      });
      continue;
    }

    // An indented continuation belongs to the entry above it. `fieldIgnored` is not
    // recomputed over it: the note was measured as the tail of the message, and letting
    // a `Suggested fix:` line supply it would make the sentence's position irrelevant
    // and widen the discriminator on a guess.
    if (/^\s/.test(line) && out.length) {
      out.at(-1)!.notes.push(line.trim());
      continue;
    }

    break;
  }
  return out;
}

/**
 * One file's errors, classified.
 *
 * An empty list is `accepted`, which is only true for a file the run actually covered --
 * `settingsFromDoctor` owns that distinction, and a file it did not cover never reaches
 * this function.
 */
export function validityOf(errors: readonly SettingsError[]): SettingsValidity {
  if (!errors.length) return 'accepted';
  return errors.every((e) => e.fieldIgnored) ? 'field-dropped' : 'discarded';
}

/**
 * Validity per settings file, from the output of one `doctor` run.
 *
 * `covered` names the files this run is known to speak for, so that silence about them
 * is evidence rather than absence of it -- the run's own working directory contributes
 * both of its settings files, because a valid project was measured printing no block at
 * all. A file the run *named* is classified whether or not it was covered, which is the
 * only route by which `~/.claude/settings.json` is ever more than `not-checked`.
 * Anything else is simply absent, and the caller reads absence as `not-checked`.
 */
export function settingsFromDoctor(
  text: string,
  covered: readonly string[],
): Map<string, SettingsValidity> {
  const byPath = new Map<string, SettingsError[]>();
  for (const e of parseInvalidSettings(text)) {
    byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  }

  const out = new Map<string, SettingsValidity>();
  for (const path of covered) out.set(path, 'accepted');
  for (const [path, errors] of byPath) out.set(path, validityOf(errors));
  return out;
}

/**
 * The live check, as `loadWorkspace` wants it: one directory in, its files' validity out.
 *
 * A factory rather than a bare function, because the "the CLI is not here" answer has to
 * be remembered for the run and not relearned 27 times. `LazyPluginCosts.listAttempted`
 * is the same guard for the same reason.
 *
 * `~/.claude.json` is untouched by this: neither `doctor` nor `plugin list --json`
 * registered a scratch working directory during DEA-147's measurements, so pointing this
 * at every project adds no project entries. It is still a `claude` spawn, so it goes
 * through the one door that reports a config file this run caused to exist (DEA-140).
 */
export function doctorSettingsValidity(): (dir: string) => ReadonlyMap<string, SettingsValidity> {
  const empty: ReadonlyMap<string, SettingsValidity> = new Map();
  let unavailable = false;

  return (dir) => {
    if (unavailable) return empty;
    try {
      const text = claudeCli.run(['doctor'], { timeoutMs: 60_000, cwd: dir });
      return settingsFromDoctor(text, [
        join(dir, '.claude', 'settings.json'),
        join(dir, '.claude', 'settings.local.json'),
      ]);
    } catch {
      // No CLI, or it failed here. Either way nothing was measured, and every file falls
      // through to `not-checked` -- never to `accepted`, which is what a `return {}` from
      // a "validator" would quietly mean.
      unavailable = true;
      return empty;
    }
  };
}

export function doctorAdapter(): Adapter {
  return {
    name: 'doctor',
    domain: 'unused extensions, memory bloat, slow hooks, permissions, CLAUDE.md trims',
    async run(): Promise<Availability> {
      const text = installationSummary();
      if (text === null) {
        return {
          status: 'unavailable',
          reason: 'the claude CLI is not on PATH, so installation health was not examined',
        };
      }

      const issues = parseInstallationIssues(text);
      if (issues.length) {
        return {
          status: 'checked',
          findings: [
            {
              detector: 'installation-health',
              severity: 'medium',
              title: `claude doctor reported ${issues.length} installation issue${issues.length === 1 ? '' : 's'}`,
              detail: 'Reported by the first-party installation check, verbatim.',
              evidence: issues.slice(0, 8),
              fix: 'Run /doctor in a session for the full checkup, which can also fix it.',
            },
          ],
        };
      }

      // Installation is fine, but that is the small half of what /doctor does.
      return {
        status: 'needs-session',
        reason:
          'installation is healthy, but the checkup itself -- unused extensions, memory ' +
          'bloat, slow hooks, permissions -- runs only inside a session and can apply ' +
          'fixes, so it is not invoked from here',
        invoke: '/doctor',
      };
    },
  };
}
