/**
 * Measuring baseline context cost from session transcripts.
 *
 * Claude Code persists every block it injects at startup to
 * `~/.claude/projects/<slug>/*.jsonl` as `attachment` records. That makes the cost
 * exactly measurable after the fact, for the real session, without perturbing it.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. **Report a single baseline number.** Measured across 1,068 sessions on one
 *    machine, the deferred tool block ranged from 179 to 34,593 chars -- median 534,
 *    p95 25,359. It depends on entrypoint and on which servers happened to connect,
 *    and 17% of sessions accumulated tools across more than one delta. A point
 *    estimate is a sample, not a property of the workspace.
 *
 * 2. **Convert chars to tokens with a single ratio.** The ratio is content-dependent:
 *    connector tool names are mostly UUID and tokenize near 2 chars/token, while prose
 *    descriptions run closer to 3.7. Chars are what is measured here; token estimates
 *    belong with the ratio that produced them.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { memorySlug } from '../surfaces/read.ts';

/** How a server reaches Claude Code. The three namespaces cost very differently. */
export type ServerKind = 'connector' | 'plugin' | 'direct' | 'builtin';

export interface ServerCost {
  /** Namespace as it appears in tool names, e.g. `raindrop` or `plugin_playwright_playwright`. */
  server: string;
  kind: ServerKind;
  tools: number;
  chars: number;
  /**
   * Chars spent on the 36-char UUID that claude.ai connectors carry in every tool
   * name. Pure identifier overhead -- it conveys nothing to the model.
   */
  uuidOverhead: number;
}

export interface BaselineBlock {
  kind: 'deferred_tools' | 'mcp_instructions' | 'skill_listing' | 'agent_listing' | 'hook_output';
  chars: number;
  /** Tool names, servers, skills, agents, or hook invocations, depending on kind. */
  items: number;
}

export interface TranscriptMeasurement {
  path: string;
  /**
   * The project this session ran in, when it was read through `measureProject`. Null
   * when a transcript was measured by path alone, because the directory slug is a
   * lossy encoding of the path and guessing one back would invent a project.
   */
  project: string | null;
  sessionId: string;
  modifiedAt: number;
  blocks: BaselineBlock[];
  servers: ServerCost[];
  /** Servers Claude Code reported as unauthenticated at startup. */
  needsAuth: string[];
  /** Servers still connecting when the block was written. */
  pending: string[];
  /**
   * The skill ids this session actually loaded.
   *
   * `null` means no listing carried a `names` array -- either none appeared, or the
   * one that did recorded only a count. That is "could not tell", and it must not
   * read as "this session loaded no skills": ten of the listings on the machine this
   * was built against carry `skillCount` and nothing else.
   */
  skills: string[] | null;
  totalChars: number;
}

const UUID_NAMESPACE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_CHARS = 36;

/**
 * `plugin:marketing:ahrefs` in a status list is `plugin_marketing_ahrefs` in a tool name.
 *
 * `.` is here for the same reason as `:` and ` `, and was missing (DEA-123): the
 * connector `claude.ai raindrop.io` publishes tools under `claude_ai_raindrop_io`, so
 * without it every one of the 36 `claude_ai_*` namespaces on this machine failed to
 * join back to the name its own status list uses. Hyphens are deliberately *not*
 * mapped -- `plugin_pdf-viewer_pdf` and `gemini-api-docs-mcp` keep theirs in the
 * observed tool names.
 *
 * Widening it changes nothing for the caller that had it: `unauthenticatedButListed`
 * scores 38 hits across 2,071 transcripts either way, because every server this
 * workspace reports unauthenticated is a `plugin:X:Y` with no dot in it. The direction
 * this is used in stays one-way -- see `mcp.ts` on why reversing it is a guess.
 */
export function normalizeServerName(name: string): string {
  return name.replaceAll(':', '_').replaceAll(' ', '_').replaceAll('.', '_');
}

/**
 * claude.ai connectors appear under two namespaces: a bare UUID, and a readable
 * `claude_ai_<Name>` form. Both are connectors. Only the UUID form carries the 36-char
 * identifier overhead, so `uuidOverhead` keys on the format while `kind` does not.
 */
export function classifyServer(namespace: string): ServerKind {
  if (namespace === BUILTIN) return 'builtin';
  if (UUID_NAMESPACE.test(namespace) || namespace.startsWith('claude_ai_')) return 'connector';
  if (namespace.startsWith('plugin_')) return 'plugin';
  return 'direct';
}

/** True only for the UUID-namespaced form, which pays 36 chars on every tool name. */
function hasUuidOverhead(namespace: string): boolean {
  return UUID_NAMESPACE.test(namespace);
}

const BUILTIN = '(built-in)';

/** Tool names are `mcp__<server>__<tool>`; anything else is a deferred built-in. */
function namespaceOf(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return BUILTIN;
  const rest = toolName.slice('mcp__'.length);
  const end = rest.indexOf('__');
  return end === -1 ? rest : rest.slice(0, end);
}

function sumLengths(xs: readonly string[]): number {
  let n = 0;
  for (const x of xs) n += x.length;
  return n;
}

