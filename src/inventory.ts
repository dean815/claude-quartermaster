/**
 * What a source *says* a plugin contains, against what is installed on disk.
 *
 * Two first-party sources enumerate plugin components. `claude plugin details` reads
 * the installed build, so it describes what is actually there. `plugin-catalog-cache.json`
 * describes whatever build the marketplace published when the cache was last fetched,
 * which is a different thing and drifts silently: a plugin can be republished under the
 * same version string, so nothing about the version number reveals the difference.
 *
 * Only one direction of disagreement is reported: a name the source enumerates for
 * which no file of that name exists under `installPath`. The reverse -- a SKILL.md on
 * disk that no source names -- is not evidence of anything, because a plugin's install
 * tree also holds files that were never components. `vercel@claude-plugins-official`
 * ships eight SKILL.md files under `.claude/skills/` that are its own repo tooling, and
 * `figma` ships two more under `workflow-skills/`; neither set loads, and telling them
 * apart from real components means reimplementing component discovery, which is exactly
 * what this project delegates rather than duplicates.
 *
 * The search is deliberately generous -- the whole install tree, dot-directories
 * included -- because that makes a hit conservative. A name absent from even this
 * search is genuinely absent.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

/** One source's claim about a plugin's contents. */
export interface SourceEnumeration {
  /** The file it came from, named so a reader can go and check it. */
  source: string;
  names: string[];
  /** The build the source describes. Differs from the installed sha when stale. */
  sha: string | null;
  version: string | null;
  /** When the source was last refreshed, when it records that. */
  fetchedAt: string | null;
}

export interface PluginInventory {
  id: string;
  installPath: string | null;
  version: string | null;
  sha: string | null;
  /**
   * Component names found under `installPath`. `null` means the directory could not be
   * read, which is "unknown" and never "nothing installed" -- the difference decides
   * whether a plugin counts as compared at all.
   */
  installed: string[] | null;
  /** Sources covering this plugin. Empty when none does. */
  enumerated: SourceEnumeration[];
}

export interface InstalledBuild {
  id: string;
  installPath: string;
  version: string | null;
  sha: string | null;
}

/**
 * Directories that never hold plugin components but are expensive to walk. `.in_use`
 * carries one file per live session and reaches into the hundreds.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.in_use']);

/** Deep enough for `skills/<group>/<name>/SKILL.md`, shallow enough to stay cheap. */
const MAX_DEPTH = 5;

/**
 * Every component name present under an install tree.
 *
 * A name is present if a directory of that name holds a `SKILL.md`, or a `.md` file
 * carries it. That covers skills, commands and agents without deciding which of the
 * three anything is -- the question here is only whether the named thing exists.
 */
export function componentNames(installPath: string): string[] | null {
  const found = new Set<string>();

  const walk = (dir: string, depth: number): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.name === 'SKILL.md') {
        found.add(basename(dir));
      } else if (e.name.endsWith('.md')) {
        found.add(e.name.slice(0, -'.md'.length));
      }
    }
    return true;
  };

  // Only the root failing to read means "unknown". An unreadable directory deeper in is
  // a partial answer, and a partial answer would make absence look proven when it is not.
  if (!walk(installPath, 0)) return null;
  return [...found].sort();
}

/** `installed_plugins.json` -> one build per plugin id. */
export function installedBuilds(raw: unknown): Map<string, InstalledBuild> {
  const out = new Map<string, InstalledBuild>();
  const plugins = (raw as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') return out;

  for (const [id, records] of Object.entries(plugins)) {
    if (!Array.isArray(records)) continue;
    // A plugin can carry several build records; the last is the current one.
    const r = records.at(-1) as
      | { installPath?: unknown; version?: unknown; gitCommitSha?: unknown }
      | undefined;
    if (!r || typeof r.installPath !== 'string' || !r.installPath) continue;
    out.set(id, {
      id,
      installPath: r.installPath,
      version: typeof r.version === 'string' ? r.version : null,
      sha: typeof r.gitCommitSha === 'string' ? r.gitCommitSha : null,
    });
  }
  return out;
}

/**
 * `plugin-catalog-cache.json` -> what it enumerates per plugin.
 *
 * Skills, commands and agents are flattened into one name list on purpose: the
 * comparison asks whether a named thing is installed, and a component that moved from
 * `commands/` to `skills/` between builds has not gone missing.
 */
export function catalogEnumerations(raw: unknown, source: string): Map<string, SourceEnumeration> {
  const out = new Map<string, SourceEnumeration>();
  const root = raw as { fetchedAt?: unknown; catalog?: { plugins?: Record<string, unknown> } } | null;
  const plugins = root?.catalog?.plugins;
  if (!plugins || typeof plugins !== 'object') return out;

  const fetchedAt = typeof root?.fetchedAt === 'string' ? root.fetchedAt : null;

  for (const [id, entry] of Object.entries(plugins)) {
    const e = entry as {
      components?: Record<string, unknown>;
      sha?: unknown;
      version?: unknown;
    } | null;
    if (!e || typeof e !== 'object') continue;

    const names: string[] = [];
    for (const kind of ['skills', 'commands', 'agents'] as const) {
      const list = e.components?.[kind];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const name = typeof item === 'string' ? item : (item as { name?: unknown })?.name;
        if (typeof name === 'string' && name) names.push(name);
      }
    }
    if (!names.length) continue;

    out.set(id, {
      source,
      names,
      sha: typeof e.sha === 'string' ? e.sha : null,
      version: typeof e.version === 'string' ? e.version : null,
      fetchedAt,
    });
  }
  return out;
}

const CATALOG_FILE = 'plugin-catalog-cache.json';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Absent or malformed. Every plugin then reads as uncomparable, which is the
    // honest answer -- a missing catalog proves nothing about any install.
    return null;
  }
}

/**
 * The whole comparison, read off disk.
 *
 * Deliberately not routed through `claude plugin list --json`: `installed_plugins.json`
 * already carries `installPath`, `version` and `gitCommitSha` together, so this costs
 * one file read instead of a subprocess and works with no CLI present.
 */
export function readInventories(home: string): Map<string, PluginInventory> {
  const dir = join(home, '.claude', 'plugins');
  const builds = installedBuilds(readJson(join(dir, 'installed_plugins.json')));
  const catalog = catalogEnumerations(readJson(join(dir, CATALOG_FILE)), CATALOG_FILE);

  const out = new Map<string, PluginInventory>();
  for (const [id, build] of builds) {
    const entry = catalog.get(id);
    out.set(id, {
      id,
      installPath: build.installPath,
      version: build.version,
      sha: build.sha,
      installed: componentNames(build.installPath),
      enumerated: entry ? [entry] : [],
    });
  }
  return out;
}
