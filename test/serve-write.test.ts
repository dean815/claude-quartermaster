/**
 * The first thing on this socket that can change a file, and everything that stops it.
 *
 * `serve.test.ts` gates the read stack on the bytes off the socket. None of it covers a
 * write: it was built when "who may ask" meant "which page", and the question a `POST`
 * asks is "which *program*". Every process on this machine can reach `127.0.0.1`, so the
 * properties gated here are the ones that fail silently and cost a user's configuration.
 *
 * ## The mutation harness
 *
 * `POST_CHECKS` is a list rather than a chain of `if`s so this file can drop exactly one
 * guard and re-run the request it exists for. `dropping one check reddens the gate` does
 * that per check and asserts two things: the hostile request that guard refuses is now
 * **accepted**, and every *other* hostile request is still refused. The second half is
 * what makes the gate specific -- a mutation that reddens something else is not the gate
 * working (CLAUDE.md's rule, and how QM-43, QM-46 and QM-47 each found a hole).
 *
 * ## What is real and what is not
 *
 * The workspace is built here on disk under `mkdtempSync`, and the writes are real writes
 * to it: a plan that never touched a file would prove nothing about `applyPlan`. Nothing
 * spawns `claude`, and `stateDir` is injected, so no backup and no undo record lands in
 * the real one.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuditContext } from '../src/detect.ts';
import type { PluginInventory } from '../src/inventory.ts';
import { NOT_CHECKED, readSettings } from '../src/surfaces/read.ts';
import type { ClaudeJson, SettingsFile, Workspace } from '../src/surfaces/types.ts';
import { TARGET_FILENAME, targetFor } from '../src/toggle.ts';
import { planView, projectId } from '../src/view/model.ts';
import { POST_CHECKS, startServer, type PostCheck, type RunningServer } from '../src/view/server.ts';
import { project } from './factories.ts';

// ---------------------------------------------------------------------------
// A world on disk, with nothing real in it
// ---------------------------------------------------------------------------

/**
 * One plugin per scenario, and the reason is a property of the thing being tested.
 *
 * The workspace is read once, at startup, and served from memory -- that is the grid's
 * documented rule and `qm serve` prints it. So after a write lands, the *model* still says
 * what the file said before it, and a second plan for the same row is refused `no-change`
 * against a value that has since moved. Harmless (the entry `applyPlan` checks and writes
 * is read off the file, not off the model) and confusing to test around, so each scenario
 * owns an id nothing else touches and the shared state between tests is zero.
 *
 * All of them are installed, so `attestPluginId` is quiet and no scenario is measuring the
 * unattested-id note by accident.
 */
const P = {
  gate: 'gate@market',
  fresh: 'fresh@market',
  substitution: 'substitution@market',
  replay: 'replay@market',
  payload: 'payload@market',
  applyShape: 'apply-shape@market',
  terminal: 'terminal@market',
} as const;

const PLUGINS: string[] = Object.values(P);

/** The row every scenario that does not write uses. */
const PLUGIN = P.gate;

/**
 * Planted in the *existing* target's own bytes.
 *
 * `plan.before` and `plan.after` are the whole text of that file. The point of leaving
 * them off the wire is that a settings file carries keys nobody here has named -- so the
 * gate plants one and sweeps the payload for it, which is the same shape as
 * `view.test.ts`'s fails-open canary and the same reason.
 */
const CANARY_KEY = 'qmCanaryUnknownSetting';
const CANARY_VALUE = 'CANARY-in-the-target-file-7b31d0';

let root = '';
let state = '';
let fresh = '';
let existing = '';
let dead = '';
let ctx: AuditContext;
let server: RunningServer;
let logged: string[] = [];

const inventory = (id: string): PluginInventory => ({
  id,
  installPath: null,
  version: null,
  sha: null,
  manifestName: null,
  installed: null,
  // Enumerated with no MCP server, so `classify` answers `reload` from a catalog rather
  // than from the absence of transcripts.
  enumerated: [
    { source: 'catalog', names: [], skillNames: [], mcpServerNames: [], sha: null, version: null, fetchedAt: null },
  ],
});

const claudeJson = (path: string): ClaudeJson => ({
  path,
  mcpServers: {},
  projects: {},
  claudeAiMcpEverConnected: [],
  skillUsage: {},
  pluginUsage: {},
});

