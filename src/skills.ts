/**
 * Which skills exist at all.
 *
 * Deriving the skill set from `skillOverrides` is circular: a skill becomes a row only
 * once someone has scoped it, and the grid exists to show you what needs scoping. On a
 * workspace that has scoped nothing -- this one, and every workspace the
 * `unscopedSkills` detector fires on -- it returns nothing and the axis is empty.
 *
 * Three sources can name skills, and they disagree by more than a rounding error.
 * Measured here: **87** on disk, **90** typed as skills by the plugin catalog, and
 * **428** in the observed listings. The listings are authoritative and the other two
 * are not merely smaller -- each is blind to whole categories the listing sees:
 *
 * - `~/.claude/skills/` holds only *personal* skills. It knows nothing of plugin
 *   skills, and nothing of the skills Claude Code itself bundles (`dataviz`,
 *   `artifact-design`, `simplify` and ~19 more appear in every listing and exist in no
 *   directory this tool can find).
 * - Plugin components cannot be filtered down to skills in general. The install-tree
 *   walk in `inventory.ts` yields 720 names across 37 plugins with the kinds already
 *   flattened, and `vercel` alone contributes eight `SKILL.md` files that are its own
 *   repo tooling and never load. Only `plugin-catalog-cache.json` records the kind, and
 *   it covers 25 of the 42 installed plugins -- which is why 17 plugins' worth of
 *   skills (`minutes:*`, `anthropic-skills:*`, and more) are visible to no source but
 *   the listing.
 * - The observed listing carries every one of them, under the id a `skillOverrides`
 *   key would use. 86 of the 87 disk skills and 89 of the 90 catalogued plugin skills
 *   appear in it verbatim, which is what makes it safe to treat as the superset rather
 *   than as a fourth opinion.
 *
 * So: what loaded beats what we think is installed. The other two sources are kept for
 * the one thing the listing structurally cannot do -- name a skill that never loaded.
 *
 * **Current, not historical.** A project's availability is taken from its most recent
 * measured listing. Unioning every session instead would return 737 ids here rather
 * than 428, because 300 of them are `context-audit-skill-<hash>` scratch skills that
 * the context-audit harness created and deleted months ago. Those are not noise to be
 * pattern-matched away -- they genuinely loaded -- so they resolve to `stale` and stay
 * visible, rather than being filtered by a regex on their names that would eventually
 * swallow something real.
 *
 * **Installed is not observed.** A skill on disk that no listing names has not been
 * shown to load, and saying it is on would be the same mistake `usage.ts` refuses to
 * make with a zeroed counter. It gets its own presence value and its own count.
 */
import { pluginNamespace, type PluginInventory, type PluginKeyBasis } from './inventory.ts';
import type { TranscriptMeasurement } from './cost/transcript.ts';
import type { SettingsFile, Workspace } from './surfaces/types.ts';

/**
 * How well the workspace can account for a skill. "Current" throughout means the most
 * recent measured listing of a project, not any listing ever.
 *
 * - `observed`             a current listing names it. It loads somewhere today.
 * - `installed-unobserved` an installed source names it and no current listing does.
 *                          Read `sessions` before calling one of these never-used: 0
 *                          means no measured session ever listed it, and anything
 *                          higher means it used to load and no longer does.
 * - `stale`                a listing named it once, and nothing says it is installed.
 */
export type SkillPresence = 'observed' | 'installed-unobserved' | 'stale';

/** What one project can be said to know about one skill. */
export type ProjectPresence =
  /** This project's most recent listing names it. */
  | 'observed'
  /** This project has a listing, and it does not name it. */
  | 'unobserved'
  /** This project has no listing carrying names. Could not tell, not absent. */
  | 'unmeasured';

