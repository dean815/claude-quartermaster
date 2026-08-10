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

import type { SettingsCheck, SettingsError, SettingsValidity } from '../surfaces/types.ts';
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
 * The trailing sentence DEA-147 measured. Kept as its own constant because it is the one
 * form that is a *suffix* to an otherwise ordinary message rather than a whole message.
 */
export const FIELD_IGNORED_NOTE = 'This field was ignored.';

/**
 * The messages that mean Claude Code kept the file and **ignored one field of it whole**.
 *
 * Measured on 2.1.222 and re-measured on 2.1.224, one `claude doctor` run per case with
 * `claude plugin list --json` as the oracle; the recordings are in `test/fixtures/doctor/`:
 *
 * | key | message | file applies |
 * |---|---|---|
 * | `hooks: 42`      | `…received number. This field was ignored.` | yes |
 * | `hooks: "nope"`  | `…received string. This field was ignored.` | yes |
 */
const IGNORES_THE_FIELD: readonly RegExp[] = [
  new RegExp(`${FIELD_IGNORED_NOTE.replace(/[.]/g, '\\.')}$`),
];

/**
 * The sentence's sibling, one word off it: `entry` where the other says `field`.
 *
 * Its own constant rather than a widened character class over the two, because the two
 * words are the whole distinction between the units below and a pattern reading
 * `This (field|entry) was ignored.` would erase it in the one place it is written down.
 */
export const ENTRY_IGNORED_NOTE = 'This entry was ignored.';

/**
 * The messages that mean Claude Code kept the file **and dropped one named entry of a
 * record inside it**, leaving that record's other entries -- and the file -- in force.
 *
 * Measured on 2.1.224, one `claude doctor` run per case with `claude plugin list --json`
 * as the oracle; both recordings are in `test/fixtures/doctor/`:
 *
 * | key | message | file applies |
 * |---|---|---|
 * | `hooks.PreToolUse: 42` | `Hook event "PreToolUse" must be an array of matchers; received number. This entry was ignored.` | yes |
 * | `extraKnownMarketplaces.<id>.source: "github"` | `Invalid marketplace entry was ignored: source: Invalid input: expected object, received string` | yes |
 *
 * **A third unit, and it is added without a number (DEA-152).** `field` and `elements`
 * each know what they cost -- the value that failed the schema, or `n` array elements the
 * reader can still count. What a dropped hook event or a dropped marketplace costs is
 * *unmeasured*: nothing here establishes what depends on either, and a plugin whose
 * marketplace entry died is not something this repo has looked for. So the finding names
 * the key and prints no figure. Shipping one would price the entry at whatever else the
 * file happens to hold, which is DEA-147's generalisation arriving a third time -- and the
 * issue that added these patterns says so in its own description.
 *
 * The marketplace message is matched on its literal noun rather than as a template over
 * one. `REMOVES_ARRAY_ELEMENTS` generalises because three keys were measured producing one
 * sentence; here one key was, so `Invalid \w+ entry was ignored` would be a guess about
 * prose nobody has seen. Narrow errs towards `not-checked`, which is the direction this
 * classifier already errs in.
 *
 * The failing sub-path is inside the message (`source:`) and not in the key, and it stays
 * there: `doctor` names the key as `extraKnownMarketplaces.<id>` and that is what the
 * finding reports. Parsing the sub-path back out would be a second schema-shaped guess
 * about a schema this repo does not own.
 */
const IGNORES_THE_ENTRY: readonly RegExp[] = [
  new RegExp(`${ENTRY_IGNORED_NOTE.replace(/[.]/g, '\\.')}$`),
  /^Invalid marketplace entry was ignored: /,
];

/**
 * The messages that mean Claude Code kept the file **and removed elements from an array
 * inside it**, leaving the rest of that array in force.
 *
 * | key | message | file applies |
 * |---|---|---|
 * | `permissions.deny: [1,2,"Bash"]` | `Non-string value in deny array was removed`  | yes |
 * | `permissions.allow: [1,…]`       | `Non-string value in allow array was removed` | yes |
 * | `permissions.ask: [{},…]`        | `Non-string value in ask array was removed`   | yes |
 *
 * Written as a template because it *is* one -- three keys, one sentence, and the key name
 * is the only thing that varies. Matching the literal three would be pinning an accident
 * of which keys were probed.
 *
 * **Split from the sentence above rather than listed beside it (DEA-149).** Both mean the
 * file applies, so validity cannot tell them apart and does not need to; what differs is
 * what the error *cost*, and the two units are not the same thing counted differently. A
 * field is gone; an array lost `n` of its elements and kept the rest. One `doctor` entry
 * covers however many elements were removed -- three removals print one line -- so nothing
 * downstream can recover the number from the message, and a detector that reported one
 * unit for both would have to charge the whole file for either.
 */
