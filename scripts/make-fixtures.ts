/**
 * Rebuild `test/fixtures/local-snapshot/` from the config on this machine.
 *
 * The test suite runs against a real workspace rather than invented JSON, because the
 * shapes that matter here are the awkward ones: a project holding a value in both its
 * tracked and local settings, `~` itself registered as a project, entries pointing at
 * directories that no longer exist.
 *
 * Redaction is allowlist-first. Every value is dropped unless a rule keeps it, so a
 * key nobody anticipated cannot leak. Run with:
 *
 *     node --experimental-strip-types scripts/make-fixtures.ts
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const HOME = homedir();
const OUT = join(import.meta.dirname, '..', 'test', 'fixtures', 'local-snapshot');
const FAKE_HOME = '/Users/testuser';

/** Project-entry keys that describe configuration. Everything else is telemetry. */
const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'mcpContextUris',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disabledMcpServers',
  'enabledMcpServers',
  'hasTrustDialogAccepted',
] as const;

/** Top-level `~/.claude.json` keys the resolver and cost engine actually read. */
const ROOT_KEYS = ['numStartups', 'mcpServers', 'skillUsage', 'pluginUsage'] as const;

/** Server fields safe to keep verbatim. `env` and `headers` keep keys, lose values. */
const MCP_SAFE_FIELDS = ['type', 'url', 'command', 'args'] as const;

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

/** Replace real home paths so fixtures are identical on any machine. */
const dehome = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v).replaceAll(HOME, FAKE_HOME)) as T;

function scrubServer(server: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of MCP_SAFE_FIELDS) if (f in server) out[f] = server[f];
  // Keep the shape (a server having env at all is meaningful) but never the contents.
  for (const bag of ['env', 'headers'] as const) {
    if (server[bag] && typeof server[bag] === 'object') {
      out[bag] = Object.fromEntries(Object.keys(server[bag]).map((k) => [k, '<redacted>']));
    }
  }
  return out;
}

function pick<T extends Record<string, any>>(src: T, keys: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

function write(relPath: string, data: unknown): void {
  const full = join(OUT, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest = {
  capturedFrom: 'redacted snapshot of a live workspace',
  note: 'Regenerate with scripts/make-fixtures.ts. Do not hand-edit.',
  projects: [] as Array<{ slug: string; files: string[]; livePath: string }>,
  stats: {} as Record<string, number>,
};

// 1. User settings ----------------------------------------------------------
const userSettings = dehome(readJson(join(HOME, '.claude', 'settings.json')));
write('home/.claude/settings.json', userSettings);

// 2. ~/.claude.json, trimmed to config + usage -----------------------------
const raw = readJson(join(HOME, '.claude.json'));
const root: Record<string, any> = pick(raw, ROOT_KEYS);

root.mcpServers = Object.fromEntries(
  Object.entries(raw.mcpServers ?? {}).map(([name, s]) => [name, scrubServer(s as any)]),
);

let dead = 0;
const projects: Record<string, any> = {};
for (const [path, entry] of Object.entries<any>(raw.projects ?? {})) {
  const config = pick(entry, PROJECT_CONFIG_KEYS);
  const hasConfig = Object.entries(config).some(
    ([k, v]) => k !== 'hasTrustDialogAccepted' && Array.isArray(v) && v.length > 0,
  );
  const alive = existsSync(path);
  if (!alive) dead++;
  // Keep every entry: dead ones are the orphan detector's input, and dropping the
  // empty ones would hide how much of the file is inert.
  projects[path] = { ...config, _fixtureAlive: alive, _fixtureHasConfig: hasConfig };
}
root.projects = projects;
write('home/.claude.json', dehome(root));

// 3. Project settings files -------------------------------------------------
const PROJECT_ROOTS = [join(HOME, 'claude'), HOME];
const seen = new Set<string>();

for (const root0 of PROJECT_ROOTS) {
  for (const [path] of Object.entries<any>(raw.projects ?? {})) {
    if (!path.startsWith(root0) || !existsSync(path) || seen.has(path)) continue;
    if (path.includes('/worktrees/') || path.includes('/.cyrus/')) continue;

    const files: string[] = [];
    const slug = path === HOME ? '_home' : basename(path);

    for (const name of ['settings.json', 'settings.local.json']) {
      const src = join(path, '.claude', name);
      if (!existsSync(src)) continue;
      write(`projects/${slug}/.claude/${name}`, dehome(readJson(src)));
      files.push(`.claude/${name}`);
    }
    const mcp = join(path, '.mcp.json');
    if (existsSync(mcp)) {
      const parsed = dehome(readJson(mcp));
      if (parsed.mcpServers) {
        parsed.mcpServers = Object.fromEntries(
          Object.entries(parsed.mcpServers).map(([n, s]) => [n, scrubServer(s as any)]),
        );
      }
      write(`projects/${slug}/.mcp.json`, parsed);
      files.push('.mcp.json');
    }

    if (files.length) {
      seen.add(path);
      manifest.projects.push({ slug, files, livePath: path.replace(HOME, FAKE_HOME) });
    }
  }
}

manifest.stats = {
  projectEntries: Object.keys(projects).length,
  deadPaths: dead,
  fixturedProjects: manifest.projects.length,
  globalPlugins: Object.keys(userSettings.enabledPlugins ?? {}).length,
  topLevelMcpServers: Object.keys(root.mcpServers).length,
};

write('MANIFEST.json', manifest);

console.log('fixtures written to', OUT);
console.table(manifest.stats);