export interface SkillEntry {
  /** The id a `skillOverrides` key would use: `deploy`, or `minutes:minutes-brief`. */
  id: string;
  presence: SkillPresence;
  /** `~/.claude/skills/<id>/SKILL.md` exists. */
  onDisk: boolean;
  /** Plugin whose catalog entry types this as one of its skills, when one does. */
  fromPlugin: string | null;
  /**
   * Where the plugin half of `id` came from. `null` exactly when `fromPlugin` is -- no
   * plugin provides this row, so there is no name to have got right or wrong.
   *
   * Its own field rather than a lookup back into the inventory, for the reason
   * `McpEntry.keyBasis` is one: a read name and an assumed one produce an
   * identical-looking `X:y`, and a consumer holding only the row -- the grid, and a
   * Phase 2 `skillOverrides` write -- has no inventory left to consult. It is not
   * *carried* from `McpEntry` either, because the two axes are separate sets of rows and
   * a skill row is reachable without an MCP row existing at all; what they share is the
   * derivation, which is one body in `pluginNamespace`.
   */
  keyBasis: PluginKeyBasis | null;
  /** A settings file sets an override for it, so someone believes it exists. */
  configured: boolean;
  /** Projects whose most recent listing names it, sorted. */
  activeIn: string[];
  /** Every project that has ever listed it, current or not. Sorted. */
  observedIn: string[];
  /** Sessions whose listing named it. */
  sessions: number;
  /** mtime of the newest session that named it, or null. */
  lastSeenAt: number | null;
}

export interface SkillCatalog {
  /** Every id any source can name, sorted. Includes `stale`. */
  entries: SkillEntry[];
  /** Projects with at least one listing carrying names -- the ones we can speak for. */
  measuredProjects: string[];
  /**
   * Listings that recorded a `skillCount` and no `names`. Measured and uninformative,
   * counted so a report can say the coverage is not total.
   */
  countOnlyListings: number;
}

function eachSettingsFile(ws: Workspace): SettingsFile[] {
  const files = [ws.userSettings];
  for (const p of ws.projects) files.push(p.settings, p.localSettings);
  return files.filter((f): f is SettingsFile => Boolean(f));
}

/**
 * Reconcile the three sources into one set.
 *
 * `measurements` is whatever the run measured -- the whole workspace, or one project's
 * sessions on a scoped run. A measurement with a null `project` still counts toward a
 * skill's session tally but can make no project current, since there is no project to
 * attribute it to.
 */