function buildWorld(): AuditContext {
  root = mkdtempSync(join(tmpdir(), 'qm-serve-write-'));
  state = join(root, 'state');
  const home = join(root, 'home');
  fresh = join(root, 'fresh');
  existing = join(root, 'existing');
  dead = join(root, 'gone');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(fresh, '.claude'), { recursive: true });
  mkdirSync(join(existing, '.claude'), { recursive: true });

  // Two-space indented, the way Claude Code writes it, so `write.ts` has a layout to copy.
  const localBlock = Object.fromEntries(PLUGINS.map((id) => [id, false]));
  writeFileSync(
    targetFor(existing),
    `${JSON.stringify({ enabledPlugins: localBlock, [CANARY_KEY]: CANARY_VALUE }, null, 2)}\n`,
  );

  const userSettings: SettingsFile = {
    path: join(home, '.claude', 'settings.json'),
    validity: 'not-checked',
    schemaErrors: [],
    droppedRuleElements: {},
    // Every id is `true` above and `false` in the project, so a plan for `on` in
    // `existing` moves a real entry and a plan for `on` in `fresh` is a `no-change`.
    enabledPlugins: Object.fromEntries(PLUGINS.map((id) => [id, true])),
    rest: {},
  };

  const ws: Workspace = {
    home,
    userSettings,
    userRules: [],
    personalSkills: [],
    claudeJson: claudeJson(join(home, '.claude.json')),
    projects: [
      project(fresh, { localSettings: null }),
      project(existing, {
        localSettings: readSettings(targetFor(existing), NOT_CHECKED),
      }),
      // Registered once and gone since. `viewFrom` draws no column for it, and the point
      // of the test below is that not drawing one is what makes it unwritable.
      project(dead, { alive: false, localSettings: null }),
    ],
  };

  return {
    ws,
    measurements: [],
    pluginCosts: new Map(),
    scope: null,
    inventories: new Map(PLUGINS.map((id) => [id, inventory(id)])),
  };
}

before(async () => {
  ctx = buildWorld();
  server = await startServer(ctx, {
    port: 0,
    stateDir: state,
    log: (lines) => logged.push(...lines),
  });
});

