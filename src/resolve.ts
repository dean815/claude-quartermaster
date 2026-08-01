/**
 * Applying the model to a workspace.
 *
 * `model.ts` holds the algebra; this file decides which files contribute a link to
 * which chain. The two are kept apart so the precedence rules can be tested without
 * touching a disk.
 */
import {
  resolveCell,
  type Cell,
  type ChainLink,
  type Scope,
  type SkillValue,
} from './model.ts';
import type { ProjectRecord, SettingsFile, Workspace } from './surfaces/types.ts';

/**
 * The settings files that can decide a key for one project, ascending by precedence.
 *
 * The dedup is load-bearing. When Claude Code runs in the home directory, `~` is a
 * project whose `.claude/settings.json` *is* `~/.claude/settings.json` -- one file
 * serving two scopes. Counted twice, every globally-enabled plugin would resolve as
 * `restated`, and the audit would open with 42 fabricated findings. A file
 * contributes once, at its lowest applicable precedence.
 */
function contributingFiles(
  ws: Workspace,
  project: ProjectRecord,
): Array<{ scope: Scope; file: SettingsFile }> {
  const out: Array<{ scope: Scope; file: SettingsFile }> = [];
  const seen = new Set<string>();

  const push = (scope: Scope, file: SettingsFile | null) => {
    if (!file || seen.has(file.path)) return;
    seen.add(file.path);
    out.push({ scope, file });
  };

  push('user', ws.userSettings);
  push('project', project.settings);
  push('local', project.localSettings);
  return out;
}

function chainFrom<V>(
  ws: Workspace,
  project: ProjectRecord,
  extract: (file: SettingsFile) => V | undefined,
): ChainLink<V>[] {
  const links: ChainLink<V>[] = [];
  for (const { scope, file } of contributingFiles(ws, project)) {
    const value = extract(file);
    if (value !== undefined) links.push({ scope, value, source: file.path });
  }
  return links;
}

/** A plugin loads unless something says otherwise, and nothing says so by default. */
export function resolvePlugin(
  ws: Workspace,
  project: ProjectRecord,
  pluginId: string,
): Cell<boolean> {
  return resolveCell(
    chainFrom(ws, project, (f) => f.enabledPlugins?.[pluginId]),
    false,
  );
}

/** Skills default to `on` -- an absent override means fully listed. */
export function resolveSkill(
  ws: Workspace,
  project: ProjectRecord,
  skillId: string,
): Cell<SkillValue> {
  return resolveCell<SkillValue>(
    chainFrom(ws, project, (f) => f.skillOverrides?.[skillId]),
    'on',
  );
}

/**
 * MCP servers do not follow settings precedence.
 *
 * `disabledMcpServers` is a flat deny-list stored per project inside `~/.claude.json`
 * -- a project-scoped decision living in a user-scoped file. Project-declared servers
 * from `.mcp.json` are switched by `enabled/disabledMcpjsonServers`, which *are*
 * ordinary settings keys. Both feed one chain so the cell reads the same as any other.
 */
export function resolveMcpServer(
  ws: Workspace,
  project: ProjectRecord,
  serverName: string,
): Cell<boolean> {
  const links: ChainLink<boolean>[] = [];

  // Available at user scope if `~/.claude.json` declares it.
  if (serverName in ws.claudeJson.mcpServers) {
    links.push({ scope: 'user', value: true, source: ws.claudeJson.path });
  }

  // Declared by the project itself.
  if (project.mcpJson && serverName in project.mcpJson.mcpServers) {
    links.push({ scope: 'project', value: true, source: project.mcpJson.path });
  }

  // The per-project deny-list. Highest-signal surface, and the easiest to forget.
  if (project.entry?.disabledMcpServers?.includes(serverName)) {
    links.push({ scope: 'project', value: false, source: ws.claudeJson.path });
  }
  if (project.entry?.enabledMcpServers?.includes(serverName)) {
    links.push({ scope: 'project', value: true, source: ws.claudeJson.path });
  }

  // `.mcp.json` servers are gated by ordinary settings keys, so they honour precedence.
  for (const { scope, file } of contributingFiles(ws, project)) {
    if (file.disabledMcpjsonServers?.includes(serverName)) {
      links.push({ scope, value: false, source: file.path });
    }
    if (file.enabledMcpjsonServers?.includes(serverName)) {
      links.push({ scope, value: true, source: file.path });
    }
  }

  return resolveCell(links, false);
}

/** Every plugin id mentioned by any settings file in the workspace. */
export function allPluginIds(ws: Workspace): string[] {
  const ids = new Set<string>();
  const collect = (f: SettingsFile | null) => {
    if (f?.enabledPlugins) for (const id of Object.keys(f.enabledPlugins)) ids.add(id);
  };
  collect(ws.userSettings);
  for (const p of ws.projects) {
    collect(p.settings);
    collect(p.localSettings);
  }
  return [...ids].sort();
}

/** Every skill id any settings file expresses an opinion about. */
export function allSkillIds(ws: Workspace): string[] {
  const ids = new Set<string>();
  const collect = (f: SettingsFile | null) => {
    if (f?.skillOverrides) for (const id of Object.keys(f.skillOverrides)) ids.add(id);
  };
  collect(ws.userSettings);
  for (const p of ws.projects) {
    collect(p.settings);
    collect(p.localSettings);
  }
  return [...ids].sort();
}

/** Every MCP server name reachable from any surface. */
export function allMcpServerNames(ws: Workspace): string[] {
  const names = new Set<string>(Object.keys(ws.claudeJson.mcpServers));
  for (const p of ws.projects) {
    if (p.mcpJson) for (const n of Object.keys(p.mcpJson.mcpServers)) names.add(n);
    for (const n of p.entry?.disabledMcpServers ?? []) names.add(n);
    for (const n of p.entry?.enabledMcpServers ?? []) names.add(n);
  }
  return [...names].sort();
}
