/**
 * Plugin categories, borrowed rather than restated.
 *
 * `project-optimizer` already owns "what kind of thing is this plugin, and when should it
 * be on": its `references/plugin-matrix.md` is the rubric its onboarding skill applies.
 * Copying those buckets in here would give one workspace two taxonomies that agree right
 * up until the day either is edited -- the same failure the Blocking/Gap/Polish ranking is
 * deliberately kept out of `delegate/projectOptimizer.ts` to avoid. So the file is read at
 * runtime, and when it is not there the filter it feeds is not there either. A category
 * filter offering nothing is worse than no category filter: it reads as "this workspace
 * has no categorised plugins" rather than "nothing was consulted".
 *
 * The join is on the bare plugin name -- repo ids are `name@marketplace`, the matrix
 * writes names alone. An id the matrix does not name is uncategorised. Never bucketed by
 * resemblance: "looks like a git tool" is a judgement, and judgements stay with the skill.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the rubric lives.
 *
 * The working checkout rather than the installed copy under
 * `~/.claude/plugins/cache/claude-project-optimizer/`. Both exist on a machine that has
 * both, and they differ exactly when the matrix has been edited and not yet republished --
 * which is the moment a borrowed rubric is most worth borrowing from its source. The day
 * this choice fails is on a machine with the plugin installed and no checkout, where the
 * filter hides rather than reads the installed copy; `readMatrix` takes a path for that.
 */
export const DEFAULT_MATRIX_PATH = join(
  homedir(),
  'claude',
  'claude-project-optimizer',
  'references',
  'plugin-matrix.md',
);

export interface CategoryMatrix {
  /** Bucket per bare plugin name, lowercased. */
  byName: Map<string, string>;
  /** Buckets in the order the document introduces them. */
  buckets: string[];
}

/** Only `## The matrix` names plugins; the surrounding prose names files and JSON keys. */
const MATRIX_SECTION = /^##\s+The matrix\s*$/;

/**
 * A bucket's name, without the sentence the heading continues into.
 *
 * `### Universal — leave enabled everywhere` is a heading and an instruction at once. The
 * instruction is the skill's to give; the noun is all a filter label needs.
 */
function bucketLabel(heading: string): string {
  return (heading.split('—')[0] ?? heading).trim();
}

/**
 * Backticked names on one line, minus the first table column.
 *
 * The document's tables read `signal | enable | disable`, and the signal column is
 * backticked too: `typescript`, `react`, `.claude-plugin/plugin.json`, `mcp-sdk`. Taking
 * every backtick in the section would file a stack marker as a plugin name. The first cell
 * is the condition; every cell after it names plugins. Prose lines have no cells and are
 * taken whole.
 */
function namesOn(line: string): string[] {
  const trimmed = line.trim();
  let text = trimmed;
  if (trimmed.startsWith('|')) {
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
    text = cells.slice(1).join('|');
  }
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim()).filter((n) => n.length > 0);
}

export function parseMatrix(markdown: string): CategoryMatrix {
  const byName = new Map<string, string>();
  const buckets: string[] = [];
  let inMatrix = false;
  let bucket: string | null = null;

  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) {
      inMatrix = MATRIX_SECTION.test(line.trim());
      bucket = null;
      continue;
    }
    if (!inMatrix) continue;
    if (line.startsWith('### ')) {
      bucket = bucketLabel(line.slice(4));
      if (!buckets.includes(bucket)) buckets.push(bucket);
      continue;
    }
    if (bucket === null) continue;
    // First bucket wins. `figma` is named twice inside Domain-conditional -- once to
    // enable and once to disable elsewhere -- and both mean the same bucket.
    for (const name of namesOn(line)) {
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, bucket);
    }
  }

  return { byName, buckets };
}

/** The matrix, or `null` when there is no file to read. */
export function readMatrix(path: string = DEFAULT_MATRIX_PATH): CategoryMatrix | null {
  try {
    return parseMatrix(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Bucket per plugin id, for the ids the matrix actually names.
 *
 * Absent from the result means uncategorised, which is a different answer from every
 * bucket the document has -- so it is spelled by absence rather than by a made-up bucket
 * that would sort alongside the real ones.
 *
 * Case-folded: `plugin list --json` lowercases marketplace ids while a manifest may not
 * (see `pluginLookupName`), and the matrix writes lowercase throughout. Folding is an
 * exact match under a normalisation, not a fuzzy one.
 */
export function categorise(
  ids: readonly string[],
  matrix: CategoryMatrix,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const bare = (id.split('@')[0] ?? id).toLowerCase();
    const bucket = matrix.byName.get(bare);
    if (bucket !== undefined) out[id] = bucket;
  }
  return out;
}
