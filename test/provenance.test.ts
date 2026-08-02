/**
 * The provenance gate: what a browser is handed, against what the resolver said.
 *
 * DEA-111 words this gate as "every cell's provenance chain must match `qm audit --json`
 * for the same (extension, project) pair". That anchor does not exist. `qm audit --json`
 * emits findings, sessions and counts -- 17KB of it, with no `chain` and no `origin`
 * anywhere in the document -- so there is nothing on that side to compare a cell against.
 * Adding per-cell provenance to the CLI to make the sentence literally true would push
 * exactly the per-file source data that `view/model.ts` exists to keep off a surface, and
 * would be a new feature wearing a test's clothes. So the anchor moves and the property
 * stays, the way the build plan's Step 3 gate was rewritten once measurement showed it
 * had no reproducible baseline to compare against.
 *
 * The property is the one `view/model.ts` states about itself: *the view is a
 * presentation of the model and never a second source of truth*. Three anchors, in
 * ascending order of how much they are worth:
 *
 *   1. served bytes  <->  `resolvePlugin` / `resolveMcpServer` / `resolveSkill`
 *   2. every link's `source`  <->  the five forms `sourceDisplays` can produce
 *   3. served bytes  <->  `claude plugin list --json`, as recorded per project
 *
 * End-to-end over a socket rather than a call to `viewFrom`, because `view.test.ts`
 * already proves the projection and that proves nothing about this trip. Between the
 * model and a browser sit JSON round-tripping, gzip, and the row/column indexing, and
 * each of the three can transpose, drop, alias or reorder a cell while `viewFrom` remains
 * exactly right. Columns are therefore mapped back to projects by `ViewProject.id` and
 * never by label or array position -- position is what a transposition corrupts, and two
 * projects can share a label.
 *
 * ## Negative controls
 *
 * A gate that cannot fail is not a gate: the differential suite skipped in its entirety
 * for months while CI stayed green (DEA-127). So five mutations ship with it, applied to
 * the parsed payload rather than to any source file, each asserted to make the gate fail
 * and to name what diverged. If one of them ever stops failing, that is a hole in the
 * gate to report -- not a mutation to delete.
 *
 * Read-only, and fixture-only. No `claude`, no `~/.claude.json`, no dependence on the
 * checkout path -- `cost-transcript.test.ts` asserts the *current* project has measured
 * sessions and so fails from any worktree (DEA-133); that pattern is deliberately not
 * copied here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { AuditContext } from '../src/detect.ts';
import type { Cell } from '../src/model.ts';
import { allMcpServerNames, allPluginIds, resolveMcpServer, resolvePlugin, resolveSkill } from '../src/resolve.ts';
import { allSkillIds, buildSkillCatalog } from '../src/skills.ts';
import type { ProjectRecord, Workspace } from '../src/surfaces/types.ts';
import { projectId, type ExtensionKind } from '../src/view/model.ts';
import { startServer, type RunningServer, type StructureResponse, type StructureRow } from '../src/view/server.ts';
import { loadFixtureWorkspace, readManifest, readOracle } from './fixtures/differential/load.ts';

// ---------------------------------------------------------------------------
// What the fixture is expected to contain
// ---------------------------------------------------------------------------

const MANIFEST = readManifest();

/**
 * Counts the manifest does not carry, pinned here.
 *
 * The generator counts plugins, because plugins are what the oracle answers about. The
 * MCP axis and the chain-link total are properties of the same capture that nothing
 * writes down, so they are computed once and pinned -- exact, never a floor. A floor low
 * enough to survive a legitimately smaller capture is also low enough for 975 pairs to
 * become five, which is the DEA-127 failure with different numbers. Regenerating the
 * fixture moves these, and moving them is an edit someone has to make on purpose.
 */
const MCP_ROWS = 39;
const CHAIN_LINKS = 1635;