/**
 * Measure one session.
 *
 * Deltas accumulate: a session that connects servers asynchronously writes several
 * `deferred_tools_delta` records, and the cost is their union. Names are de-duplicated
 * because a re-added tool is not paid for twice.
 */
export function measureTranscript(
  path: string,
  project: string | null = null,
): TranscriptMeasurement {
  const toolNames = new Set<string>();
  const needsAuth = new Set<string>();
  const pending = new Set<string>();

  let mcpInstructionChars = 0;
  let mcpInstructionCount = 0;
  let skillChars = 0;
  let skillCount = 0;
  let skillNames: string[] | null = null;
  let agentChars = 0;
  let agentCount = 0;
  let hookChars = 0;
  let hookCount = 0;

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || !line.includes('"attachment"')) continue;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A truncated final line is normal on a live session.
    }
    const a = record?.attachment;
    if (!a?.type) continue;

    switch (a.type) {
      case 'deferred_tools_delta': {
        for (const n of a.addedNames ?? []) toolNames.add(n);
        for (const s of a.needsAuthMcpServers ?? []) needsAuth.add(s);
        for (const s of a.pendingMcpServers ?? []) pending.add(s);
        break;
      }
      case 'mcp_instructions_delta': {
        mcpInstructionChars += sumLengths(a.addedBlocks ?? []);
        mcpInstructionCount += (a.addedNames ?? []).length;
        break;
      }
      case 'skill_listing': {
        // Not a delta -- each record is a full listing, so the largest wins.
        skillChars = Math.max(skillChars, (a.content ?? '').length);
        skillCount = Math.max(skillCount, a.skillCount ?? (a.names ?? []).length);
        const names: string[] | null = Array.isArray(a.names)
          ? (a.names as unknown[]).filter((n): n is string => typeof n === 'string')
          : null;
        if (names && (!skillNames || names.length > skillNames.length)) skillNames = names;
        break;
      }
      case 'agent_listing_delta': {
        agentChars += sumLengths(a.addedLines ?? []);
        agentCount += (a.addedTypes ?? []).length;
        break;
      }
      case 'hook_success':
      case 'hook_additional_context': {
        const text = typeof a.content === 'string' ? a.content : (a.output ?? '');
        hookChars += typeof text === 'string' ? text.length : 0;
        hookCount += 1;
        break;
      }
    }
  }

  // Attribute the tool-name block to the servers that published it.
  const byServer = new Map<string, { tools: number; chars: number }>();
  for (const name of toolNames) {
    const ns = namespaceOf(name);
    const acc = byServer.get(ns) ?? { tools: 0, chars: 0 };
    acc.tools += 1;
    acc.chars += name.length;
    byServer.set(ns, acc);
  }

  const servers: ServerCost[] = [...byServer.entries()]
    .map(([server, { tools, chars }]) => {
      const kind = classifyServer(server);
      return {
        server,
        kind,
        tools,
        chars,
        uuidOverhead: hasUuidOverhead(server) ? tools * UUID_CHARS : 0,
      };
    })
    .sort((a, b) => b.chars - a.chars);

  const deferredChars = sumLengths([...toolNames]);
  const allBlocks: BaselineBlock[] = [
    { kind: 'deferred_tools', chars: deferredChars, items: toolNames.size },
    { kind: 'mcp_instructions', chars: mcpInstructionChars, items: mcpInstructionCount },
    { kind: 'skill_listing', chars: skillChars, items: skillCount },
    { kind: 'agent_listing', chars: agentChars, items: agentCount },
    { kind: 'hook_output', chars: hookChars, items: hookCount },
  ];
  const blocks = allBlocks.filter((b) => b.chars > 0);

  return {
    path,
    project,
    sessionId: path.split('/').at(-1)!.replace(/\.jsonl$/, ''),
    modifiedAt: statSync(path).mtimeMs,
    blocks,
    servers,
    needsAuth: [...needsAuth].sort(),
    pending: [...pending].sort(),
    skills: skillNames,
    totalChars: blocks.reduce((n, b) => n + b.chars, 0),
  };
}

/** Every recorded session for a project, newest first. */
export function measureProject(home: string, projectPath: string): TranscriptMeasurement[] {
  const dir = join(home, '.claude', 'projects', memorySlug(projectPath));
  if (!existsSync(dir)) return [];

  const out: TranscriptMeasurement[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      out.push(measureTranscript(join(dir, f), projectPath));
    } catch {
      // An unreadable transcript is not worth failing an audit over.
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/**
 * Servers listed as needing authentication that nonetheless published tool names.
 *
 * Worth checking rather than assuming: on the workspace this was built against, the
 * set is empty -- an unauthenticated server has no tool list to publish, so it costs
 * nothing at baseline. The opposite is widely assumed, so the audit should report what
 * it finds rather than repeat the intuition.
 */
export function unauthenticatedButListed(m: TranscriptMeasurement): ServerCost[] {
  const needy = new Set(m.needsAuth.map(normalizeServerName));
  return m.servers.filter((s) => needy.has(s.server));
}
