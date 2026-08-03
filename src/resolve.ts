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
import type { PluginInventory } from './inventory.ts';

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

/**
 * Every plugin id the workspace can express an opinion about.
 *
 * Settings mentions alone are not enough. A plugin installed and never toggled appears
 * in no `enabledPlugins` block, so it would be no row in the grid even though
 * `installed_plugins.json` knows the build is on disk and shares this exact
 * `name@marketplace` id space. It resolves to `false`/`inherited`, which is the true
 * answer and the one worth showing.
 *
 * Widening this changes no detector output: an unmentioned id has no project-scope link,
 * so it is never `restated`, never `overridden`, and never enabled anywhere -- each of
 * the three consumers drops it on its own first test.
 */
export function allPluginIds(
  ws: Workspace,
  inventories: ReadonlyMap<string, PluginInventory>,
): string[] {
  const ids = new Set<string>(inventories.keys());
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

/*
 * The MCP axis lives in `mcp.ts`, next to `allSkillIds` in `skills.ts` and for the same
 * reason (DEA-143): enumerating it needs sources this file does not read, and one of
 * them -- an enabled plugin's catalog entry -- needs `resolvePlugin` from this file. The
 * dependency runs one way only, which it could not if the enumerator stayed here.
 */
