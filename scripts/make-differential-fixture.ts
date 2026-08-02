/**
 * Rebuild `test/fixtures/differential/` -- this machine's plugin configuration paired
 * with the answer `claude plugin list --json` gives for the same projects, anonymised
 * hard enough to commit.
 *
 * `test/fixtures/local-snapshot/` is gitignored because rewriting `$HOME` anonymises
 * who you are but not what you work on: the project directory names survive it. This
 * fixture *is* committed, so directory names become `proj-NN` and MCP server names
 * become `srv-NN`. Plugin ids stay verbatim -- they are the thing the gate compares,
 * and an id is a public marketplace coordinate rather than a private one.
 *
 * Allowlist-first, like scripts/make-fixtures.ts: a value is dropped unless a rule
 * names it, so a key nobody anticipated cannot leak.
 *
 *     node --experimental-strip-types scripts/make-differential-fixture.ts
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SkillValue } from '../src/model.ts';

// The generator measures the fixture it just wrote, so the manifest and the gate can
// never disagree about how much coverage there is. Importing the fixture's own loader
// rather than restating the path-rebasing rule keeps one copy of that rule.
import { resolvePlugin } from '../src/resolve.ts';
import { loadFixtureWorkspace } from '../test/fixtures/differential/load.ts';

const HOME = homedir();
const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'differential');

/** The path the fixture records for `~`. A consumer rebases this prefix onto `home/`. */
const FAKE_HOME = '/Users/testuser';

/** Settings list keys the MCP surface reads. `enabledPlugins` is handled separately. */
const SETTINGS_LISTS = ['enabledMcpjsonServers', 'disabledMcpjsonServers'] as const;

/**
 * `projects[<path>]` keys `resolveMcpServer` reads. `allowedTools` is deliberately not
 * here: its patterns embed argv and absolute paths, which is exactly what this fixture
 * exists to not ship.
 */
const ENTRY_LISTS = [
  'disabledMcpServers',
  'enabledMcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
] as const;

/** A server's transport is structural. Its url, argv and env are not -- and env key
 *  names read as secrets even when the values are gone. */
const MCP_TYPES = new Set(['stdio', 'http', 'sse']);

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const readJsonIf = (p: string): any => (existsSync(p) ? readJson(p) : null);

function writeText(fullPath: string, text: string): void {
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, text);
}

function writeJson(fullPath: string, data: unknown): void {
  writeText(fullPath, JSON.stringify(data, null, 2) + '\n');
}

const write = (relPath: string, data: unknown): void => writeJson(join(OUT, relPath), data);

// ---------------------------------------------------------------------------
// 1. Read every source before invoking `claude`. The CLI writes telemetry into
//    ~/.claude.json on each run, so capturing the oracle first would race the copy.

const CLAUDE_JSON_PATH = join(HOME, '.claude.json');
const claudeJson = readJson(CLAUDE_JSON_PATH);
const userSettings = readJson(join(HOME, '.claude', 'settings.json'));

// Worktrees are the one exclusion, and only because the live gate excludes them too:
// they inherit their parent's settings by a path the resolver does not model, so a
// pair captured from one would be comparing against something we never claimed.
const realPaths = Object.keys(claudeJson.projects ?? {})
  .filter((p) => !p.includes('/worktrees/'))
  .sort();

const seq = (n: number) => String(n).padStart(2, '0');

// Sorted first, then numbered, so regenerating against an unchanged machine is a
// no-op diff rather than a reshuffle.
const fakePath = new Map<string, string>();
let projectNo = 0;
for (const p of realPaths) {
  fakePath.set(p, p === HOME ? FAKE_HOME : `${FAKE_HOME}/proj-${seq(++projectNo)}`);
}

