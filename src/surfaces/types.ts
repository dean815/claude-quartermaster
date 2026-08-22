/**
 * Shapes of the config files on disk.
 *
 * These describe only the keys the audit reads. Claude Code writes many more, and
 * the readers preserve nothing they do not name -- an unrecognised key is not an
 * error, it is simply not our business.
 */
import type { SkillValue } from '../model.ts';

/**
 * Whether Claude Code accepts a settings file, as distinct from whether it parsed.
 *
 * A file that parses as JSON is still validated against a schema, and failing that
 * schema costs it either one key or the whole file (DEA-147). Measured against 2.1.221,
 * one `claude doctor` run per case, `claude plugin list --json` as the oracle:
 *
 * | extra key in an otherwise valid file | doctor | `enabledPlugins` applied |
 * |---|---|---|
 * | *(none)*                                | silent  | yes |
 * | `hooks: 42`                             | error   | **yes -- only the field dropped** |
 * | `extraKnownMarketplaces.<id>.source` string | error | no -- whole file voided |
 * | `permissions.deny` string               | error   | no -- whole file voided |
 *
 * So "has a schema error" is not "is discarded", and the four states are not three.
 * **Only `discarded` may remove a file's links from a precedence chain.** Reading a
 * `field-dropped` file as void reports live overrides as dead, which is DEA-123's
 * cry-wolf failure arriving from the opposite side, and `not-checked` is the *common*
 * state rather than the exception: `doctor` validates per working directory, so
 * checking N projects is N spawns and lives behind `--full`.
 *
 * `not-checked` is a value, not a default -- the `usageCount` / `SkillPresence` /
 * `keyBasis` rule. It says the measurement was never taken, and it must never be
 * rounded to either `accepted` or `discarded`.
 *
 * **Which way this errs, and why (DEA-151).** The classes are told apart by reading
 * `doctor`'s prose, and that prose is an open set: the first cut recognised one
 * partial-acceptance sentence and sent everything else to `discarded`, so the *second*
 * partial-acceptance message -- `Non-string value in deny array was removed`, which was
 * there all along -- took a live file to `discarded` and fired a high-severity finding
 * about config that applies. The rule now recognises both families explicitly and sends
 * anything it does not recognise to `not-checked`. That is the safe direction: an
 * unrecognised message costs a *detection*, visibly, where the old default fabricated
 * one. It is DEA-123's `unknown`-over-`restart` reasoning, which this axis was not
 * following -- rounding an unmeasured case to the scarier verdict is the cry-wolf
 * behaviour the classifier exists to prevent.
 *
 * The day it fails: both lists are open, and only one of them fails safe. A new
 * *whole-file* message reads `not-checked`, the file keeps its links, and DEA-148 says
 * nothing about a file that really is dead -- the original incident, silently. What
 * keeps that from being invisible is that such a file is `not-checked` *carrying schema
 * errors*, which nothing else produces, and the run prints them (`printSettingsValidity`).
 *
 * **That day arrived on the safe side, two releases later.** When this was written every
 * message form three sessions of probing had found was recognised, so `unknown` had no
 * live instance and its fixture had to be constructed. 2.1.224 supplied two: a malformed
 * hook *event* says `This entry was ignored.` -- one word off the sentence this rule pins
 * -- and `extraKnownMarketplaces.<id>.source`, the key behind the original incident, no
 * longer voids the file at all. Both were partial acceptances, both read `not-checked`, and
 * neither produced a wrong finding, which is the whole argument for the default. Recorded
 * as `hook-entry-ignored` and `mixed-known-and-unknown` in `test/fixtures/doctor/`.
 *
 * **Both are recognised as of DEA-152, and `unknown` is back to having no live instance.**
 * The recordings are unchanged and still say what they said; what changed is that this
 * release places them, as `entry` -- a third partial-acceptance unit. So the two files read
 * `field-dropped` and `droppedSettingsField` names the key in each. The state that has no
 * recording again is `not-checked` *carrying* a recognised error, and its fixture is
 * constructed and labelled as such in `test/dropped-field.test.ts`, exactly as DEA-151
 * had to construct one before 2.1.224 obliged.
 */
export type SettingsValidity =
  /** `doctor` ran over this file and reported nothing against it. */
  | 'accepted'
  /** Every error against it said Claude Code kept the file; the rest of it applies. */
  | 'field-dropped'
  /** An error against it said Claude Code refused the file; it is dropped entire. */
  | 'discarded'
  /**
   * Nothing was measured, or what was measured could not be placed: `doctor` was not run
   * here, is not on PATH, its output did not parse, or it reported a message this
   * classifier does not recognise. Never rounded to either neighbour.
   */
  | 'not-checked';

