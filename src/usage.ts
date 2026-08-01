/**
 * Usage counters in `~/.claude.json`, and what they actually mean.
 *
 * `skillUsage` and `pluginUsage` look interchangeable -- same shape, same field names.
 * They are not, and reading `pluginUsage.usageCount` as "times you used this plugin"
 * produces confident nonsense. Both claims below were established by measurement, not
 * inference, because a wrong "never used" verdict is the most damaging thing this
 * audit could say.
 *
 * **`skillUsage.usageCount` is a genuine invocation count.** Controlled test: read
 * `gsd-help` (usageCount 1), invoked it once in a headless session, read again --
 * usageCount 2, `lastUsedAt` advanced. It counts what its name says.
 *
 * **`pluginUsage.usageCount` is dominated by hook firings.** Across 42 installed
 * plugins, 8 of the 10 that provide hooks have a non-zero count, against 2 of the 32
 * that do not. The magnitudes settle it: `warp` (7 hooks, one of them PostToolUse)
 * sits at 9,068 against 97 recorded startups. That is tool calls, not usage.
 *
 * So a plugin's count is only interpretable as invocations when the plugin ships no
 * hooks -- which is most of them, and includes every case worth reporting.
 *
 * Two further traps found along the way:
 *
 * - `lastUsedAt` advances without `usageCount` moving. `typescript-lsp` shows
 *   `usageCount: 0` with a `lastUsedAt` of minutes ago. It marks last *seen*, not
 *   last used, so it cannot date a plugin's last real use.
 * - `numStartups` does not count `claude -p` sessions; it stayed at 97 across a
 *   headless run. Any staleness measure built on `lastUsedNumStartups` undercounts.
 */
import type { UsageRecord } from './surfaces/types.ts';
import type { Workspace } from './surfaces/types.ts';

/** How far a counter can be trusted. */
export type UsageMeaning =
  /** Counts invocations. Safe to say "never used" when zero. */
  | 'invocations'
  /** Counts hook firings far more than invocations. Says nothing about use. */
  | 'hook-dominated'
  /** No record at all. Absence of evidence. */
  | 'unrecorded';

export interface UsageReading {
  id: string;
  count: number | null;
  /** Milliseconds since epoch, or null. Marks last *seen*, not last used. */
  lastSeenAt: number | null;
  meaning: UsageMeaning;
  /** Set when `meaning` is not `invocations`, explaining why it cannot be read plainly. */
  caveat?: string;
}

function read(record: UsageRecord | undefined): { count: number | null; lastSeenAt: number | null } {
  if (!record) return { count: null, lastSeenAt: null };
  return {
    count: record.usageCount ?? null,
    lastSeenAt: record.lastUsedAt ?? null,
  };
}

export function skillUsage(ws: Workspace, skillId: string): UsageReading {
  const { count, lastSeenAt } = read(ws.claudeJson.skillUsage[skillId]);
  return {
    id: skillId,
    count,
    lastSeenAt,
    meaning: count === null ? 'unrecorded' : 'invocations',
  };
}

/**
 * `hookCount` comes from `claude plugin details`. Pass it so the reading can say
 * whether the number means anything; without it the answer is conservative.
 */
export function pluginUsage(
  ws: Workspace,
  pluginId: string,
  hookCount: number | null,
): UsageReading {
  const { count, lastSeenAt } = read(ws.claudeJson.pluginUsage[pluginId]);

  if (count === null) return { id: pluginId, count, lastSeenAt, meaning: 'unrecorded' };

  if (hookCount === null) {
    return {
      id: pluginId,
      count,
      lastSeenAt,
      meaning: 'hook-dominated',
      caveat: 'hook count unknown, so the counter cannot be read as invocations',
    };
  }

  if (hookCount > 0) {
    return {
      id: pluginId,
      count,
      lastSeenAt,
      meaning: 'hook-dominated',
      caveat: `provides ${hookCount} hook${hookCount === 1 ? '' : 's'}; the count is mostly hook firings`,
    };
  }

  return { id: pluginId, count, lastSeenAt, meaning: 'invocations' };
}

/**
 * Whether the evidence supports saying something was never used.
 *
 * Deliberately strict: `unrecorded` is not proof of disuse, and a hook-dominated
 * counter reading zero is not either.
 */
export function isDemonstrablyUnused(reading: UsageReading): boolean {
  return reading.meaning === 'invocations' && reading.count === 0;
}
