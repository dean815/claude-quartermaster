/**
 * Per-plugin component cost, delegated to `claude plugin details`.
 *
 * This is not reimplemented. First-party already computes it locally -- verified
 * against `warp@claude-code-warp`, which is absent from `plugin-catalog-cache.json`
 * and still gets priced -- so it covers third-party marketplaces too.
 *
 * What it explicitly does not price is MCP. Its own output says so:
 *
 *     MCP servers (1)  github  (tool schemas resolved at runtime; not counted)
 *     Always-on:   ~0 tok
 *
 * That is a deliberate consequence of deferred schemas, and it is correct about
 * schemas. Tool *names* still load at startup, and on one measured session they were
 * 34,593 chars across 39 servers. `transcript.ts` covers what this cannot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claudeCli } from '../disclose.ts';

export interface ComponentCost {
  name: string;
  /** Rounded by the CLI to two significant figures. Treat as approximate. */
  alwaysOn: number;
  onInvoke: number;
}

export interface PluginCost {
  id: string;
  version: string | null;
  source: string | null;
  /** The headline figure. Rounded, but the most precise number on offer. */
  alwaysOnTokens: number;
  components: ComponentCost[];
  counts: Record<string, number>;
  /** Server names this plugin provides. Their cost is NOT in `alwaysOnTokens`. */
  mcpServers: string[];
  /** True when the CLI declined to price the MCP servers, which is always so far. */
  mcpUncounted: boolean;
}

/**
 * The read side of per-plugin cost.
 *
 * Deliberately narrower than `Map`. `get` is the only way to ask for a price, which
 * leaves an implementation free to defer the ~0.6s `claude plugin details` spawn until
 * something actually asks -- pricing every installed plugin up front taxed even the
 * commands that read none of them. `entries` and `size` describe what a run *has*
 * priced, not what it could price, so reading them costs nothing and the report can
 * state what was actually looked up.
 *
 * A plain `Map` satisfies this, which is what `--no-plugin-cost` and the tests pass.
 */
export interface PluginCostIndex {
  /** `null` when the lookup failed; `undefined` when nothing can price this id. */
  get(id: string): PluginCost | null | undefined;
  /** Only what has been priced so far. Iterating prices nothing. */
  entries(): Iterable<[string, PluginCost | null]>;
  /** How many prices this run has resolved. */
  readonly size: number;
}

/**
 * Integer part: either comma-grouped in threes, or plain digits. Written strictly so
 * a malformed string like `1,2,3,4` fails rather than being coerced into a number
 * nobody intended.
 */
const INT = String.raw`\d{1,3}(?:,\d{3})*|\d+`;

/** Matches the CLI's forms: `~715`, `~2.7k`, `~2,349`, `~1,234.5k`, `~0`. */
const TOKEN_COUNT = new RegExp(String.raw`^~?(${INT})(\.\d+)?\s*([km])?$`, 'i');

/**
 * `~2.7k` -> 2700, `~2,349` -> 2349, `~715` -> 715, `~0` -> 0.
 *
 * The comma case is not cosmetic: the CLI switches to thousands separators at exactly
 * the point a plugin becomes worth reporting, so a pattern without it silently drops
 * the most expensive entries and keeps the cheap ones.
 */
export function parseTokenCount(raw: string): number {
  const m = TOKEN_COUNT.exec(raw.trim());
  if (!m) return Number.NaN;
  const n = Number(m[1]!.replaceAll(',', '') + (m[2] ?? ''));
  if (!Number.isFinite(n)) return Number.NaN;
  const suffix = m[3]?.toLowerCase();
  if (suffix === 'k') return Math.round(n * 1_000);
  if (suffix === 'm') return Math.round(n * 1_000_000);
  return n;
}

const INVENTORY_LINE = /^\s{2}(Skills|Agents|Hooks|MCP servers|LSP servers)\s+\((\d+)\)\s*(.*)$/;
const ALWAYS_ON_LINE = /^\s*Always-on:\s*(\S+)\s*tok/;
const SOURCE_LINE = /^\s*Source:\s*(.+)$/;
// Component rows use the `k` suffix rather than separators today, but they carry the
// same numbers and would fail the same way if that changed -- a non-matching row is
// dropped whole, not just mis-parsed, so the tolerance is worth having here too.
const NUM = String.raw`~?(?:${INT})(?:\.\d+)?[km]?`;
const COMPONENT_ROW = new RegExp(String.raw`^\s{2}(\S.*?)\s{2,}(${NUM})\s+(${NUM})\s*$`, 'i');