interface Captured {
  fake: string;
  /** Fixture-relative dir. Empty for `~`, whose project scope *is* the user scope. */
  rel: string;
  alive: boolean;
  settings: any;
  localSettings: any;
  mcpJson: any;
  entry: any;
  /** Where to run the oracle. `null` for a dead entry, which has no directory to ask. */
  oracleCwd: string | null;
  /** True when the *config* was constructed rather than found. See section 4. */
  synthetic: boolean;
  /** Constructed `skillOverrides` for each project-level scope. See section 4b. */
  skillSettings: Record<string, SkillValue> | null;
  skillLocalSettings: Record<string, SkillValue> | null;
}

const captured: Captured[] = realPaths.map((real) => {
  const fake = fakePath.get(real)!;
  const alive = existsSync(real) && statSync(real).isDirectory();
  return {
    fake,
    rel: fake.slice(FAKE_HOME.length).replace(/^\//, ''),
    alive,
    settings: alive ? readJsonIf(join(real, '.claude', 'settings.json')) : null,
    localSettings: alive ? readJsonIf(join(real, '.claude', 'settings.local.json')) : null,
    mcpJson: alive ? readJsonIf(join(real, '.mcp.json')) : null,
    entry: claudeJson.projects[real] ?? {},
    oracleCwd: alive ? real : null,
    synthetic: false,
    skillSettings: null,
    skillLocalSettings: null,
  };
});

// ---------------------------------------------------------------------------
// 2. Synthetic server names. One map for the whole workspace, because the structural
//    case that matters is a name declared in `.mcp.json` and switched on from a
//    different file -- rename them apart and that case evaporates.

const serverNames = new Set<string>(Object.keys(claudeJson.mcpServers ?? {}));
const collectServers = (obj: any, keys: readonly string[]) => {
  for (const k of keys) for (const s of obj?.[k] ?? []) serverNames.add(String(s));
};
collectServers(userSettings, SETTINGS_LISTS);
for (const c of captured) {
  collectServers(c.entry, ENTRY_LISTS);
  collectServers(c.settings, SETTINGS_LISTS);
  collectServers(c.localSettings, SETTINGS_LISTS);
  for (const s of Object.keys(c.mcpJson?.mcpServers ?? {})) serverNames.add(s);
}

const fakeServer = new Map([...serverNames].sort().map((n, i) => [n, `srv-${seq(i + 1)}`]));
const renameServers = (list: unknown): string[] =>
  Array.isArray(list) ? list.map((s) => fakeServer.get(String(s)) ?? 'srv-unmapped') : [];

// ---------------------------------------------------------------------------
// 3. Allowlist-first projections.

function pickSettings(src: any): Record<string, unknown> {
  if (!src || typeof src !== 'object') return {};
  const out: Record<string, unknown> = {};
  if (src.enabledPlugins && typeof src.enabledPlugins === 'object') {
    // Ids verbatim; values only when they are actually booleans.
    const plugins = Object.entries(src.enabledPlugins).filter(([, v]) => typeof v === 'boolean');
    if (plugins.length) out.enabledPlugins = Object.fromEntries(plugins);
  }
  for (const k of SETTINGS_LISTS) if (Array.isArray(src[k])) out[k] = renameServers(src[k]);
  return out;
}

function pickEntry(src: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ENTRY_LISTS) if (Array.isArray(src?.[k])) out[k] = renameServers(src[k]);
  if (typeof src?.hasTrustDialogAccepted === 'boolean') {
    out.hasTrustDialogAccepted = src.hasTrustDialogAccepted;
  }
  return out;
}

const pickServers = (src: any): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(src ?? {}).map(([name, spec]: [string, any]) => [
      fakeServer.get(name) ?? 'srv-unmapped',
      MCP_TYPES.has(spec?.type) ? { type: spec.type } : {},
    ]),
  );

// ---------------------------------------------------------------------------
// 4. Local-scope probes.
//
// No project on this machine sets `enabledPlugins` in a `settings.local.json`. Across
// the captured pairs the deciding scope tallies user/project/local = 947/19/0, and
// mutation testing confirms the consequence: demote `local` below `user` in
// `precedenceOf` and the replay still passes. An entire precedence scope has a gate
// that cannot fail -- and it is the scope Phase 2 writes to.
//
// So the *input* is constructed here: two directories carrying config nothing on this
// machine happens to have. The *expectation* is not. Each is handed to the real
// `claude plugin list --json` in a scratch directory and whatever it answers is what
// the fixture records, which preserves the property the gate rests on -- no human
// wrote an expected value anywhere in this fixture.

