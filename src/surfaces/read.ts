/**
 * Reading the config surfaces off disk.
 *
 * Every reader is total: a missing file is `null`, and a malformed one is recorded and
 * skipped rather than thrown. An audit that dies on one bad JSON file is useless
 * precisely when it is most needed.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import type {
  SettingsFile,
  McpJsonFile,
  ClaudeJson,
  ProjectRecord,
  Workspace,
  RuleFile,
  MemoryIndex,
  ProjectEntry,
  McpServerSpec,
  PersonalSkill,
} from './types.ts';
import type { SkillValue } from '../model.ts';

/** Files that could not be parsed, surfaced in the report rather than thrown. */
export interface ReadProblem {
  path: string;
  message: string;
}

export const problems: ReadProblem[] = [];

function readJsonSafe(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    problems.push({ path, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const SETTINGS_KNOWN = new Set([
  'enabledPlugins',
  'skillOverrides',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'permissions',
]);

export function readSettings(path: string): SettingsFile | null {
  const raw = readJsonSafe(path);
  if (!raw) return null;

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!SETTINGS_KNOWN.has(k)) rest[k] = v;

  return {
    path,
    ...(raw.enabledPlugins ? { enabledPlugins: raw.enabledPlugins } : {}),
    ...(raw.skillOverrides ? { skillOverrides: raw.skillOverrides as Record<string, SkillValue> } : {}),
    ...(raw.enabledMcpjsonServers ? { enabledMcpjsonServers: raw.enabledMcpjsonServers } : {}),
    ...(raw.disabledMcpjsonServers ? { disabledMcpjsonServers: raw.disabledMcpjsonServers } : {}),
    ...(raw.permissions ? { permissions: raw.permissions } : {}),
    rest,
  };
}

export function readMcpJson(path: string): McpJsonFile | null {
  const raw = readJsonSafe(path);
  if (!raw) return null;
  // The file parsed, so it exists; a stat that nonetheless fails leaves the field off
  // rather than substituting a time, because a wrong date reads as a measurement.
  let modifiedAt: number | undefined;
  try {
    modifiedAt = statSync(path).mtimeMs;
  } catch {
    modifiedAt = undefined;
  }
  return {
    path,
    ...(modifiedAt === undefined ? {} : { modifiedAt }),
    mcpServers: (raw.mcpServers ?? {}) as Record<string, McpServerSpec>,
  };
}

export function readClaudeJson(path: string): ClaudeJson {
  const raw = readJsonSafe(path) ?? {};
  return {
    path,
    numStartups: raw.numStartups,
    mcpServers: raw.mcpServers ?? {},
    projects: (raw.projects ?? {}) as Record<string, ProjectEntry>,
    // Guarded rather than defaulted, because this one is iterated: a key holding
    // something other than an array would throw where `?? []` would not have.
    claudeAiMcpEverConnected: Array.isArray(raw.claudeAiMcpEverConnected)
      ? (raw.claudeAiMcpEverConnected as string[])
      : [],
    skillUsage: raw.skillUsage ?? {},
    pluginUsage: raw.pluginUsage ?? {},
  };
}

/**
 * `paths:` frontmatter is the whole point of a rule file -- with it, the rule loads
 * only when Claude touches a matching file; without it, it loads every session.
 */
export function readRule(path: string): RuleFile {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const paths: string[] = [];

  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    const frontmatter = lines.slice(1, end === -1 ? lines.length : end);
    const idx = frontmatter.findIndex((l) => /^paths\s*:/.test(l));
    if (idx !== -1) {
      const inline = frontmatter[idx]!.replace(/^paths\s*:/, '').trim();
      if (inline.startsWith('[')) {
        paths.push(
          ...inline
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean),
        );
      } else if (inline) {
        paths.push(inline.replace(/^["']|["']$/g, ''));
      }
      for (const l of frontmatter.slice(idx + 1)) {
        const m = /^\s*-\s*(.+)$/.exec(l);
        if (!m) break;
        paths.push(m[1]!.trim().replace(/^["']|["']$/g, ''));
      }
    }
  }

  return { path, paths, bytes: Buffer.byteLength(text), lines: lines.length };
}

export function readRulesDir(dir: string): RuleFile[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readRule(join(dir, f)));
  } catch (err) {
    problems.push({ path: dir, message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Skills installed for the user, one directory each.
 *
 * `statSync` rather than the dirent's own `isDirectory()`, and the difference is nine
 * skills. Cyrus installs its set as symlinks into `~/.agents/skills/`; a dirent reports
 * those as symlinks and not directories, so trusting it drops them and reports 79 where
 * 88 load. `statSync` follows the link, which is what Claude Code does when it reads
 * the directory.
 *
 * A directory without a `SKILL.md` is not a skill -- `context-audit-workspace` is a
 * scratch directory that lives among them.
 */
export function readPersonalSkills(home: string): PersonalSkill[] {
  const dir = join(home, '.claude', 'skills');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const out: PersonalSkill[] = [];
  for (const id of names) {
    const path = join(dir, id, 'SKILL.md');
    try {
      if (!statSync(join(dir, id)).isDirectory() || !existsSync(path)) continue;
    } catch {
      continue; // A broken symlink names nothing that loads.
    }
    out.push({ id, path });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Auto-memory lives under a slug of the project's absolute path. */
export function memorySlug(projectPath: string): string {
  return projectPath.replaceAll('/', '-');
}

const MEMORY_LINE_LIMIT = 200;
const MEMORY_BYTE_LIMIT = 25 * 1024;

export function readMemory(home: string, projectPath: string): MemoryIndex | null {
  const path = join(home, '.claude', 'projects', memorySlug(projectPath), 'memory', 'MEMORY.md');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const bytes = Buffer.byteLength(text);
  const lines = text.split('\n').length;
  return {
    path,
    bytes,
    lines,
    overLineLimit: lines > MEMORY_LINE_LIMIT,
    overByteLimit: bytes > MEMORY_BYTE_LIMIT,
  };
}

/** `@path` imports load at launch, so they never save context. Detected, not followed. */
const IMPORT_RE = /(?:^|\s)@([\w./~@-]+)/gm;

export function readClaudeMd(path: string) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const withoutCode = text.replace(/```[\s\S]*?```/g, '');
  const imports = [...withoutCode.matchAll(IMPORT_RE)].map((m) => m[1]!);
  return {
    path,
    bytes: Buffer.byteLength(text),
    lines: text.split('\n').length,
    imports: [...new Set(imports)],
  };
}

export interface LoadOptions {
  home?: string;
  /** Override `~/.claude.json`, `~/.claude/` -- used to load the local snapshot. */
  claudeJsonPath?: string;
  userSettingsPath?: string;
  /** Map a recorded project path to where its files actually live (fixtures). */
  projectPathResolver?: (recordedPath: string) => string | null;
  /**
   * Directories to include even though `~/.claude.json` has never heard of them.
   *
   * A brand-new project is not registered until Claude Code has run there, so
   * auditing one before that point requires saying so explicitly. Without this, a
   * `--project` pointing at a fresh directory silently fell through to a
   * whole-workspace audit.
   */
  extraProjectPaths?: readonly string[];
}

export function loadWorkspace(opts: LoadOptions = {}): Workspace {
  const home = opts.home ?? homedir();
  const claudeJson = readClaudeJson(opts.claudeJsonPath ?? join(home, '.claude.json'));
  const userSettings = readSettings(
    opts.userSettingsPath ?? join(home, '.claude', 'settings.json'),
  );
  const userRules = readRulesDir(join(home, '.claude', 'rules'));
  const personalSkills = readPersonalSkills(home);

  const projects: ProjectRecord[] = [];
  for (const [recordedPath, entry] of Object.entries(claudeJson.projects)) {
    const dir = opts.projectPathResolver
      ? opts.projectPathResolver(recordedPath)
      : recordedPath;

    if (dir === null) {
      projects.push(deadProject(recordedPath, entry));
      continue;
    }

    const alive = existsSync(dir) && statSync(dir).isDirectory();
    if (!alive) {
      projects.push(deadProject(recordedPath, entry));
      continue;
    }

    projects.push({
      path: recordedPath,
      alive: true,
      registered: true,
      settings: readSettings(join(dir, '.claude', 'settings.json')),
      localSettings: readSettings(join(dir, '.claude', 'settings.local.json')),
      mcpJson: readMcpJson(join(dir, '.mcp.json')),
      entry,
      rules: readRulesDir(join(dir, '.claude', 'rules')),
      memory: readMemory(home, recordedPath),
      claudeMd: readClaudeMd(join(dir, 'CLAUDE.md')),
    });
  }

  // Directories asked for by name that the registry has never seen. A project with no
  // entry is the "brand-new project" case, and its emptiness is the finding.
  const known = new Set(projects.map((p) => p.path));
  for (const dir of opts.extraProjectPaths ?? []) {
    const abs = resolvePath(dir);
    if (known.has(abs)) continue;
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    projects.push({
      path: abs,
      alive: true,
      registered: false,
      settings: readSettings(join(abs, '.claude', 'settings.json')),
      localSettings: readSettings(join(abs, '.claude', 'settings.local.json')),
      mcpJson: readMcpJson(join(abs, '.mcp.json')),
      entry: null,
      rules: readRulesDir(join(abs, '.claude', 'rules')),
      memory: readMemory(home, abs),
      claudeMd: readClaudeMd(join(abs, 'CLAUDE.md')),
    });
  }

  return { home, userSettings, userRules, personalSkills, claudeJson, projects };
}

function deadProject(path: string, entry: ProjectEntry): ProjectRecord {
  return {
    path,
    alive: false,
    registered: true,
    settings: null,
    localSettings: null,
    mcpJson: null,
    entry,
    rules: [],
    memory: null,
    claudeMd: null,
  };
}

export { resolvePath };