/**
 * Zero, and asserted rather than tolerated.
 *
 * The fixture's redaction allowlist keeps `enabledPlugins` and the four MCP list keys and
 * drops everything else, so no `skillOverrides` survives it and no `~/.claude/skills/`
 * was ever copied. `buildSkillCatalog` therefore names nothing and the skill axis is
 * empty here -- which means anchors 1 and 2 cover plugins and MCP servers only, and a
 * regression in how a four-valued skill cell is projected would not be caught by this
 * file. `view.test.ts` covers that axis on synthetic workspaces.
 *
 * Pinned at 0 so the day the fixture grows a skill, this fails and someone has to come
 * back and take the coverage that just became available.
 */
const SKILL_ROWS = 0;

// ---------------------------------------------------------------------------
// The five display forms
// ---------------------------------------------------------------------------

/**
 * Every form a `source` may take, and the rule for which one a path gets -- restated
 * here rather than imported from `view/model.ts`.
 *
 * Imported, this anchor would assert that the module agrees with itself -- the same
 * nothing that comparing a cell against `viewFrom` would assert. Written out, a sixth
 * form or a re-pointed path costs an edit in a file called `provenance.test.ts`. It is
 * the mechanism `view.test.ts` uses for `ALLOWED_KEYS`, for the same reason.
 *
 * The order is the rule and not decoration: `~`-the-project's `.claude/settings.json`
 * *is* the user-scope file, one path serving two scopes, and the user form is the true
 * one for it.
 */
const DISPLAY_FORMS = [
  '~/.claude/settings.json',
  '~/.claude.json',
  '<project>/.claude/settings.json',
  '<project>/.claude/settings.local.json',
  '<project>/.mcp.json',
] as const;

const FORM_SET: ReadonlySet<string> = new Set(DISPLAY_FORMS);

/** The display a given absolute path earns in a given project, or null for none. */
function displayFor(ws: Workspace, record: ProjectRecord, abs: string): string | null {
  const table: Array<[string | undefined, string]> = [
    [ws.userSettings?.path, DISPLAY_FORMS[0]],
    // Project-scoped decisions in a user-scoped file. Writing this as `<project>/`
    // would hide the one surface easiest to forget is not in the project.
    [ws.claudeJson.path, DISPLAY_FORMS[1]],
    [record.settings?.path, DISPLAY_FORMS[2]],
    [record.localSettings?.path, DISPLAY_FORMS[3]],
    [record.mcpJson?.path, DISPLAY_FORMS[4]],
  ];
  for (const [path, display] of table) if (path !== undefined && path === abs) return display;
  return null;
}

/** What a real path falling through the allowlist prints as. Its presence is a finding. */
const UNRECOGNISED_SOURCE = '(unrecognised source)';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

type AnyRow = StructureRow<unknown>;

const allRows = (view: StructureResponse): AnyRow[] => [
  ...view.plugins,
  ...view.mcpServers,
  ...view.skills,
];

function resolveFor(kind: ExtensionKind, ws: Workspace, record: ProjectRecord, id: string): Cell<unknown> {
  switch (kind) {
    case 'plugin':
      return resolvePlugin(ws, record, id);
    case 'mcp':
      return resolveMcpServer(ws, record, id);
    case 'skill':
      return resolveSkill(ws, record, id);
  }
}

interface GateReport {
  columns: number;
  pairs: Record<ExtensionKind, number>;
  links: number;
  oraclePairs: number;
  failures: string[];
}

/**
 * Anchors 1 and 2, in one pass.
 *
 * They share the pass because they share the resolver call: anchor 2's expectation is the
 * absolute path off the chain link anchor 1 has already fetched. Resolving twice would
 * cost a second traversal to prove the same cell twice.
 */