const userPlugins = (pickSettings(userSettings).enabledPlugins ?? {}) as Record<string, boolean>;
const pluginIds = Object.keys(userPlugins).sort();
const userEnabled = pluginIds.find((id) => userPlugins[id] === true);
const userDisabled = pluginIds.find((id) => userPlugins[id] === false);

// Picked from the user scope rather than hardcoded, so an uninstalled plugin
// re-points the probe instead of rotting it.
const probeSpecs =
  userEnabled && userDisabled
    ? [
        // Local turns OFF what the user scope turns on.
        {
          name: 'probe-local-disable',
          settings: null,
          localSettings: { enabledPlugins: { [userEnabled]: false } },
        },
        // Local turns ON what project scope turns off -- the other direction, and the
        // only project in the fixture setting `enabledPlugins` in both files.
        {
          name: 'probe-local-enable',
          settings: { enabledPlugins: { [userDisabled]: false } },
          localSettings: { enabledPlugins: { [userDisabled]: true } },
        },
      ]
    : [];

const scratchRoot = mkdtempSync(join(tmpdir(), 'qm-probe-'));

const probes: Captured[] = probeSpecs.map((spec) => {
  const cwd = join(scratchRoot, spec.name);
  // Scratch copy and fixture copy come from the same object, so the oracle is
  // answering about exactly the bytes the fixture ships.
  if (spec.settings) writeJson(join(cwd, '.claude', 'settings.json'), spec.settings);
  writeJson(join(cwd, '.claude', 'settings.local.json'), spec.localSettings);
  return {
    fake: `${FAKE_HOME}/${spec.name}`,
    rel: spec.name,
    alive: true,
    settings: spec.settings,
    localSettings: spec.localSettings,
    mcpJson: null,
    entry: {},
    oracleCwd: cwd,
    synthetic: true,
    skillSettings: null,
    skillLocalSettings: null,
  };
});

// ---------------------------------------------------------------------------
// 4b. The skill probe.
//
// Skills are the one four-valued surface, and the redaction allowlist drops every
// captured `skillOverrides`: a skill id names what someone works on as surely as a
// directory name does, and `~/.claude/skills/` is not copied for the same reason. So the
// skills half is constructed outright, and it rides in *after* redaction rather than
// through it -- widening the allowlist must never become the way a skill reaches the
// fixture.
//
// It differs from the plugin probes above in the one way that matters. Those construct an
// input and then let the real CLI say what it resolves to. Nothing first-party reports a
// resolved `skillOverrides` -- `claude plugin list --json` answers about plugins -- so
// this project is not asked at all, and its expectation comes from `resolveSkill`. That
// makes the skill half a check that the served payload is the model, and not a check that
// the model is right. See README, "Provenance"; the precedence claim stays in
// `resolve.test.ts`, where it is asserted against the algebra rather than against a CLI.

const SKILL_PROBE_NAME = 'probe-skill-chain';

/** User scope -- and, since `~` is a project, its project scope too, deduped to `user`. */
const SKILL_USER: Record<string, SkillValue> = {
  'skill-01': 'name-only',
  'skill-02': 'off',
  'skill-03': 'name-only',
};

/** The probe's `settings.json`. */
const SKILL_PROJECT: Record<string, SkillValue> = {
  'skill-01': 'user-invocable-only', // differs from the user scope -> overridden
  'skill-02': 'off',                 // matches it                  -> restated
  'skill-03': 'off',                 // outranked below: a three-link chain
  'skill-04': 'off',                 // ... and put back below, at the default
};

/** The probe's `settings.local.json` -- the surface Phase 2 writes to. */
const SKILL_LOCAL: Record<string, SkillValue> = {
  'skill-03': 'user-invocable-only', // three links, local wins  -> overridden
  'skill-04': 'on',                  // the value it would inherit anyway -> restated
  'skill-05': 'off',                 // local alone              -> overridden
};