export function parsePluginDetails(id: string, text: string): PluginCost {
  const lines = text.split('\n');

  const counts: Record<string, number> = {};
  const mcpServers: string[] = [];
  const components: ComponentCost[] = [];
  let alwaysOnTokens = Number.NaN;
  let source: string | null = null;
  let mcpUncounted = false;
  let inComponentTable = false;

  const header = /^(\S+)(?:\s+(\d[\w.+-]*))?\s*$/.exec(lines[0] ?? '');
  const version = header?.[2] ?? null;

  for (const line of lines) {
    const inv = INVENTORY_LINE.exec(line);
    if (inv) {
      counts[inv[1]!] = Number(inv[2]);
      if (inv[1] === 'MCP servers' && inv[3]) {
        // e.g. "github  (tool schemas resolved at runtime; not counted)"
        const names = inv[3].replace(/\(.*?\)/g, '').trim();
        if (names) mcpServers.push(...names.split(/,\s*/).filter(Boolean));
        if (/not counted/i.test(inv[3])) mcpUncounted = true;
      }
      continue;
    }

    const always = ALWAYS_ON_LINE.exec(line);
    if (always) {
      alwaysOnTokens = parseTokenCount(always[1]!);
      continue;
    }

    const src = SOURCE_LINE.exec(line);
    if (src) {
      source = src[1]!.trim();
      continue;
    }

    if (/^\s{2}component\s+always-on\s+on-invoke\s*$/i.test(line)) {
      inComponentTable = true;
      continue;
    }
    if (inComponentTable) {
      const row = COMPONENT_ROW.exec(line);
      if (row) {
        components.push({
          name: row[1]!.trim(),
          alwaysOn: parseTokenCount(row[2]!),
          onInvoke: parseTokenCount(row[3]!),
        });
      } else if (line.trim() === '') {
        // A blank line ends the table; trailing prose follows.
        inComponentTable = false;
      }
    }
  }

  return {
    id,
    version,
    source,
    alwaysOnTokens,
    components,
    counts,
    mcpServers,
    mcpUncounted,
  };
}

/**
 * The name `claude plugin details` will actually resolve.
 *
 * It matches the plugin's *manifest* name, which is case-sensitive, while the
 * marketplace id is lowercased. Deriving the lookup name from the id therefore fails
 * whenever the two differ: `notion@claude-plugins-official` ships a manifest calling
 * itself `Notion`, so `plugin details notion` reports the plugin as not found and its
 * cost silently vanished from the audit.
 *
 * Surveyed across 42 installed plugins: 39 match, 1 differs in case, 2 ship no
 * manifest. Neither source covers the set alone, so the manifest wins where it exists
 * and the id prefix is the fallback.
 */
export function pluginLookupName(id: string, installPath: string | null | undefined): string {
  const fallback = id.split('@')[0]!;
  if (!installPath) return fallback;

  try {
    const manifest = JSON.parse(
      readFileSync(join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: unknown };
    // Manifest contents are third-party input and this value becomes an argv entry.
    // Anything that is not a plain non-empty string is not worth trusting.
    return typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name
      : fallback;
  } catch {
    // Missing or malformed manifest -- plenty of plugins ship without one.
    return fallback;
  }
}

export interface PluginCostOptions {
  /** Seconds before a single lookup is abandoned. */
  timeoutMs?: number;
  cwd?: string;
  /** Where the plugin is installed, so its manifest name can be read. */
  installPath?: string | null;
}

const cache = new Map<string, PluginCost | null>();

/**
 * Look up one plugin. Cost does not vary by project, so results are cached for the
 * process and the ~0.6s-per-call shell-out is paid once per plugin.
 */
export function pluginCost(id: string, opts: PluginCostOptions = {}): PluginCost | null {
  if (cache.has(id)) return cache.get(id) ?? null;

  const name = pluginLookupName(id, opts.installPath);
  let out: string;
  try {
    out = claudeCli.run(['plugin', 'details', name], {
      timeoutMs: opts.timeoutMs ?? 30_000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
  } catch {
    cache.set(id, null);
    return null;
  }

  const parsed = parsePluginDetails(id, out);
  cache.set(id, parsed);
  return parsed;
}

export function clearPluginCostCache(): void {
  cache.clear();
}