function checkAgainstResolver(view: StructureResponse, ctx: AuditContext, report: GateReport): void {
  const fail = (m: string) => report.failures.push(m);
  const ws = ctx.ws;

  // Columns, by id. Every lookup below goes through this map -- never through the index
  // a cell happens to sit at, which is the thing a transposition moves.
  const columns = new Map<string, ProjectRecord>();
  for (const record of ws.projects) {
    if (record.alive) columns.set(projectId(record.path), record);
  }

  const servedIds = view.projects.map((p) => p.id);
  const unique = new Set(servedIds);
  if (unique.size !== servedIds.length) {
    for (const id of unique) {
      const labels = view.projects.filter((p) => p.id === id).map((p) => p.label);
      if (labels.length > 1) fail(`two columns share the id ${id}: ${labels.join(', ')}`);
    }
  }
  for (const p of view.projects) {
    if (!columns.has(p.id)) fail(`column ${p.label} ${p.id} is no live project of the workspace`);
  }
  for (const [id, record] of columns) {
    if (!unique.has(id)) fail(`live project ${record.path.split('/').at(-1)} ${id} got no column`);
  }
  report.columns = unique.size;

  // Rows, by id. A lost or invented row is the row axis's version of a lost column, and
  // both axes are enumerated from the same context the server was handed -- an empty
  // inventory written in here instead would agree with today's `ctx` and stop agreeing
  // the moment one grows an inventory.
  const catalog = buildSkillCatalog(ws, ctx.measurements, ctx.inventories);
  const expectedRows: Array<[ExtensionKind, string[], AnyRow[]]> = [
    ['plugin', allPluginIds(ws, ctx.inventories), view.plugins],
    ['mcp', allMcpServerNames(ws), view.mcpServers],
    ['skill', allSkillIds(catalog), view.skills],
  ];
  for (const [kind, expected, served] of expectedRows) {
    const got = served.map((r) => r.id);
    if (got.length !== expected.length || got.some((id, i) => id !== expected[i])) {
      fail(
        `${kind} rows served ${got.length}, resolver enumerates ${expected.length}` +
          ` (first difference at ${got.findIndex((id, i) => id !== expected[i])})`,
      );
    }
  }

  for (const row of allRows(view)) {
    if (row.cells.length !== view.projects.length) {
      fail(`${row.kind} ${row.id}: ${row.cells.length} cells for ${view.projects.length} columns`);
    }
    const seen = new Set<string>();

    for (const cell of row.cells) {
      const at = `${row.kind} ${row.id} @ ${cell.project}`;
      if (seen.has(cell.project)) fail(`${at}: two cells claim the same column`);
      seen.add(cell.project);

      const record = columns.get(cell.project);
      if (!record) {
        fail(`${at}: names a column no live project answers to`);
        continue;
      }
      report.pairs[row.kind]++;

      const model = resolveFor(row.kind, ws, record, row.id);
      if (!Object.is(cell.value, model.value)) {
        fail(`${at}: value served=${JSON.stringify(cell.value)} resolver=${JSON.stringify(model.value)}`);
      }
      if (cell.origin !== model.origin) {
        fail(`${at}: origin served=${cell.origin} resolver=${model.origin}`);
      }
      if (cell.chain.length !== model.chain.length) {
        fail(`${at}: chain length served=${cell.chain.length} resolver=${model.chain.length}`);
      }

      // Index-aligned, so link order is under test and not merely link membership. A
      // chain sorted the other way round names the wrong file as the winner.
      const shared = Math.min(cell.chain.length, model.chain.length);
      for (let i = 0; i < shared; i++) {
        const served = cell.chain[i]!;
        const link = model.chain[i]!;
        report.links++;

        if (served.scope !== link.scope) {
          fail(`${at}: chain[${i}].scope served=${served.scope} resolver=${link.scope}`);
        }
        if (!Object.is(served.value, link.value)) {
          fail(
            `${at}: chain[${i}].value served=${JSON.stringify(served.value)} ` +
              `resolver=${JSON.stringify(link.value)}`,
          );
        }

        // Anchor 2.
        if (!FORM_SET.has(served.source)) {
          fail(`${at}: chain[${i}].source is not one of the five forms: ${JSON.stringify(served.source)}`);
        }
        const expected = displayFor(ws, record, link.source);
        if (expected === null) {
          fail(
            `${at}: chain[${i}] comes from a file none of the five forms names, ` +
              `so the allowlist could not render it; served ${JSON.stringify(served.source)}`,
          );
        } else if (served.source !== expected) {
          fail(`${at}: chain[${i}].source served=${served.source} expected=${expected}`);
        }
      }
    }
  }
}

