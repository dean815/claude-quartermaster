/**
 * How many `restated` cells on this machine are load-bearing? (DEA-154)
 *
 * `resolveCell` decides `origin` by removing *all* project-scope links and comparing the
 * winner against what is left. So a cell whose project-scope files **disagree** and land
 * back on the inherited value reads `restated` while the winning entry is the only reason
 * it resolves that way -- and `restatedEntries` reports it as one that "changes nothing".
 * This counts how often that shape actually occurs here, per axis, and prints any it finds.
 *
 * Read-only. It loads the workspace exactly as `qm audit` does and writes nothing.
 *
 *     node --experimental-strip-types scripts/measure-restated.ts
 *
 * **Zero is the answer this exists to re-check.** It was zero on 2026-08-10, which is the
 * argument in DEA-154 for repairing the model rather than only pinning it -- the shape has
 * never occurred, and `qm set` writing `settings.local.json` is what arms it. Nothing here
 * depends on a first-party string, so the number moves only when the config on disk does.
 *
 * **A check that has only ever printed zero is not a check.** `loadWorkspace` reads `$HOME`,
 * so the shape can be produced without writing anything into a live config:
 *
 *     mkdir -p "$S/.claude" "$S/proj/.claude"
 *     echo '{"projects":{"'"$S"'/proj":{}}}'          > "$S/.claude.json"
 *     echo '{"enabledPlugins":{"p@m":true,"q@m":true}}' > "$S/.claude/settings.json"
 *     echo '{"enabledPlugins":{"p@m":false}}'          > "$S/proj/.claude/settings.json"
 *     echo '{"enabledPlugins":{"p@m":true,"q@m":true}}' > "$S/proj/.claude/settings.local.json"
 *     HOME="$S" node --experimental-strip-types scripts/measure-restated.ts
 *
 * That reports `restated 2, load-bearing 1` and names `p@m`. `q@m` is in the same file and
 * is genuinely inert, so it holds the count apart from the discriminator -- a version that
 * flagged every restated entry would report 2 and look like it worked.
 *
 * Ids come from the surfaces that can carry a *project-scope* link, which is narrower than
 * `qm audit`'s row count and is the entire population that can be `restated`: an id no
 * settings file, `.mcp.json` or deny-list mentions resolves with an empty project scope, so
 * it is `inherited` and can be neither state counted below. That is why no plugin inventory
 * is read -- inventories only add ids of exactly that kind.
 */
import { loadWorkspace } from '../src/surfaces/read.ts';
import {
  allPluginIds,
  resolveMcpServer,
  resolvePlugin,
  resolveSkill,
} from '../src/resolve.ts';
import { allMcpServerNames, buildMcpCatalog } from '../src/mcp.ts';
import { PROJECT_SCOPES, type Cell, type SkillValue } from '../src/model.ts';
import type { ProjectRecord, SettingsFile, Workspace } from '../src/surfaces/types.ts';

interface Tally {
  ids: number;
  restated: number;
  /** Cells whose chain holds more than one project-scope link -- the precondition. */
  twoLinks: number;
  loadBearing: number;
  rows: string[];
}

function tally<V>(
  alive: readonly ProjectRecord[],
  ids: readonly string[],
  resolve: (project: ProjectRecord, id: string) => Cell<V>,
  fallback: V,
): Tally {
  const t: Tally = { ids: ids.length, restated: 0, twoLinks: 0, loadBearing: 0, rows: [] };

  for (const project of alive) {
    for (const id of ids) {
      const cell = resolve(project, id);
      if (cell.chain.filter((l) => PROJECT_SCOPES.includes(l.scope)).length > 1) t.twoLinks++;
      if (cell.origin !== 'restated') continue;
      t.restated++;

      // What the cell resolves to with the winning link taken out, and nothing else.
      // Read straight off the chain rather than back through `resolveCell`, because
      // `resolveCell`'s classification is the thing under test: a check that asked it
      // would agree with whatever it does.
      const withoutWinner = cell.chain.at(-2)?.value ?? fallback;
      if (Object.is(withoutWinner, cell.value)) continue;

      t.loadBearing++;
      const chain = cell.chain.map((l) => `${l.scope}=${String(l.value)}`).join(' ');
      t.rows.push(`${project.path}  ${id}  ${chain} -> ${String(cell.value)}`);
    }
  }
  return t;
}

/** Every skill any settings file overrides. See the header on why this is the population. */
function overriddenSkillIds(ws: Workspace): string[] {
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

/**
 * Pairs where a project's tracked `settings.json` disables what user scope enables.
 *
 * Each one is a single `qm set --on` -- a write to `settings.local.json` -- away from
 * producing the shape above, which is why a load-bearing count of zero does not mean the
 * model is safe to leave alone.
 */
function armedPairs(ws: Workspace, alive: readonly ProjectRecord[]) {
  const user = ws.userSettings?.enabledPlugins ?? {};
  const projects = new Set<string>();
  let pairs = 0;

  for (const p of alive) {
    // `~`'s project-scope settings file *is* the user-scope file, so it never disagrees
    // with itself. The same dedup `contributingFiles` applies, for the same reason.
    if (p.settings && ws.userSettings && p.settings.path === ws.userSettings.path) continue;
    for (const [id, value] of Object.entries(p.settings?.enabledPlugins ?? {})) {
      if (value === false && user[id] === true) {
        pairs++;
        projects.add(p.path);
      }
    }
  }
  return { pairs, projects: projects.size };
}

const ws = loadWorkspace();
const alive = ws.projects.filter((p) => p.alive);

const axes: Array<[string, Tally]> = [
  ['plugins', tally(alive, allPluginIds(ws, new Map()), (p, id) => resolvePlugin(ws, p, id), false)],
  [
    'mcp',
    tally(
      alive,
      allMcpServerNames(buildMcpCatalog(ws, new Map())),
      (p, id) => resolveMcpServer(ws, p, id),
      false,
    ),
  ],
  [
    'skills',
    tally<SkillValue>(
      alive,
      overriddenSkillIds(ws),
      (p, id) => resolveSkill(ws, p, id),
      'on',
    ),
  ],
];

const armed = armedPairs(ws, alive);
const col = (s: string | number, w: number) => String(s).padStart(w);

console.log(`${alive.length} alive projects of ${ws.projects.length} records\n`);
console.log('axis       ids  restated  2+ proj links  load-bearing');
for (const [name, t] of axes) {
  console.log(
    `${name.padEnd(8)}${col(t.ids, 5)}${col(t.restated, 10)}${col(t.twoLinks, 15)}${col(t.loadBearing, 14)}`,
  );
}

const found = axes.flatMap(([name, t]) => t.rows.map((r) => `  ${name}  ${r}`));
if (found.length) {
  console.log('\nload-bearing cells reported as restating the inherited value:');
  for (const row of found) console.log(row);
} else {
  console.log('\nno load-bearing restated cell on any axis.');
}

console.log(
  `\narmed: ${armed.pairs} (project, plugin) pairs over ${armed.projects} projects where a\n` +
    'tracked settings.json disables what user scope enables — one `qm set --on` each\n' +
    'from producing the shape.',
);
