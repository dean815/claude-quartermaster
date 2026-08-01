/**
 * On-disk cache for `claude plugin details` lookups.
 *
 * Each lookup is a ~0.6s process spawn, and 42 installed plugins make that a 25s wait
 * on every run. Cost is a property of a plugin version, so it is cached under
 * `<id>@<version>` and only re-fetched when a plugin updates.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import type { PluginCost } from './cost/plugins.ts';

const CACHE_VERSION = 1;

interface CacheFile {
  version: number;
  entries: Record<string, PluginCost>;
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

  private key(id: string, version: string | null): string {
    return `${id}@${version ?? 'unknown'}`;
  }

  get(id: string, version: string | null): PluginCost | undefined {
    return this.entries[this.key(id, version)];
  }

  set(id: string, version: string | null, cost: PluginCost): void {
    this.entries[this.key(id, version)] = cost;
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