/**
 * Installed, and scoped by nothing.
 *
 * Every id above is a row because a settings file names it, which is the circularity
 * DEA-134 removed from `allSkillIds`: derive the axis from `skillOverrides` and a skill
 * becomes visible only once it has been scoped, when scoping is what the grid is for.
 * This one is a row because it is on disk, so the fixture exercises that source too.
 */
const SKILL_ON_DISK = 'skill-06';

const skillProbe: Captured = {
  fake: `${FAKE_HOME}/${SKILL_PROBE_NAME}`,
  rel: SKILL_PROBE_NAME,
  alive: true,
  settings: null,
  localSettings: null,
  mcpJson: null,
  entry: {},
  oracleCwd: null, // Nothing first-party answers about skills -- see above.
  synthetic: true,
  skillSettings: SKILL_PROJECT,
  skillLocalSettings: SKILL_LOCAL,
};

/** Constructed overrides ride in after redaction, never through it. */
const skillBlock = (o: Record<string, SkillValue> | null): Record<string, unknown> =>
  o ? { skillOverrides: o } : {};

const allProjects = [...captured, ...probes, skillProbe];

// ---------------------------------------------------------------------------
// 5. Emit the home tree. README.md is prose and survives a regeneration.

rmSync(join(OUT, 'home'), { recursive: true, force: true });

// The user-scope file. When `~` is a registered project this same file is also its
// project-scope file -- one path serving two scopes, which is the collision the
// resolver dedups. The fixture reproduces it by construction, not by a special case.
write('home/.claude/settings.json', { ...pickSettings(userSettings), ...skillBlock(SKILL_USER) });

// `~/.claude/skills/` is never copied -- a personal skill's directory name is as
// identifying as a project's. This one is written, and names nothing on this machine.
writeText(
  join(OUT, 'home', '.claude', 'skills', SKILL_ON_DISK, 'SKILL.md'),
  `---\nname: ${SKILL_ON_DISK}\ndescription: Constructed fixture skill. Installed, scoped by nothing.\n---\n`,
);

write('home/.claude.json', {
  numStartups: claudeJson.numStartups,
  mcpServers: pickServers(claudeJson.mcpServers),
  projects: Object.fromEntries(allProjects.map((c) => [c.fake, pickEntry(c.entry)])),
});

for (const c of allProjects) {
  if (!c.alive) continue; // A missing directory is what makes a dead entry dead.
  const files: Array<[string, any]> = [];
  // For `~` the project settings file is the user settings file already written above.
  if (c.rel && (c.settings || c.skillSettings)) {
    files.push(['.claude/settings.json', { ...pickSettings(c.settings), ...skillBlock(c.skillSettings) }]);
  }
  if (c.localSettings || c.skillLocalSettings) {
    files.push([
      '.claude/settings.local.json',
      { ...pickSettings(c.localSettings), ...skillBlock(c.skillLocalSettings) },
    ]);
  }
  if (c.mcpJson) files.push(['.mcp.json', { mcpServers: pickServers(c.mcpJson.mcpServers) }]);

  for (const [name, data] of files) write(join('home', c.rel, name), data);

  // Git does not track empty directories, and a project directory that vanishes on
  // clone reads as a dead entry -- silently dropping its pairs from the gate.
  if (!files.length) {
    const keep = join(OUT, 'home', c.rel, '.gitkeep');
    mkdirSync(join(keep, '..'), { recursive: true });
    writeFileSync(keep, '');
  }
}

// ---------------------------------------------------------------------------
// 6. The oracle, keyed by fixture path so the map lines up with the tree.

