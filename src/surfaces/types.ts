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
 * The day it fails: the only observable discriminator between the two error classes is
 * the trailing sentence `This field was ignored.`, which is Claude Code's own prose and
 * carries no version guarantee. It can change in any release, and the day it does every
 * `field-dropped` file classifies `discarded` -- so `parseInvalidSettings` pins that
 * string in one place and the fixture is a recording of first-party output, not a
 * restatement of the rule.
 */
export type SettingsValidity =
  /** `doctor` ran over this file and reported nothing against it. */
  | 'accepted'
  /** It reported only errors saying the field was ignored; the rest of the file applies. */
  | 'field-dropped'
  /** It reported an error carrying no such note; Claude Code drops the file entire. */
  | 'discarded'
  /** `doctor` was not run here, is not on PATH, or its output did not parse. */
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
  /** Whether `message` ends in the note. The one thing that decides the two classes. */
  fieldIgnored: boolean;
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
  /** Empty exactly when `validity` is `accepted` or `not-checked`. */
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
  /** Everything else, kept so writers in Phase 2 can round-trip without loss. */
  rest: Record<string, unknown>;
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