const REMOVES_ARRAY_ELEMENTS: readonly RegExp[] = [
  /^Non-string value in \w+ array was removed$/,
];

/**
 * The messages that mean Claude Code **refused the file**. Same run, same oracle.
 *
 * | key | message | file applies |
 * |---|---|---|
 * | `permissions: 42`                     | `Expected object, but received number`  | no |
 * | `permissions.deny: "Bash"`            | `Expected array, but received string`   | no |
 * | `skillOverrides: 42`                  | `Expected record, but received number`  | no |
 * | `extraKnownMarketplaces.<id>.source`  | `Expected object, but received string`  | no |
 * | `permissions.defaultMode: 7`          | `Invalid value. Expected one of: …`     | no |
 *
 * Four of the five are one schema-validator template with the two type names varying, so
 * again the template and not the instances.
 */
const REFUSES_THE_FILE: readonly RegExp[] = [
  /^Expected \S+, but received \S+$/,
  /^Invalid value\. Expected one of: /,
];

/**
 * Refusals recognised **only under a named key** (DEA-153).
 *
 * `Invalid input` is a schema validator's generic fallback with no noun in it, so unlike
 * every pattern above it says nothing about what failed or what happened next. Measured on
 * 2.1.224 across 27 malformed shapes, one scratch project each, `claude plugin list --json`
 * as the oracle: the whole message is exactly `Invalid input` under `enabledPlugins.<id>`
 * and **nowhere else**, for four different malformations of the value -- `42`, `"true"`,
 * `{}`, `null` -- and every one refuses the file whole. No key produced it on a file that
 * survived.
 *
 * **Keyed rather than added to `REFUSES_THE_FILE`, because 27 shapes is evidence about one
 * key and not about the message.** That is DEA-152's own standard, applied to the case that
 * tempts hardest: the fix is two words away and the bug it closes is live. A bare pattern
 * would classify `file` under keys nobody has probed, and if any of those partially accepts
 * the result is a fabricated high-severity finding about working config -- DEA-147's
 * failure, which DEA-151 made the default to prevent.
 *
 * It is not a hypothetical collision either. These two words already appear on the *other*
 * side of this classifier, inside 2.1.224's marketplace message:
 *
 *     Invalid marketplace entry was ignored: source: Invalid input: expected object, received string
 *
 * That file applies. Only the `^...$` anchoring keeps the two apart, and anchoring is a
 * property of this pattern rather than of the prose -- first-party is free to print the
 * bare form under a key that survives, and on that day a keyless match is wrong in the
 * expensive direction while this one merely goes back to `unknown`.
 *
 * The cost is the one DEA-152 weighed and accepted: a fourth open set, and a patch per key
 * rather than per message. The day it fails: a release that emits `Invalid input` under a
 * *second* refusing key reads `not-checked` until someone probes it -- narrow, which is the
 * safe direction, and still a lost detection.
 *
 * The prefix is `enabledPlugins.` and not an equality: the printed key carries the plugin
 * id, which holds `@` and `.` of its own (`enabledPlugins.bogus@nowhere`).
 */
const REFUSES_UNDER_KEY: readonly { readonly keyPrefix: string; readonly message: RegExp }[] = [
  { keyPrefix: 'enabledPlugins.', message: /^Invalid input$/ },
];

/**
 * What one error cost, and `unknown` when this classifier has never seen the message.
 *
 * **Two open lists, and only one of them may be the default (DEA-151).** Both families
 * are first-party prose that can grow in any release -- they already have: DEA-147
 * recognised one member of the first list and made `discarded` the default for
 * everything else, and the second member of that same list took a file Claude Code
 * applies to `discarded`, dropped its links out of the resolver, and fired a
 * high-severity finding about live config.
 *
 * So the question is not which list to enumerate but which way to be wrong when a new
 * message appears, and the two are not symmetric:
 *
 * - defaulting to `file` fabricates a detection, on a file that is fine, and calls it high
 *   severity -- the cry-wolf failure DEA-123 and DEA-147 both exist to prevent;
 * - defaulting to `unknown` costs a detection on a file that really is dead, which is the
 *   original incident -- but the file keeps behaving exactly as it did before any of this
 *   existed, and `not-checked` carrying errors is a state nothing else produces, so the
 *   run can and does print it.
 *
 * One of those is recoverable by reading the run's own output. The other tells the user
 * their working configuration is dead.
 *
 * **The lists grow, and growing them is the maintenance this buys (DEA-152).** Three
 * releases in four days moved one of these strings, and two partial acceptances arrived
 * that this recognised as neither: `This entry was ignored.` and 2.1.224's marketplace
 * message. They cost nothing while unrecognised -- both files stayed `not-checked` and
 * both were named in the run's own output -- which is the default working, and they were
 * added on evidence, one recording each, rather than by widening a pattern to cover a
 * shape nobody had seen.
 *
 * **Why not ask the oracle instead.** `claude plugin list --json` reports *resolved*
 * plugin state for a working directory, so it can only answer "did this file apply" for a
 * file whose removal from the chain would move some plugin's resolved value. Measured
 * over this machine's 38 project settings files, that is **7** -- 22 of the other 31 name
 * no plugin at all, and no number of spawns gives the oracle something to read in a file
 * that decides only `permissions` or only `.mcp.json` servers.
 *
 * That was the coverage argument, and DEA-152 measured it too generous: for *this* family
 * the oracle is not a weak signal, it is a signal for a different question. **Under partial
 * acceptance the file always applies**, so "did this file apply" is `true` for every member
 * and can never say which part died. Checked against all four known partial-acceptance
 * messages -- `hooks` whole-field, `hooks.<Event>`, `permissions.{deny,allow,ask}`
 * elements, `extraKnownMarketplaces.<id>` -- **none** is observable through it; the last was
 * measured directly, two scratch projects differing only in that key, and the output was
 * byte-identical at 15,463 bytes both ways because the plugin resolves from user scope
 * regardless. So the reading is not a cheap stand-in for a measurement anyone could take.
 * It is the only thing that answers this question at all.
 */