after(async () => {
  await server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RequestOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string;
}

function request(port: number, path: string, opts: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? {}, timeout: 5_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Everything a legitimate write request carries, for the port and token in play. */
function writeHeaders(port: number, token: string): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${port}`,
    'x-qm-token': token,
    'content-type': 'application/json',
  };
}

function post(srv: RunningServer, path: string, body: unknown, extra: RequestOptions = {}): Promise<Reply> {
  return request(srv.port, path, {
    method: 'POST',
    headers: { ...writeHeaders(srv.port, srv.token), ...(extra.headers ?? {}) },
    body: JSON.stringify(body),
    ...(extra.method ? { method: extra.method } : {}),
  });
}

const column = (dir: string): string => projectId(dir);
const planBody = (dir: string, plugin: string, value: boolean) => ({ project: column(dir), plugin, value });

/** Absolute-looking, on either spelling. The same rule `view.test.ts` applies. */
function looksAbsolute(s: string): boolean {
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || s.includes('/Users/') || s.includes('/home/');
}

function stringsIn(json: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') return void out.push(v);
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === 'object') for (const c of Object.values(v)) walk(c);
  };
  walk(JSON.parse(json));
  return out;
}

function keysIn(json: string): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        out.add(k);
        walk(child);
      }
    }
  };
  walk(JSON.parse(json));
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * One hostile request per guard, and the refusal it must produce.
 *
 * `check` names the entry of `POST_CHECKS` that is supposed to be the *only* thing
 * standing between this request and a plan. The harness below removes exactly that entry
 * and requires this row -- and no other -- to start passing.
 */
interface GateCase {
  check: string;
  label: string;
  status: number;
  headers(port: number, token: string): Record<string, string>;
}

const GATE: GateCase[] = [
  {
    check: 'csrf-token',
    label: 'no token at all: what a local process has',
    status: 403,
    headers: (port) => {
      const h = writeHeaders(port, '');
      delete h['x-qm-token'];
      return h;
    },
  },
  {
    check: 'origin-present',
    label: 'no Origin: what a browser never sends and a program always can',
    status: 403,
    headers: (port, token) => {
      const h = writeHeaders(port, token);
      delete h['origin'];
      return h;
    },
  },
  {
    check: 'origin-loopback',
    label: 'an Origin from someone else',
    status: 403,
    headers: (port, token) => ({ ...writeHeaders(port, token), origin: 'https://evil.example.com' }),
  },
  {
    check: 'json-body',
    label: 'the content type a cross-origin form can send without a preflight',
    status: 415,
    headers: (port, token) => ({ ...writeHeaders(port, token), 'content-type': 'text/plain' }),
  },
];

describe('who may write', () => {
  for (const row of GATE) {
    test(`${row.label} is refused`, async () => {
      const res = await request(server.port, '/api/plan', {
        method: 'POST',
        headers: row.headers(server.port, server.token),
        body: JSON.stringify(planBody(existing, PLUGIN, true)),
      });
      assert.equal(res.status, row.status, row.label);
      assert.equal(existsSync(targetFor(fresh)), false, 'a refused request created a file');
    });
  }

  test('a token of the right length but the wrong bytes is refused', async () => {
    const wrong = 'f'.repeat(server.token.length);
    assert.notEqual(wrong, server.token);
    const res = await post(server, '/api/plan', planBody(existing, PLUGIN, true), {
      headers: { 'x-qm-token': wrong },
    });
    assert.equal(res.status, 403);
  });

  test('and so is one of the wrong length, rather than throwing', async () => {
    for (const token of ['', 'abc', server.token + 'a', server.token.slice(0, -1)]) {
      const res = await post(server, '/api/plan', planBody(existing, PLUGIN, true), {
        headers: { 'x-qm-token': token },
      });
      assert.equal(res.status, 403, JSON.stringify(token.slice(0, 8)));
    }
  });

  test('a Host that is not loopback is refused on a write too', async () => {
    const res = await post(server, '/api/plan', planBody(existing, PLUGIN, true), {
      headers: { host: 'evil.example.com' },
    });
    assert.equal(res.status, 403);
  });

  test('a body larger than any request here could mean is refused unread', async () => {
    const res = await post(server, '/api/plan', {
      ...planBody(existing, PLUGIN, true),
      pad: 'x'.repeat(64 * 1024),
    });
    assert.equal(res.status, 413);
  });

  test('and a body that is not an object is a bad request', async () => {
    for (const body of ['[]', '"planned"', 'null', 'not json at all']) {
      const res = await request(server.port, '/api/plan', {
        method: 'POST',
        headers: writeHeaders(server.port, server.token),
        body,
      });
      assert.equal(res.status, 400, body);
    }
  });

  test('the token is not served over any endpoint, only in the URL fragment', async () => {
    for (const path of ['/', '/api/view', `/api/cost?plugin=${encodeURIComponent(PLUGIN)}`]) {
      const res = await request(server.port, path);
      assert.ok(!res.body.includes(server.token), `${path} handed out the write token`);
    }
    // The fragment is the delivery, and it is never sent to a server by any client.
    assert.ok(server.url.includes(`#t=${server.token}`), server.url);
  });
});

/**
 * The gate, mutated.
 *
 * Each check is removed in turn from a fresh server and the whole table is re-run. The
 * removal must cost exactly its own refusal: the row it guards is accepted, and every
 * other row still refuses. A mutation that reddens two rows has not proved anything about
 * either.
 */
