/**
 * Shapes of the config files on disk.
 *
 * These describe only the keys the audit reads. Claude Code writes many more, and
 * the readers preserve nothing they do not name -- an unrecognised key is not an
 * error, it is simply not our business.
 */
import type { SkillValue } from '../model.ts';

/** `settings.json`, `settings.local.json`, and `~/.claude/settings.json` share a shape. */
export interface SettingsFile {
  /** Absolute path this was read from. Identity for the same-file dedup rule. */
  path: string;
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
  claudeJson: ClaudeJson;
  projects: ProjectRecord[];
}