/**
 * Anchor 3: the recorded first-party answer.
 *
 * The strongest of the three, and the reason to bother: anchors 1 and 2 prove the view
 * agrees with this repo's resolver, and only this one can say the resolver was right.
 * Keyed through `ViewProject.id` like everything else, so a transposition fails here too
 * rather than passing because the values happened to line up somewhere.
 */
function checkAgainstOracle(view: StructureResponse, ws: Workspace, report: GateReport): void {
  const fail = (m: string) => report.failures.push(m);
  const rows = new Map(view.plugins.map((r) => [r.id, r]));

  for (const [path, expected] of Object.entries(readOracle())) {
    const record = ws.projects.find((p) => p.path === path);
    if (!record) {
      fail(`oracle names a project the fixture does not register: ${path}`);
      continue;
    }
    const column = projectId(record.path);
    if (!view.projects.some((p) => p.id === column)) {
      fail(`oracle names ${path}, which the payload has no column for`);
      continue;
    }

    for (const plugin of expected) {
      const row = rows.get(plugin.id);
      if (!row) {
        fail(`oracle names plugin ${plugin.id}, which the payload has no row for`);
        continue;
      }
      const cell = row.cells.find((c) => c.project === column);
      if (!cell) {
        fail(`plugin ${plugin.id} has no cell for column ${column}`);
        continue;
      }
      report.oraclePairs++;
      if (cell.value !== plugin.enabled) {
        fail(`plugin ${plugin.id} @ ${column}: value served=${cell.value} first-party=${plugin.enabled}`);
      }
    }
  }
}

function runGate(view: StructureResponse, ctx: AuditContext): GateReport {
  const report: GateReport = {
    columns: 0,
    pairs: { plugin: 0, mcp: 0, skill: 0 },
    links: 0,
    oraclePairs: 0,
    failures: [],
  };
  checkAgainstResolver(view, ctx, report);
  checkAgainstOracle(view, ctx.ws, report);
  return report;
}

/**
 * A transposition diverges on every pair it touches, and 900 lines saying so is not more
 * information than 10 lines and a count.
 */
function failureMessage(failures: string[]): string {
  const shown = failures.slice(0, 10);
  return (
    `\n  ${failures.length} divergence(s):\n  ${shown.join('\n  ')}` +
    (failures.length > shown.length ? `\n  ... and ${failures.length - shown.length} more` : '')
  );
}

// ---------------------------------------------------------------------------
// The server, and the bytes off it
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  encoding: string | undefined;
  body: string;
}

function get(port: number, path: string, gzip: boolean): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: gzip ? { 'accept-encoding': 'gzip' } : {},
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          resolve({
            status: res.statusCode ?? 0,
            encoding,
            body: encoding === 'gzip' ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.end();
  });
}

const ws = loadFixtureWorkspace();

/**
 * `viewFrom` asks for a price per plugin row and this gate is about structure, so the
 * index declines everything -- 42 spawns of `claude plugin details` would make the gate
 * need the CLI it is built not to need.
 */
const ctx: AuditContext = {
  ws,
  measurements: [],
  pluginCosts: { get: () => undefined, entries: () => [], size: 0 },
  scope: null,
  inventories: new Map(),
};

/**
 * The matrix is named rather than defaulted. Left to the default this reads whatever
 * `plugin-matrix.md` the machine happens to have, and the payload under inspection would
 * then differ between a laptop and a runner. Categories are not what this gate checks;
 * determinism of the bytes it checks is.
 */
const MATRIX = join(import.meta.dirname, 'fixtures', 'plugin-matrix.md');

let server: RunningServer;
/** The bytes a browser gets: gzip-decoded, then parsed. Fetched once, cloned per test. */
let served: StructureResponse;
let servedText: string;