export function buildSkillCatalog(
  ws: Workspace,
  measurements: readonly TranscriptMeasurement[],
  inventories: ReadonlyMap<string, PluginInventory>,
): SkillCatalog {
  // The newest names-carrying listing per project is that project's current set.
  const currentByProject = new Map<string, TranscriptMeasurement>();
  let countOnlyListings = 0;

  for (const m of measurements) {
    if (!m.skills) {
      if (m.blocks.some((b) => b.kind === 'skill_listing')) countOnlyListings++;
      continue;
    }
    if (m.project === null) continue;
    const held = currentByProject.get(m.project);
    if (!held || m.modifiedAt > held.modifiedAt) currentByProject.set(m.project, m);
  }

  interface Acc {
    activeIn: Set<string>;
    observedIn: Set<string>;
    sessions: number;
    lastSeenAt: number | null;
    onDisk: boolean;
    fromPlugin: string | null;
    keyBasis: PluginKeyBasis | null;
    configured: boolean;
  }

  const acc = new Map<string, Acc>();
  const of = (id: string): Acc => {
    let a = acc.get(id);
    if (!a) {
      a = {
        activeIn: new Set(),
        observedIn: new Set(),
        sessions: 0,
        lastSeenAt: null,
        onDisk: false,
        fromPlugin: null,
        keyBasis: null,
        configured: false,
      };
      acc.set(id, a);
    }
    return a;
  };

  for (const m of measurements) {
    if (!m.skills) continue;
    for (const id of m.skills) {
      const a = of(id);
      a.sessions++;
      if (a.lastSeenAt === null || m.modifiedAt > a.lastSeenAt) a.lastSeenAt = m.modifiedAt;
      if (m.project !== null) a.observedIn.add(m.project);
    }
  }
  for (const [project, m] of currentByProject) {
    for (const id of m.skills ?? []) of(id).activeIn.add(project);
  }

  for (const s of ws.personalSkills) of(s.id).onDisk = true;

  // `<plugin>:<skill>`, where the plugin half is the **manifest** name and never the
  // marketplace id. This is DEA-145's key one axis over, and it was latent rather than
  // live: exactly one of the 42 plugins installed here carries a manifest name its id
  // prefix does not predict -- `notion@claude-plugins-official`, `"name": "Notion"` --
  // and it enumerates zero `skillNames`, so nothing was minting the wrong id yet. A
  // catalog refresh is all that stands in the way: it would then produce
  // `notion:create-page` beside the `Notion:create-page` that 438 measured listings
  // already carry, and one skill would hold two rows, the second matching no config file
  // and so unwritable.
  //
  // Read once per plugin rather than per skill: the basis is a property of the manifest,
  // so two skills from one plugin can never disagree about it.
  for (const inv of inventories.values()) {
    const { name: plugin, basis } = pluginNamespace(inv.id, inv.manifestName);
    for (const src of inv.enumerated) {
      for (const name of src.skillNames) {
        const a = of(`${plugin}:${name}`);
        a.fromPlugin = inv.id;
        a.keyBasis = basis;
      }
    }
  }

  // An override is itself a claim that the skill exists. Nothing sets one here, but
  // dropping a deliberately-scoped skill because no session happened to list it would
  // reintroduce the bug from the other side.
  for (const f of eachSettingsFile(ws)) {
    for (const id of Object.keys(f.skillOverrides ?? {})) of(id).configured = true;
  }

  const entries: SkillEntry[] = [...acc.entries()]
    .map(([id, a]) => ({
      id,
      presence: presenceOf(a.activeIn.size > 0, a.onDisk || a.fromPlugin !== null || a.configured),
      onDisk: a.onDisk,
      fromPlugin: a.fromPlugin,
      keyBasis: a.keyBasis,
      configured: a.configured,
      activeIn: [...a.activeIn].sort(),
      observedIn: [...a.observedIn].sort(),
      sessions: a.sessions,
      lastSeenAt: a.lastSeenAt,
    }))
    .sort((x, y) => x.id.localeCompare(y.id));

  return {
    entries,
    measuredProjects: [...currentByProject.keys()].sort(),
    countOnlyListings,
  };
}

function presenceOf(active: boolean, installed: boolean): SkillPresence {
  if (active) return 'observed';
  return installed ? 'installed-unobserved' : 'stale';
}

/**
 * The grid's skill axis.
 *
 * `stale` is excluded: a skill that no longer loads anywhere cannot be scoped, and an
 * override written for it does nothing. It stays in `entries` so the count is
 * reportable rather than silently gone.
 */
export function allSkillIds(catalog: SkillCatalog): string[] {
  return catalog.entries.filter((e) => e.presence !== 'stale').map((e) => e.id);
}

/**
 * What one project can say about one skill.
 *
 * Kept apart from the resolved `Cell<SkillValue>` on purpose. The cell says what the
 * settings chain decided -- `on`, inherited, for everything here. This says whether
 * there is any evidence the skill was there to be decided about, and the two are not
 * the same claim.
 */
export function skillPresenceIn(
  catalog: SkillCatalog,
  entry: SkillEntry,
  projectPath: string,
): ProjectPresence {
  if (!catalog.measuredProjects.includes(projectPath)) return 'unmeasured';
  return entry.activeIn.includes(projectPath) ? 'observed' : 'unobserved';
}

/** Entries per presence value, for reporting coverage rather than implying it. */
export function countByPresence(catalog: SkillCatalog): Record<SkillPresence, number> {
  const counts: Record<SkillPresence, number> = {
    observed: 0,
    'installed-unobserved': 0,
    stale: 0,
  };
  for (const e of catalog.entries) counts[e.presence]++;
  return counts;
}