/**
 * One entry of `doctor`'s `Invalid settings` block, as it printed it.
 *
 * Lives here rather than beside the parser for the reason `SettingsValidity` does: it is
 * a property of a settings file that only `doctor` can report, and the layer that reads
 * files must be able to carry it without importing the layer that shells out.
 */
export interface SettingsError {
  /** Absolute path of the settings file, as `doctor` printed it. */
  path: string;
  /** Dotted key path -- `permissions.deny`, `extraKnownMarketplaces.<id>.source`. */
  key: string;
  /** The message after the key, verbatim and on its own line. */
  message: string;
  /** Indented continuations of that entry -- `Suggested fix: ...` -- verbatim. */
  notes: string[];
  /**
   * What this one error cost, read off `message`. The thing that decides the classes.
   *
   * Not a boolean (DEA-151). `unknown` is the message this classifier has never seen, and
   * it is a value rather than a default for the `usageCount` / `keyBasis` reason --
   * collapsing it into either neighbour is a guess wearing a measurement's clothes, and
   * collapsing it into `file` is the guess that reports live config as dead.
   *
   * **`field`, `entry` and `elements` are one class to validity and three to a report
   * (DEA-149, DEA-152).** All three leave the file applying, so `validityOf` treats them
   * alike and must; what differs is the unit the loss is measured in, and they are not one
   * thing counted three ways. A field is gone whole. An array lost `n` of its elements and
   * kept the others, with no number recoverable from the message -- `doctor` prints one
   * entry however many elements it removed. An entry of a record -- one hook event, one
   * marketplace -- is gone while its siblings and the file apply, and **what that cost has
   * never been measured**: nothing here establishes what a dropped hook event or a dropped
   * marketplace decides. A detector holding one value for all three would have only the
   * file left to count, which is the generalisation DEA-147 had to correct.
   */
  costs: 'field' | 'entry' | 'elements' | 'file' | 'unknown';
}

/**
 * One file's answer from the validator, kept whole (DEA-148).
 *
 * `validity` alone was the channel, and it threw away the only thing a finding about a
 * voided file has to print: *which key*. The two travel together because they are one
 * measurement -- for every file a run covered, `validity` is `validityOf(schemaErrors)` --
 * and a report that can name a discarded file but not its cause is a report that sends
 * the user back to `doctor` to ask what it already knew.
 */
export interface SettingsCheck {
  validity: SettingsValidity;
  /**
   * Empty whenever `validity` is `accepted`, and whenever nothing was measured at all.
   *
   * The one combination worth naming is `not-checked` **with** errors: `doctor` did
   * report on this file and none of what it said could be placed (DEA-151). Nothing else
   * produces it, so it is how a first-party message this classifier has never seen
   * becomes a visible event on the next run instead of a silent loss of detection.
   */
  schemaErrors: readonly SettingsError[];
}

/** `settings.json`, `settings.local.json`, and `~/.claude/settings.json` share a shape. */
export interface SettingsFile {
  /** Absolute path this was read from. Identity for the same-file dedup rule. */
  path: string;
  /**
   * Whether Claude Code would apply this file. Carried on the file rather than looked up
   * per consumer, because a consumer holding a `SettingsFile` has nothing left to ask.
   */
  validity: SettingsValidity;
  /**
   * What the validator said, if anything. Required and never optional, for the same
   * reason `validity` has no default: an absent list and an empty one would be the same
   * value with two meanings, and the one that matters -- "discarded, and here is the key"
   * -- is the one that would silently lose its evidence.
   */
  schemaErrors: readonly SettingsError[];
  /**
   * How many elements the reader dropped from each permission array, by dotted key --
   * `{ 'permissions.deny': 3 }`. Empty when it dropped none, which is nearly always.
   *
   * Required, and required for `schemaErrors`' reason: absent and empty would be the same
   * value with two meanings, and the one that matters is "we could not tell". The count
   * has to be carried rather than recomputed because `permissions` arrives narrowed --
   * `ruleStrings` removes the non-strings, mirroring what Claude Code does with them --
   * so by the time anything else holds this file, the elements are gone and nothing in it
   * says how many there were. `doctor` cannot supply the number either: it prints one
   * entry per array, whether it removed one element or three.
   *
   * The key is the dotted path `doctor` uses, so joining a `SettingsError` to its cost is
   * a lookup and not a translation.
   */
  droppedRuleElements: Record<string, number>;
  enabledPlugins?: Record<string, boolean>;
  skillOverrides?: Record<string, SkillValue>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
  };
}

