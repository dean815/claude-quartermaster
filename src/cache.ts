/**
 * On-disk cache for `claude plugin details` lookups.
 *
 * Each lookup is a ~0.6s process spawn, and 42 installed plugins make that a 25s wait
 * on every run. Cost is a property of a specific plugin *build*, not just its version
 * string -- two builds can share a version and differ in components (DEA-128) -- so it
 * is cached under `<id>@<version>@<sha>` and only re-fetched when the build moves.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import type { PluginCost } from './cost/plugins.ts';

/**
 * Bump whenever a parser change alters what gets stored, not just when the file
 * shape changes. v1 cached `null` for every plugin costing a thousand tokens or more,
 * because the parser produced NaN for comma-formatted numbers (DEA-109); fixing the
 * parser alone would have left those wrong values in place on any machine that had
 * already run an audit. v2 keyed on `<id>@<version>`, which collides when two builds
 * share a version string (DEA-128), so a stale entry survived `claude plugin update`;
 * v3 added the sha to the key. But only 18 of 42 installed plugins carry a
 * `gitCommitSha` -- the other 24 keyed as `<id>@<version>@unknown`, reproducing the
 * same collision v3 was meant to close (DEA-131). v4 falls back to `lastUpdated`,
 * present on every record, so the build component is never `unknown`; any v3 cache
 * must be discarded, not migrated.
 */
const CACHE_VERSION = 4;

interface CacheFile {
  version: number;
  entries: Record<string, PluginCost>;
}

/**
 * Resolve each build's `installPath` to the identifier that goes in its cache key.
 * Prefer `gitCommitSha`, which names the build directly; fall back to `lastUpdated`,
 * a recorded install timestamp that every record carries and that moves when the build
 * does (DEA-131). Only 18 of 42 installed records carry a sha, so without the fallback
 * the other 24 would key on `unknown` and reproduce the DEA-128 collision. Skips records
 * with no installPath or no usable identifier -- those degrade to version-only keys.
 */
export function buildIdsByPath(raw: unknown): Map<string, string> {
  const byPath = new Map<string, string>();
  const plugins = (raw as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') return byPath;

  for (const records of Object.values(plugins)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const r = record as {
        installPath?: unknown;
        gitCommitSha?: unknown;
        lastUpdated?: unknown;
      };
      const buildId =
        (typeof r.gitCommitSha === 'string' && r.gitCommitSha) ||
        (typeof r.lastUpdated === 'string' && r.lastUpdated) ||
        null;
      if (typeof r.installPath === 'string' && r.installPath && buildId) {
        byPath.set(r.installPath, buildId);
      }
    }
  }
  return byPath;
}

export function cachePath(): string {
  const base =
    process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
  return join(base, 'claude-quartermaster', 'plugin-costs.json');
}

export class PluginCostCache {
  private entries: Record<string, PluginCost> = {};
  private dirty = false;
  private readonly path: string;

  constructor(path: string = cachePath()) {
    this.path = path;
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
      if (parsed.version === CACHE_VERSION) this.entries = parsed.entries ?? {};
    } catch {
      // A corrupt cache is a cache miss, not an error.
    }
  }

  private key(id: string, version: string | null, sha: string | null): string {
    return `${id}@${version ?? 'unknown'}@${sha ?? 'unknown'}`;
  }

  get(id: string, version: string | null, sha: string | null): PluginCost | undefined {
    return this.entries[this.key(id, version, sha)];
  }

  set(id: string, version: string | null, sha: string | null, cost: PluginCost): void {
    this.entries[this.key(id, version, sha)] = cost;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const body: CacheFile = { version: CACHE_VERSION, entries: this.entries };
    writeFileSync(this.path, JSON.stringify(body));
    this.dirty = false;
  }

  get size(): number {
    return Object.keys(this.entries).length;
  }
}