before(async () => {
  server = await startServer(ctx, { port: 0, categoryMatrixPath: MATRIX });

  const zipped = await get(server.port, '/api/view', true);
  const plain = await get(server.port, '/api/view', false);
  assert.equal(zipped.status, 200);
  assert.equal(zipped.encoding, 'gzip', 'the compressed path was not exercised');
  assert.equal(zipped.body, plain.body, 'gzip changed the payload');

  servedText = zipped.body;
  served = JSON.parse(servedText) as StructureResponse;
});

after(async () => {
  await server.close();
});

const copy = (): StructureResponse => structuredClone(served);

// ---------------------------------------------------------------------------

describe('the served grid is the resolved model', () => {
  test('every cell agrees with the resolver, link for link', () => {
    const report = runGate(served, ctx);

    console.log(
      `    provenance: ${report.columns} columns, ` +
        `${report.pairs.plugin} plugin + ${report.pairs.mcp} mcp + ${report.pairs.skill} skill pairs, ` +
        `${report.links} chain links, ${report.oraclePairs} oracle pairs`,
    );

    assert.deepEqual(report.failures, [], failureMessage(report.failures));
  });

  /**
   * The counts, exact. A gate that quietly compared four pairs and passed is the defect
   * DEA-127 removed once already; the only defence is a number that has to be edited.
   */
  test('and it compared the whole grid, not a corner of it', () => {
    const report = runGate(served, ctx);

    assert.equal(report.columns, MANIFEST.oracleProjects, 'every live fixture project should be a column');
    assert.equal(served.plugins.length, MANIFEST.plugins);
    assert.equal(served.mcpServers.length, MCP_ROWS);
    assert.equal(served.skills.length, SKILL_ROWS);

    assert.equal(
      report.pairs.plugin,
      MANIFEST.pairs,
      'the plugin half of the grid is exactly the oracle\'s coverage, so these are the same number',
    );
    assert.equal(report.pairs.mcp, MCP_ROWS * MANIFEST.oracleProjects);
    assert.equal(report.pairs.skill, SKILL_ROWS * MANIFEST.oracleProjects);
    assert.equal(
      report.links,
      CHAIN_LINKS,
      'chain links compared changed -- if the fixture was regenerated, re-pin CHAIN_LINKS',
    );
  });

  test('every plugin cell agrees with the recorded first-party answer', () => {
    const report = runGate(served, ctx);
    assert.equal(report.oraclePairs, MANIFEST.pairs);

    // Plugins default to off, so an oracle recording nothing enabled would pass against a
    // resolver deleted outright. Both outcomes have to be in the comparison.
    const outcomes = new Set(Object.values(readOracle()).flatMap((ps) => ps.map((p) => p.enabled)));
    assert.ok(outcomes.has(true) && outcomes.has(false), `oracle records only enabled=${[...outcomes]}`);
    assert.deepEqual(report.failures, [], failureMessage(report.failures));
  });

  /**
   * `(unrecognised source)` is the boundary holding, not the boundary failing -- but it
   * means a real path fell through the allowlist, which is a finding either way. Checked
   * over the raw text rather than per link, so it cannot hide in a field this file does
   * not walk.
   */
  test('no source fell through the allowlist', () => {
    assert.ok(!servedText.includes(UNRECOGNISED_SOURCE), 'a real path fell through the allowlist');
    const forms = new Set<string>();
    for (const row of allRows(served)) {
      for (const cell of row.cells) for (const link of cell.chain) forms.add(link.source);
    }
    assert.deepEqual([...forms].filter((f) => !FORM_SET.has(f)), []);
    // And every form the fixture can reach is reached, or the check above is thin.
    assert.equal(forms.size, DISPLAY_FORMS.length, `forms seen: ${[...forms].sort().join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

/**
 * Mutations of the parsed payload, each a bug the trip from model to browser can
 * introduce without `viewFrom` being wrong. Not of any source file: the gate has to catch
 * a corrupted *payload*, which is what a transposing indexer or a lossy round-trip
 * produces.
 */
interface Mutation {
  name: string;
  apply: (view: StructureResponse) => void;
  /** Names what the failure message must say, so a gate failing for another reason shows. */
  names: RegExp;
}

/** The two columns the fixture built to differ -- see its README on `probeProjects`. */
const PROBE_COLUMNS = MANIFEST.probeProjects.map(projectId);

/** The first cell with a chain, found the same way every run. */
function firstCellWithChain(view: StructureResponse): { row: AnyRow; index: number } {
  for (const row of allRows(view)) {
    for (const [index, cell] of row.cells.entries()) {
      if (cell.chain.length > 0) return { row, index };
    }
  }
  throw new Error('no cell in the payload has a chain');
}

const MUTATIONS: Mutation[] = [
  {
    /**
     * Swapping the `projects` array alone is a no-op by construction -- the gate keys on
     * `ViewProject.id`, which is the point of it doing so. The transposition that can
     * actually happen is the cells changing which column they claim.
     *
     * Which columns are swapped decides whether there is anything to catch. Two columns
     * that resolve identically are the same column as far as a payload of resolved values
     * goes: swapping `proj-01` and `proj-02` produces 0 divergences here, and it produces
     * them because the resulting payload is not wrong, not because the gate is blind.
     * So the mutation takes the two the fixture built to differ -- the probes, which exist
     * because nothing on the captured machine decided a pair at local scope. Swapping
     * those diverges 12 times against the resolver and 4 more against the oracle.
     */
    name: 'transpose two project columns',
    apply: (view) => {
      const [a, b] = PROBE_COLUMNS;
      for (const row of allRows(view)) {
        for (const cell of row.cells) {
          if (cell.project === a) cell.project = b!;
          else if (cell.project === b) cell.project = a!;
        }
      }
    },
    names: /value served=/,
  },
  {
    name: 'drop the winning link from a chain',
    apply: (view) => {
      const { row, index } = firstCellWithChain(view);
      row.cells[index]!.chain.pop();
    },
    names: /chain length served=/,
  },
  {
    name: 'flip one cell\'s origin, leaving its value right',
    apply: (view) => {
      const cell = view.plugins[0]!.cells[0]!;
      cell.origin = cell.origin === 'inherited' ? 'overridden' : 'inherited';
    },
    names: /origin served=/,
  },
  {
    name: 'alias two distinct projects onto one column id',
    apply: (view) => {
      const [first, second] = [view.projects[0]!, view.projects[1]!];
      const doomed = second.id;
      second.id = first.id;
      for (const row of allRows(view)) {
        for (const cell of row.cells) if (cell.project === doomed) cell.project = first.id;
      }
    },
    names: /two columns share the id|two cells claim the same column/,
  },
  {
    name: 'rewrite one link\'s source as a different valid form',
    apply: (view) => {
      const { row, index } = firstCellWithChain(view);
      const link = row.cells[index]!.chain[0]!;
      link.source = link.source === DISPLAY_FORMS[0] ? DISPLAY_FORMS[2] : DISPLAY_FORMS[0];
    },
    names: /chain\[\d+\]\.source served=/,
  },
];

describe('the gate fails when the payload is wrong', () => {
  for (const mutation of MUTATIONS) {
    test(mutation.name, () => {
      const mutated = copy();
      mutation.apply(mutated);

      const report = runGate(mutated, ctx);
      assert.ok(
        report.failures.length > 0,
        `mutation "${mutation.name}" did not fail the gate -- that is a hole in the gate, ` +
          'not a mutation to delete',
      );
      assert.ok(
        report.failures.some((f) => mutation.names.test(f)),
        `the gate failed, but for the wrong reason: ${failureMessage(report.failures)}`,
      );
      // The count as well as the message: a mutation that diverges on one pair out of
      // 2,025 is caught, but only just, and that is worth seeing in the log.
      console.log(`    caught "${mutation.name}" (${report.failures.length}): ${report.failures[0]}`);
    });
  }

  /** The positive control the five above are measured against. */
  test('and passes when it is not', () => {
    assert.deepEqual(runGate(copy(), ctx).failures, []);
  });
});