/** A `.mcp.json` -- servers a project declares for itself. */
export interface McpJsonFile {
  path: string;
  /**
   * mtime, in epoch ms. Absent when nothing recorded one -- never assume a time.
   *
   * Read for one question (DEA-130): a server declared after the last measured session
   * cannot have appeared in it, and absence would then be chronology rather than disuse.
   * Only this file can answer it. `~/.claude.json` carries the user-scope launch specs
   * and every live session writes telemetry to it, so its mtime is always ~now and dates
   * nothing; a server declared only there stays undatable, which is an answer.
   *
   * The day it fails: an edit to any other key moves the mtime, so a long-standing
   * server in a recently-touched file reads as undatable. That errs towards saying
   * nothing, which is the direction this tool errs in everywhere else.
   */
  modifiedAt?: number;
  mcpServers: Record<string, McpServerSpec>;
}

export interface McpServerSpec {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** One `projects[<abspath>]` entry in `~/.claude.json`. */
export interface ProjectEntry {
  /** Flat deny-list. Covers connectors, `plugin:X:Y` ids, and user-scoped servers alike. */
  disabledMcpServers?: string[];
  enabledMcpServers?: string[];
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  allowedTools?: string[];
  hasTrustDialogAccepted?: boolean;
}

/** Usage counters. Semantics are NOT yet established -- see `usage.ts`. */
export interface UsageRecord {
  usageCount?: number;
  lastUsedAt?: number;
  lastUsedNumStartups?: number;
}

/** The parts of `~/.claude.json` the audit reads. */
export interface ClaudeJson {
  path: string;
  numStartups?: number;
  mcpServers: Record<string, McpServerSpec>;
  projects: Record<string, ProjectEntry>;
  /**
   * claude.ai connectors this installation has connected to, in the `claude.ai <Name>`
   * form the deny-list uses. The only on-disk trace they leave.
   *
   * Historical, and the key name says so -- read `mcp.ts` before treating it as a set
   * of servers that load today.
   */
  claudeAiMcpEverConnected: string[];
  skillUsage: Record<string, UsageRecord>;
  pluginUsage: Record<string, UsageRecord>;
}

/** A `.claude/rules/*.md` file. `paths` frontmatter is what defers its loading. */
export interface RuleFile {
  path: string;
  /** Glob patterns from `paths:` frontmatter. Empty means it loads every session. */
  paths: string[];
  bytes: number;
  lines: number;
}

/** A skill installed for the user, one directory under `~/.claude/skills/`. */
export interface PersonalSkill {
  /** Directory name. This is the id a `skillOverrides` key would use. */
  id: string;
  /** Absolute path of its `SKILL.md`. */
  path: string;
}

/** `~/.claude/projects/<slug>/memory/MEMORY.md`, loaded at the start of every session. */
export interface MemoryIndex {
  path: string;
  bytes: number;
  lines: number;
  /** Only the first 200 lines or 25KB load, whichever comes first. */
  overLineLimit: boolean;
  overByteLimit: boolean;
}

/** Everything read from disk for one project. */
export interface ProjectRecord {
  path: string;
  /** False when `~/.claude.json` still holds config for a directory that is gone. */
  alive: boolean;
  /**
   * False for a directory audited by name that `~/.claude.json` has never recorded --
   * i.e. Claude Code has not run there yet. A brand-new project, not a broken one.
   */
  registered: boolean;
  settings: SettingsFile | null;
  localSettings: SettingsFile | null;
  mcpJson: McpJsonFile | null;
  entry: ProjectEntry | null;
  rules: RuleFile[];
  memory: MemoryIndex | null;
  claudeMd: { path: string; bytes: number; lines: number; imports: string[] } | null;
}

/** The whole workspace, read once, then resolved purely. */
export interface Workspace {
  home: string;
  userSettings: SettingsFile | null;
  userRules: RuleFile[];
  /** Skills installed under `~/.claude/skills/`, whether or not anything scopes them. */
  personalSkills: PersonalSkill[];
  claudeJson: ClaudeJson;
  projects: ProjectRecord[];
}