function costOf(key: string, message: string): SettingsError['costs'] {
  if (IGNORES_THE_FIELD.some((re) => re.test(message))) return 'field';
  if (IGNORES_THE_ENTRY.some((re) => re.test(message))) return 'entry';
  if (REMOVES_ARRAY_ELEMENTS.some((re) => re.test(message))) return 'elements';
  if (REFUSES_THE_FILE.some((re) => re.test(message))) return 'file';
  // Last, and keyed. A message this specific carries no noun of its own, so it is placed
  // by where it appeared rather than by what it says -- see `REFUSES_UNDER_KEY`. Tested
  // after the keyless families so a future release that gives it a real sentence is
  // matched on the sentence, not on the key it happened to be measured under.
  if (REFUSES_UNDER_KEY.some((r) => key.startsWith(r.keyPrefix) && r.message.test(message))) {
    return 'file';
  }
  return 'unknown';
}

/**
 * The costs that leave the file applying. Named once, because `validityOf` asks "did the
 * file survive" and must keep answering yes for every member of the partial-acceptance
 * family -- a member added to `costOf` and forgotten here would take a live file to
 * `not-checked`, which is quiet but still a lost detection. `entry` is the third, and
 * `test/validity.test.ts` asserts each of them separately for that reason.
 */
const PARTIAL_ACCEPTANCE: ReadonlySet<SettingsError['costs']> = new Set([
  'field',
  'entry',
  'elements',
]);

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
      const key = rest.slice(0, colon);
      out.push({
        path,
        key,
        message,
        notes: [],
        costs: costOf(key, message),
      });
      continue;
    }

    // An indented continuation belongs to the entry above it. `costs` is not recomputed
    // over it: every form was measured on the message line, and letting a `Suggested fix:`
    // line supply one would make position irrelevant and widen the match on a guess. Two
    // of the recorded whole-file cases carry such a line, so this is load-bearing.
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
 *
 * The combination is a lattice, not a vote. One confirmed whole-file failure settles it
 * whatever else the file collected, because the file is gone and its other errors are
 * moot. Otherwise every error has to say the file survived for the file to count as
 * surviving: a single unrecognised message beside a recognised `field` one leaves the
 * question open, and open is `not-checked`.
 */
export function validityOf(errors: readonly SettingsError[]): SettingsValidity {
  if (!errors.length) return 'accepted';
  if (errors.some((e) => e.costs === 'file')) return 'discarded';
  return errors.every((e) => PARTIAL_ACCEPTANCE.has(e.costs)) ? 'field-dropped' : 'not-checked';
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
 *
 * **The errors travel with the verdict (DEA-148).** This used to return the verdict
 * alone, which was everything the resolver needed and nothing a *finding* needs: a
 * report naming a discarded file without naming the key that discarded it sends the
 * user back to run the command whose output is already in this function's argument.
 * Widening it here rather than parsing twice keeps validity at one `doctor` spawn per
 * project, which is the only reason it can sit behind `--full` at all.
 */
export function settingsFromDoctor(
  text: string,
  covered: readonly string[],
): Map<string, SettingsCheck> {
  const byPath = new Map<string, SettingsError[]>();
  for (const e of parseInvalidSettings(text)) {
    byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  }

  const out = new Map<string, SettingsCheck>();
  for (const path of covered) out.set(path, { validity: 'accepted', schemaErrors: [] });
  for (const [path, errors] of byPath) {
    out.set(path, { validity: validityOf(errors), schemaErrors: errors });
  }
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
export function doctorSettingsValidity(): (dir: string) => ReadonlyMap<string, SettingsCheck> {
  const empty: ReadonlyMap<string, SettingsCheck> = new Map();
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