function firstPartyView(cwd: string): Array<{ id: string; enabled: boolean }> | null {
  try {
    const out = execFileSync('claude', ['plugin', 'list', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (JSON.parse(out) as any[])
      .map((p) => ({ id: String(p.id), enabled: Boolean(p.enabled) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return null;
  }
}

/**
 * Running the CLI in a scratch directory must not register it as a project.
 *
 * The check is on the set of project keys, not a hash of the whole file: every live
 * session writes telemetry into `~/.claude.json` continuously, so a byte comparison
 * reports a change within seconds of doing nothing at all. Measured: `pluginUsage`
 * moves on its own; a probe run leaves every top-level key untouched.
 */
const projectKeysBefore = new Set(Object.keys(readJson(CLAUDE_JSON_PATH).projects ?? {}));

const oracle: Record<string, Array<{ id: string; enabled: boolean }>> = {};
let unreadable = 0;
let pairs = 0;
for (const c of allProjects) {
  if (!c.oracleCwd) continue;
  const view = firstPartyView(c.oracleCwd);
  if (!view) {
    unreadable++;
    continue;
  }
  oracle[c.fake] = view;
  pairs += view.length;
}

const registered = Object.keys(readJson(CLAUDE_JSON_PATH).projects ?? {}).filter(
  (p) => !projectKeysBefore.has(p),
);
rmSync(scratchRoot, { recursive: true, force: true });
if (registered.length) {
  throw new Error(
    `probing registered ${registered.length} new project entr(y|ies) in ~/.claude.json; ` +
      `refusing to ship a fixture whose capture mutated the machine it captured`,
  );
}

write('oracle.json', oracle);

// ---------------------------------------------------------------------------
// 7. The manifest -- coverage counts, so the gate asserts against a committed number
//    instead of one copied out of prose that nobody updates. A fixture that quietly
//    shrinks becomes a diff in a tracked file.

const ws = loadFixtureWorkspace();
const decidedByScope: Record<string, number> = { user: 0, project: 0, local: 0, default: 0 };
for (const project of ws.projects.filter((p) => p.alive)) {
  for (const plugin of oracle[project.path] ?? []) {
    const scope = resolvePlugin(ws, project, plugin.id).chain.at(-1)?.scope ?? 'default';
    decidedByScope[scope] = (decidedByScope[scope] ?? 0) + 1;
  }
}

const manifest = {
  projectEntries: allProjects.length,
  oracleProjects: Object.keys(oracle).length,
  pairs,
  plugins: pluginIds.length,
  decidedByScope,
  /** Constructed input, observed expectation. See README, "Provenance". */
  probeProjects: probes.map((p) => p.fake),
  /**
   * Constructed input, resolver-checked expectation -- the third kind, and the one no
   * oracle can answer for. Live projects the oracle was not asked about, so the gate can
   * state which of its columns anchor 3 covers instead of assuming all of them.
   */
  skillProbeProjects: [skillProbe.fake],
  /**
   * The skill ids the constructed half lays down, sorted as `allSkillIds` sorts.
   *
   * Written from the *input* -- the three override blocks and the one skill on disk -- so the
   * gate compares what was laid down against what was served. Deriving it by calling
   * `allSkillIds` here would put the same function on both sides of the comparison, which
   * is the DEA-133 defect: it would agree with itself whatever that function did.
   */
  skillIds: [
    ...new Set([
      ...Object.keys(SKILL_USER),
      ...Object.keys(SKILL_PROJECT),
      ...Object.keys(SKILL_LOCAL),
      SKILL_ON_DISK,
    ]),
  ].sort((a, b) => a.localeCompare(b)),
};
write('manifest.json', manifest);

console.log('fixture written to', OUT);
console.table({
  projectEntries: allProjects.length,
  aliveProjects: allProjects.filter((c) => c.alive).length,
  deadEntries: allProjects.filter((c) => !c.alive).length,
  deadWithDenyList: allProjects.filter(
    (c) => !c.alive && (c.entry?.disabledMcpServers ?? []).length > 0,
  ).length,
  oracleProjects: Object.keys(oracle).length,
  unreadableProjects: unreadable,
  pluginProjectPairs: pairs,
  serverNamesRenamed: fakeServer.size,
  constructedSkills: manifest.skillIds.length,
  ...decidedByScope,
});
