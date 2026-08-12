/**
 * The resolved-configuration algebra.
 *
 * Claude Code decides whether an extension loads by merging settings files per key.
 * A cell in the audit grid is one (extension, project) pair, and it carries two
 * independent facts: what the value resolved to, and where that decision came from.
 *
 * Earlier drafts flattened those into a six-state A-F enum. That works only while
 * every value is binary. `skillOverrides` is four-valued, which the flattening cannot
 * express, so the axes are kept separate here: `value` is domain-specific, `origin`
 * is not. Two values x three origins reproduces A-F exactly.
 */

/**
 * Settings scopes in ascending precedence: enterprise-managed settings win over CLI
 * args, which win over `.claude/settings.local.json`, and so on down to the user's
 * `~/.claude/settings.json`.
 *
 * Phase 1 reads only `user`, `project`, and `local` -- the three file surfaces.
 * `cli` and `enterprise` are declared so the ordering is correct if they are added.
 */
export const SCOPES = ['user', 'project', 'local', 'cli', 'enterprise'] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes at which a decision is a per-project one. */
export const PROJECT_SCOPES: readonly Scope[] = ['project', 'local'];

const PRECEDENCE = new Map<Scope, number>(SCOPES.map((s, i) => [s, i]));

export function precedenceOf(scope: Scope): number {
  const p = PRECEDENCE.get(scope);
  if (p === undefined) throw new Error(`unknown scope: ${scope}`);
  return p;
}

/**
 * Where a cell's effective value was decided.
 *
 * - `inherited`  nothing set at project level; the project takes what it is given.
 * - `overridden` set at project level, and it differs from what would be inherited.
 * - `restated`   set at project level to the value it would have inherited anyway.
 * - `round-trip` set at project level *more than once*, the entries disagree, and the
 *                winner lands back on the inherited value.
 *
 * `restated` has no effect today, and it silently stops tracking the global default the
 * moment that default changes.
 *
 * **`round-trip` looks identical from outside the chain and is its opposite (QM-43).**
 * Removing all project-scope links leaves the same value either way, which is why one
 * comparison produced both for as long as it did. But `restated`'s entry can be deleted
 * with nothing moving, and a `round-trip`'s winner is the entire reason the cell resolves
 * as it does -- delete it and the value flips to what the *other* project-scope entry
 * says. The pair is jointly redundant; neither member is redundant alone.
 *
 * The distinction is a property of the chain, not of the value: every project-scope link
 * carrying the winner means inert, and links that disagree mean the winner is working.
 * It exists as a fourth `Origin` rather than as a second opinion inside the one detector
 * that noticed, because `qm serve` renders MCP cells through this same field and
 * `resolveMcpServer` reaches the shape with no settings file involved at all.
 */
export type Origin = 'inherited' | 'overridden' | 'restated' | 'round-trip';

/** One scope's contribution to a cell. Only scopes that actually set a value appear. */
export interface ChainLink<V> {
  scope: Scope;
  value: V;
  /** Absolute path of the file that set it, for provenance display. */
  source: string;
}

/** A single (extension, project) pair, fully resolved with its provenance intact. */
export interface Cell<V> {
  value: V;
  origin: Origin;
  /** Contributing links, ascending by precedence. The last one won. */
  chain: ChainLink<V>[];
}

/** Plugins and MCP servers are on or off. */
export type PluginValue = boolean;
export type McpValue = boolean;

/**
 * Skills are four-valued. `on` is the default when the key is absent.
 * See https://code.claude.com/docs/en/skills -- `skillOverrides`.
 */
export const SKILL_VALUES = ['on', 'name-only', 'user-invocable-only', 'off'] as const;

export type SkillValue = (typeof SKILL_VALUES)[number];

/**
 * Resolve one cell from the scopes that set it.
 *
 * `links` may arrive in any order and may be empty. `fallback` is the value when no
 * scope sets one -- `false` for a plugin that appears in no settings file, `'on'` for
 * a skill with no override.
 */
export function resolveCell<V>(
  links: readonly ChainLink<V>[],
  fallback: V,
  equals: (a: V, b: V) => boolean = Object.is,
): Cell<V> {
  const chain = [...links].sort((a, b) => precedenceOf(a.scope) - precedenceOf(b.scope));

  const winner = chain.at(-1);
  const value = winner ? winner.value : fallback;

  const projectLinks = chain.filter((l) => PROJECT_SCOPES.includes(l.scope));
  if (!projectLinks.length) return { value, origin: 'inherited', chain };

  // What this project would have resolved to had it said nothing at all.
  const withoutProject = chain.filter((l) => !PROJECT_SCOPES.includes(l.scope));
  const inheritedValue = withoutProject.at(-1)?.value ?? fallback;

  if (!equals(value, inheritedValue)) return { value, origin: 'overridden', chain };

  // The value equals what would be inherited, which used to be the whole of `restated`.
  // It is only inert if *every* project-scope link says so: one dissenting link means the
  // winner is overriding it, and removing the winner moves the value to what that link
  // says rather than to the inherited one. Asked of the links rather than by re-resolving
  // a shortened chain, because a check that re-entered this function would agree with
  // whatever it does.
  const allAgree = projectLinks.every((l) => equals(l.value, value));
  return { value, origin: allAgree ? 'restated' : 'round-trip', chain };
}