describe('dropping one check reddens the gate', () => {
  for (const dropped of POST_CHECKS) {
    test(`without ${dropped.name}`, async () => {
      const weakened = await startServer(ctx, {
        port: 0,
        stateDir: state,
        postChecks: POST_CHECKS.filter((c: PostCheck) => c !== dropped),
      });
      try {
        for (const row of GATE) {
          const res = await request(weakened.port, '/api/plan', {
            method: 'POST',
            headers: row.headers(weakened.port, weakened.token),
            body: JSON.stringify(planBody(existing, PLUGIN, true)),
          });
          if (row.check === dropped.name) {
            assert.equal(
              res.status,
              200,
              `${dropped.name} was removed and ${JSON.stringify(row.label)} was still refused ` +
                `with ${res.status} — something other than this check is doing its work`,
            );
          } else {
            assert.equal(
              res.status,
              row.status,
              `removing ${dropped.name} also let ${JSON.stringify(row.label)} through — the ` +
                'mutation is not specific to the guard it names',
            );
          }
        }
      } finally {
        await weakened.close();
      }
    });
  }

  test('and the table covers every check, so none of them is unexercised', () => {
    assert.deepEqual(
      POST_CHECKS.map((c) => c.name).sort(),
      [...new Set(GATE.map((g) => g.check))].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The plan is the server's
// ---------------------------------------------------------------------------

describe('planning changes nothing, and says what it would change', () => {
  test('a plan for a fresh project creates nothing yet', async () => {
    const res = await post(server, '/api/plan', planBody(fresh, P.fresh, false));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.outcome, 'planned');
    assert.equal(body.plan.creates, true);
    assert.equal(body.plan.target, '<project>/.claude/settings.local.json');
    assert.deepEqual(body.plan.changes, [
      { id: P.fresh, from: true, to: false, wasInFile: null, willBeInFile: false, effect: 'reload' },
    ]);
    assert.equal(existsSync(targetFor(fresh)), false, 'planning created the file');
  });

  test('a refusal is an outcome, not an HTTP error', async () => {
    // `fresh` inherits `true` from user scope, so asking for `on` is `no-change`.
    const res = await post(server, '/api/plan', planBody(fresh, P.fresh, true));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { outcome: 'refused', refusals: ['no-change'] });
  });

  test('a column the grid never published is not a directory this will write', async () => {
    const res = await post(server, '/api/plan', {
      project: projectId('/etc'),
      plugin: PLUGIN,
      value: false,
    });
    assert.equal(res.status, 404);
  });

  test('nor is a path sent in place of a column', async () => {
    for (const project of [fresh, '../../etc', '/etc/passwd', '']) {
      const res = await post(server, '/api/plan', { project, plugin: PLUGIN, value: false });
      assert.equal(res.status, 404, project);
    }
  });

  /**
   * The column set and the writable set are one expression, and this is what says so.
   *
   * A directory Claude Code registered and which no longer exists is in the workspace and
   * is not a column -- `viewFrom` filters it out, so the grid draws nothing for it. Nothing
   * about `planToggles` would stop a write there: the record exists, so it would plan, and
   * `applyPlan` would `mkdirSync` the directory back into being. What stops it is that
   * `columnPaths` answers for exactly the set `viewFrom` drew. Pointing it at
   * `ws.projects` instead left the whole suite green until this existed.
   */
  test('a project the grid drew no column for is not writable', async () => {
    const res = await post(server, '/api/plan', planBody(dead, PLUGIN, false));
    assert.equal(res.status, 404);
    assert.equal(existsSync(dead), false, 'a plan brought a dead project back');
  });

  test('and neither is one outside a scoped run', async () => {
    const scoped = await startServer({ ...ctx, scope: existing }, { port: 0, stateDir: state });
    try {
      assert.equal((await post(scoped, '/api/plan', planBody(fresh, P.fresh, false))).status, 404);
      // The scoped project itself still plans, so this is a narrowing and not a breakage.
      const ok = await post(scoped, '/api/plan', planBody(existing, PLUGIN, true));
      assert.equal(ok.status, 200);
      assert.equal(JSON.parse(ok.body).outcome, 'planned');
    } finally {
      await scoped.close();
    }
  });

  test('and an id no row carries is refused before anything is planned', async () => {
    for (const plugin of ['nope@nowhere', 'alpha', '']) {
      const res = await post(server, '/api/plan', { project: column(fresh), plugin, value: false });
      assert.equal(res.status, 404, plugin);
    }
  });

  test('the value is a boolean, not whatever JSON arrived', async () => {
    for (const value of ['off', 0, null, {}]) {
      const res = await post(server, '/api/plan', { project: column(fresh), plugin: PLUGIN, value });
      assert.equal(res.status, 400, JSON.stringify(value));
    }
  });
});

describe('applying names a plan this server is holding, and no other', () => {
  test('a handle nothing minted is refused, and writes nothing', async () => {
    for (const plan of ['', 'deadbeef', 'a'.repeat(32)]) {
      const res = await post(server, '/api/apply', { plan });
      assert.equal(res.status, 409, plan);
      assert.equal(res.body, '{"error":"stale_plan"}');
    }
    assert.equal(existsSync(targetFor(fresh)), false);
  });

  /**
   * The substitution case, stated as bytes.
   *
   * A client cannot send a plan, so it cannot send a *different* plan. What it can do is
   * send a handle with a plausible-looking plan beside it -- and the write that lands must
   * be the one the server computed and printed, not the one in the request.
   */
  test('a plan-shaped body beside the handle is ignored entirely', async () => {
    const planned = JSON.parse(
      (await post(server, '/api/plan', planBody(existing, P.substitution, true))).body,
    );
    assert.equal(planned.outcome, 'planned');

    const applied = JSON.parse(
      (
        await post(server, '/api/apply', {
          plan: planned.plan.id,
          // Everything a client might hope decides the write.
          target: targetFor(fresh),
          project: column(fresh),
          creates: true,
          changes: [{ id: 'other@market', from: false, to: true, wasInFile: null, willBeInFile: true }],
          edits: [{ path: ['enabledPlugins', 'other@market'], value: true }],
        })
      ).body,
    );
    assert.equal(applied.outcome, 'written', JSON.stringify(applied));

    const after = JSON.parse(readFileSync(targetFor(existing), 'utf8'));
    assert.equal(after.enabledPlugins[P.substitution], true, 'the planned entry did not land');
    assert.equal('other@market' in after.enabledPlugins, false, 'the request decided a write');
    assert.equal(existsSync(targetFor(fresh)), false, 'the request decided which file was written');
    // Surgical: the key nobody named survives the write it was not about.
    assert.equal(after[CANARY_KEY], CANARY_VALUE);
  });

  test('and the same handle a second time is stale, not a second write', async () => {
    const planned = JSON.parse(
      (await post(server, '/api/plan', planBody(existing, P.replay, true))).body,
    );
    assert.equal(planned.outcome, 'planned');
    const first = await post(server, '/api/apply', { plan: planned.plan.id });
    assert.equal(JSON.parse(first.body).outcome, 'written');

    const second = await post(server, '/api/apply', { plan: planned.plan.id });
    assert.equal(second.status, 409);
    assert.equal(JSON.parse(readFileSync(targetFor(existing), 'utf8')).enabledPlugins[P.replay], true);
  });

  test('a write leaves a backup and an undo record, in the injected state directory', () => {
    const record = JSON.parse(readFileSync(join(state, 'last-apply.json'), 'utf8'));
    assert.equal(record.axis, 'plugin');
    assert.equal(record.target, targetFor(existing));
    assert.ok(readdirSync(join(state, 'backups')).length > 0, 'no backup was kept');
  });
});

// ---------------------------------------------------------------------------
// What crosses
// ---------------------------------------------------------------------------

/**
 * The allowlist, written out here rather than imported.
 *
 * Imported, this asserts the module agrees with itself. Written here, a field that reaches
 * the payload without anyone deciding it should fails the suite, and adding one costs an
 * edit in a file called `serve-write.test.ts`. Same mechanism as `view.test.ts`'s, and the
 * same reason: an allowlist is only worth something if widening it is deliberate.
 */
const ALLOWED_KEYS = new Set([
  // PlanResponse
  'outcome', 'plan', 'refusals',
  // PlanView
  'id', 'axis', 'project', 'projectLabel', 'target', 'creates', 'changes', 'notes', 'effect',
  // PlanChangeView
  'from', 'to', 'wasInFile', 'willBeInFile',
]);

describe('the plan payload names its fields', () => {
  let body = '';

  before(async () => {
    body = (await post(server, '/api/plan', planBody(existing, P.payload, true))).body;
    assert.equal(JSON.parse(body).outcome, 'planned');
  });

  test('and publishes no key this file has not named', () => {
    assert.deepEqual([...keysIn(body)].filter((k) => !ALLOWED_KEYS.has(k)), []);
  });

  test('no string in it is an absolute path', () => {
    assert.deepEqual(stringsIn(body).filter(looksAbsolute), []);
  });

  test('not the project, not the target, not the home', () => {
    for (const path of [root, fresh, existing, targetFor(existing), ctx.ws.home]) {
      assert.ok(!body.includes(path), `${path} reached the wire`);
    }
  });

  /**
   * The reason `before` and `after` are not fields.
   *
   * They are the whole text of a settings file, which carries every key the readers do not
   * name. A projection that sent the diff would send this canary with it, and would send
   * whatever the next Claude Code release puts in that file.
   */
  test('nor anything out of the target file that the readers do not name', () => {
    assert.ok(!body.includes(CANARY_VALUE), 'the file’s own text crossed');
    assert.ok(!body.includes(CANARY_KEY), 'a key nobody named crossed');
  });

  test('what a reviewer needs did survive', () => {
    const { plan } = JSON.parse(body);
    assert.equal(plan.axis, 'plugin');
    assert.equal(plan.project, column(existing));
    assert.equal(plan.projectLabel, 'existing');
    assert.equal(plan.target, '<project>/.claude/settings.local.json');
    assert.equal(plan.creates, false);
    assert.equal(plan.effect, 'reload');
    assert.match(plan.id, /^[0-9a-f]{32}$/);
    assert.deepEqual(plan.changes, [
      { id: P.payload, from: false, to: true, wasInFile: false, willBeInFile: true, effect: 'reload' },
    ]);
  });

  test('and a note crosses as its code, never as its sentence', () => {
    const { plan } = JSON.parse(body);
    assert.ok(Array.isArray(plan.notes), 'notes is not a list');
    for (const n of plan.notes) {
      assert.equal(typeof n, 'string');
      // Codes are hyphenated words. A sentence would have spaces in it, and a path.
      assert.match(n, /^[a-z-]+$/, n);
    }
  });

  /**
   * The target display is a lookup by identity, and this is the case that has no recording.
   *
   * Every plan reaching `planView` in this program was built by `planToggles`, whose target
   * *is* `axis.target(...)` -- so the branch that refuses to name a path the axis did not
   * build is unreachable through the server, and deleting it left the suite green. It is a
   * tripwire rather than a live guard, in `attestMcpName`'s `marketplace-id` sense, so the
   * case is **constructed** and labelled as such: a plan handed a foreign target, straight
   * to the projection.
   */
  test('a target no axis built is named as unrecognised, not printed', () => {
    const forged = {
      axis: { name: 'plugin', target: () => targetFor(existing) },
      project: existing,
      target: '/etc/claude/settings.local.json',
      creates: false,
      before: '',
      after: '',
      edits: [],
      changes: [],
      notes: [],
    } as unknown as Parameters<typeof planView>[1];

    const view = planView(ctx, forged, 'constructed');
    assert.equal(view?.target, '(unrecognised source)');
  });

  test('an apply answers in the same currency', async () => {
    const planned = JSON.parse(
      (await post(server, '/api/plan', planBody(existing, P.applyShape, true))).body,
    );
    const res = await post(server, '/api/apply', { plan: planned.plan.id });
    const applied = JSON.parse(res.body);
    assert.deepEqual(Object.keys(applied).sort(), ['bytes', 'outcome', 'rebased']);
    assert.deepEqual(stringsIn(res.body).filter(looksAbsolute), []);
    // The backup path is a real thing the run produced and it is a path, so it goes to the
    // terminal rather than to the browser.
    assert.ok(!res.body.includes(state), 'the state directory reached the wire');
  });
});

describe('the terminal gets what the browser does not', () => {
  test('the whole plan, the diff and the paths', async () => {
    logged = [];
    const planned = JSON.parse(
      (await post(server, '/api/plan', planBody(existing, P.terminal, true))).body,
    );
    const text = logged.join('\n');
    assert.ok(text.includes(planned.plan.id), 'the handle is not in the log');
    assert.ok(text.includes(targetFor(existing)), 'the target path is not in the log');
    assert.ok(text.includes('enabledPlugins'), 'the key is not in the log');
    assert.ok(text.includes('--- before'), 'the diff is not in the log');
    assert.ok(text.includes(`${P.terminal}: false -> true`), text);

    logged = [];
    await post(server, '/api/apply', { plan: planned.plan.id });
    const applied = logged.join('\n');
    assert.ok(applied.includes('backup'), applied);
    assert.ok(applied.includes(targetFor(existing)), applied);
  });

  test('and a refusal too, with the evidence the payload drops', async () => {
    logged = [];
    await post(server, '/api/plan', planBody(fresh, P.fresh, true));
    const text = logged.join('\n');
    assert.ok(text.includes('no-change'), text);
    assert.ok(text.includes('already resolves'), text);
  });
});

/**
 * The property the issue asks for last and which is the easiest to lose: a server nobody
 * interacts with is still a server that has written nothing.
 */
describe('a run with no interaction writes nothing', () => {
  test('reads alone leave the workspace and the state directory as they were', async () => {
    const quietRoot = mkdtempSync(join(tmpdir(), 'qm-serve-quiet-'));
    const quietState = join(quietRoot, 'state');
    const quiet = await startServer(ctx, { port: 0, stateDir: quietState });
    try {
      for (const path of ['/', '/api/view', `/api/cost?plugin=${encodeURIComponent(PLUGIN)}`, '/nope']) {
        await request(quiet.port, path);
      }
      assert.equal(existsSync(quietState), false, 'a read created the state directory');
      assert.equal(existsSync(targetFor(fresh)), false, 'a read created a settings file');
      assert.deepEqual(readdirSync(join(fresh, '.claude')), [], 'a read wrote into the project');
      assert.deepEqual(
        readdirSync(join(existing, '.claude')),
        [TARGET_FILENAME],
        'a read added a file to the project',
      );
    } finally {
      await quiet.close();
      rmSync(quietRoot, { recursive: true, force: true });
    }
  });
});
