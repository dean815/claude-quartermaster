/**
 * The grid's server: slice 1's projection, over a loopback socket.
 *
 * Two things decide the shape of this file.
 *
 * **What it serves is the whole machine's resolved configuration.** Every project, every
 * extension, every file that decided a value. So the socket binds `127.0.0.1` explicitly
 * -- not the default, which is every interface -- and a request whose `Host` or `Origin`
 * is not loopback is refused, because a name in someone else's DNS zone can point at
 * 127.0.0.1 and a browser will happily send the request. No CORS headers are emitted:
 * there is no legitimate cross-origin consumer, and the absent header is what stops one.
 *
 * **A price is a subprocess.** `ctx.pluginCosts.get` spawns `claude plugin details` on a
 * cache miss, ~0.6s each, and 42 plugins are installed -- so a `viewFrom` that prices
 * every row is ~25s before a browser could paint anything. The endpoints split on that
 * line rather than on subject matter: `/api/view` is everything obtainable without
 * spawning anything, and `/api/cost` is one plugin's price per request. A grid with no
 * prices is useful; a grid that arrives after 25s is not.
 *
 * ## The write path, and why the read stack does not cover it (QM-44)
 *
 * Two `POST` routes, plugins only: `/api/plan` asks `planToggles` what a toggle would do,
 * and `/api/apply` applies **a plan this process is holding**, by handle. Everything above
 * was built for reads, and each of its layers answers a question a write asks differently.
 *
 * **`Origin` was checked `if (origin !== undefined)`.** That is right for a browser, which
 * always sends one, and worth nothing against a local process, which simply omits the
 * header. On `POST` the header is *required*, so an omission is a refusal rather than a
 * pass -- but that only narrows the gap, because a local process can send any `Origin` it
 * likes. What closes it is a **token**: 32 random bytes minted per process, printed by
 * `qm serve` in the URL fragment, and required on both `POST` routes. A fragment is never
 * sent to a server, so the token reaches the page that was opened from the terminal and
 * reaches nothing that merely knows the port. It is compared with `timingSafeEqual`, it is
 * sent in a header rather than a query string, and a custom header is itself a second
 * barrier: it forces a CORS preflight that this server, emitting no CORS headers, fails.
 *
 * **Loopback is not trusted.** The read model was "a web page cannot read this"; every
 * process on this machine can reach `127.0.0.1`, so the write model is "another program
 * cannot write your config", and only the token says that.
 *
 * **Consent stays here.** The browser never sends a plan. `/api/plan` computes one with
 * `planToggles`, keeps it in this process, and returns a *projection* (`view/model.ts`);
 * `/api/apply` names it by handle, and a handle this process is not holding is refused --
 * the way `applyStage` refuses on drift. So a substituted or edited plan is not something
 * the wire can express, and the diff the user approved is the diff `applyPlan` is given.
 *
 * `ServeOptions.log` is where the whole plan goes -- `describePlan`, verbatim, into the
 * terminal that started the server. The browser payload carries codes and closed value
 * domains and no prose (see `view/model.ts`), so the terminal is where the full text and
 * the absolute paths live. It is also the audit trail: nothing is planned or written here
 * without a line in the window the operator is looking at.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

import { applyPlan, stateDir } from '../apply.ts';
import { categorise, readMatrix } from '../category.ts';
import type { PluginCostIndex } from '../cost/plugins.ts';
import type { AuditContext } from '../detect.ts';
import type { McpValue, PluginValue, SkillValue } from '../model.ts';
import { PLUGIN_AXIS, describePlan, planToggles, type TogglePlan } from '../toggle.ts';
import {
  applyView,
  columnPaths,
  planView,
  viewFrom,
  type ApplyView,
  type ExtensionCost,
  type ExtensionRow,
  type PlanView,
  type ViewProject,
} from './model.ts';
import { PAGE } from './page.ts';
import { renderSessions } from './sessions.ts';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * A row as `/api/view` sends it: everything about an extension except what it costs.
 *
 * `cost` is dropped rather than sent as `null`. `null` is `viewFrom`'s answer to "this
 * was asked about and nothing could price it", which is a real finding a grid should
 * render as such; a row nobody has asked about yet must not claim it.
 */
export type StructureRow<V> = Omit<ExtensionRow<V>, 'cost'>;

/** `GET /api/view`. Everything the grid needs to draw itself. */
export interface StructureResponse {
  /**
   * When this snapshot was read off disk.
   *
   * The process is the snapshot: the workspace is read once at startup and served from
   * memory, so an edit to a settings file shows up on restart, not on refresh. That is
   * the same rule Claude Code itself follows -- a running session keeps its startup set.
   */
  generatedAt: string;
  projects: ViewProject[];
  plugins: StructureRow<PluginValue>[];
  mcpServers: StructureRow<McpValue>[];
  skills: StructureRow<SkillValue>[];
  /**
   * Bucket per plugin id, for the ids `project-optimizer`'s matrix names.
   *
   * A parallel map rather than a field on the row, because the fact is not a property of
   * the resolved configuration: it comes from a document outside this repo and is absent
   * on a machine that does not have it. On the row, that absence would have to be spelled
   * as a `null` on all 42 of them, which reads as "asked and unknown" -- the distinction
   * `cost` is dropped rather than nulled to preserve.
   *
   * `null` means no matrix was read, and the category filter does not exist. An id absent
   * from a non-null map is uncategorised. Never a guess: see `category.ts`.
   */
  categories: Record<string, string> | null;
}

/** `GET /api/cost?plugin=<id>`. One row's price, paid for at the moment it is asked. */
export interface CostResponse {
  plugin: string;
  /** `null` means asked and unanswerable -- no CLI, or output that did not parse. */
  cost: ExtensionCost | null;
}

/**
 * `POST /api/plan`. What a toggle would do, and nothing done.
 *
 * A refusal is a 200 with an outcome, not an error status: "this write would change
 * nothing" is an answer `planToggles` computed, and the grid renders it. The HTTP failures
 * above it are about the *request* -- who asked, and whether the fields are there.
 */
export type PlanResponse =
  | { outcome: 'planned'; plan: PlanView }
  | { outcome: 'refused'; refusals: string[] };

/** `POST /api/apply`. The plan named by handle, applied. */
export type ApplyResponse = ApplyView;

// ---------------------------------------------------------------------------

/**
 * Loopback, explicitly.
 *
 * `listen(port)` with no host binds `::`/`0.0.0.0`, which publishes every project on this
 * machine to the LAN. There is no configuration knob for this on purpose.
 */
const HOST = '127.0.0.1';

/**
 * Unassigned by IANA, not a default for any common dev server, and below the ephemeral
 * range the OS allocates outbound sockets from (49152 on macOS and Linux) -- so a port
 * that is free stays free between runs.
 */
export const DEFAULT_PORT = 7411;

const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

/**
 * Names that mean this machine.
 *
 * The check is against the literal the client sent, never against what it resolves to.
 * DNS rebinding is exactly the attack where a hostname resolves to 127.0.0.1 -- resolving
 * it would confirm the attacker's own trick.
 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Drop the port from an authority, keeping an IPv6 literal's brackets intact. */
function hostnameOf(authority: string): string {
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  const colon = authority.indexOf(':');
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

function hostIsLoopback(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_NAMES.has(hostnameOf(host));
}

/**
 * An `Origin` a page on this machine could have sent.
 *
 * `Origin: null` -- what a sandboxed iframe or a `file://` page sends -- fails to parse
 * and is refused with everything else.
 */
function originIsLoopback(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_NAMES.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

/**
 * A response body, compressed once rather than per request.
 *
 * The structure payload is 250KB of highly repetitive JSON -- the same scope names and
 * source strings on every one of thousands of cells -- and gzips to about 5KB for ~1ms of
 * CPU, paid once at startup. Below a few KB the framing costs more than it saves, so
 * small bodies stay plain.
 */
interface Payload {
  type: string;
  plain: Buffer;
  gzip: Buffer | null;
  /** Headers this body needs on top of the ones every response carries. */
  extra: Record<string, string>;
}

const GZIP_FLOOR = 4096;

function payload(type: string, text: string, extra: Record<string, string> = {}): Payload {
  const plain = Buffer.from(text, 'utf8');
  return { type, plain, gzip: plain.length > GZIP_FLOOR ? gzipSync(plain) : null, extra };
}

/**
 * Fixed bodies for every failure.
 *
 * An error path is the classic way past a redaction boundary: the happy path is built
 * field by field from an allowlist, and then a 500 hands back a stack trace with the
 * user's home directory in every frame. These carry a machine-readable reason and nothing
 * else -- no message, no path, no identifier that came in with the request.
 */
const ERRORS = {
  badRequest: payload(JSON_TYPE, '{"error":"bad_request"}'),
  forbidden: payload(JSON_TYPE, '{"error":"forbidden"}'),
  notFound: payload(JSON_TYPE, '{"error":"not_found"}'),
  methodNotAllowed: payload(JSON_TYPE, '{"error":"method_not_allowed"}'),
  unsupportedMedia: payload(JSON_TYPE, '{"error":"unsupported_media_type"}'),
  tooLarge: payload(JSON_TYPE, '{"error":"payload_too_large"}'),
  /** The handle names no plan this process is holding. Its own reason, deliberately. */
  stalePlan: payload(JSON_TYPE, '{"error":"stale_plan"}'),
  internal: payload(JSON_TYPE, '{"error":"internal"}'),
} as const;

function send(req: IncomingMessage, res: ServerResponse, status: number, body: Payload): void {
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const compressed = body.gzip !== null && accepts;
  const bytes = compressed ? body.gzip! : body.plain;

  res.writeHead(status, {
    'Content-Type': body.type,
    'Content-Length': bytes.length,
    // Resolved config, read once at startup. A cached copy would outlive its truth.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding',
    ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
    ...body.extra,
  });
  // Node suppresses the body for HEAD on its own, so both methods share this path.
  res.end(bytes);
}

// ---------------------------------------------------------------------------

/**
 * An index that prices nothing.
 *
 * `viewFrom` asks for a price per plugin row, and the structure request must not wait on
 * 42 subprocesses. Answering `undefined` for everything is how the same projection --
 * same fields, same redaction -- is asked the purely structural question. Nothing here
 * reimplements it: a second copy of what a row may publish is a second thing to keep in
 * step, and slice 1 exists to be the only one.
 */
const UNPRICED: PluginCostIndex = {
  get: () => undefined,
  entries: () => [],
  size: 0,
};

function structureOf(ctx: AuditContext, matrixPath: string | undefined): StructureResponse {
  const view = viewFrom({ ...ctx, pluginCosts: UNPRICED });
  const rows = <V>(list: Array<ExtensionRow<V>>): Array<StructureRow<V>> =>
    list.map(({ id, kind, cells }) => ({ id, kind, cells }));

  // Read once, with the workspace. The matrix is a snapshot for the same reason the
  // workspace is: a page that re-read one and not the other would show two moments at
  // once and say it was showing one.
  const matrix = readMatrix(matrixPath);

  return {
    generatedAt: new Date().toISOString(),
    projects: view.projects,
    plugins: rows(view.plugins),
    mcpServers: rows(view.mcpServers),
    skills: rows(view.skills),
    categories: matrix ? categorise(view.plugins.map((p) => p.id), matrix) : null,
  };
}

/**
 * One plugin's price, through the same projection that built the grid.
 *
 * The alternative was to copy `view/model.ts`'s cost projection into this file, which
 * would copy its component allowlist too -- and that allowlist is the point of that
 * module rather than a detail of it. So the price is read back out of a grid built with
 * an index that answers for exactly the id asked about and declines every other. The
 * rebuild costs ~4ms and spawns nothing; the ~0.6s is the single lookup it allows.
 */
function costOf(ctx: AuditContext, id: string): ExtensionCost | null {
  const onlyThisOne: PluginCostIndex = {
    get: (want) => (want === id ? ctx.pluginCosts.get(want) : undefined),
    entries: () => ctx.pluginCosts.entries(),
    get size() {
      return ctx.pluginCosts.size;
    },
  };
  return viewFrom({ ...ctx, pluginCosts: onlyThisOne }).plugins.find((r) => r.id === id)?.cost ?? null;
}

/**
 * The page gets a policy the JSON responses do not need: it is the only response a
 * browser executes. `default-src 'none'` is what keeps a page rendering the user's whole
 * workspace from talking to anything but this server -- the no-egress property, enforced
 * by the browser rather than promised in a comment. Inline script and style are allowed
 * because the grid ships as one file; `img-src data:` is what the provenance icons in
 * `page.ts` are drawn with, rather than a second request for a sprite.
 */
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";

// ---------------------------------------------------------------------------

interface State {
  ctx: AuditContext;
  structure: Payload;
  index: Payload;
  /**
   * The ids `/api/cost` will answer for.
   *
   * A plugin id becomes an argv entry to `claude plugin details`, so an unrecognised one
   * is refused before it can spawn anything. `execFileSync` takes an argument array and
   * no shell, so this is not about injection -- it is that an id off this list would
   * otherwise buy an anonymous caller one process per request.
   *
   * It is the write path's id allowlist too (QM-44): a plan may only name a plugin the
   * grid drew, so an id nothing published cannot be planned against. That is narrower than
   * `qm set`, which deliberately writes an id no build names (QM-47) -- and it is right
   * here, because a control the browser cannot offer is not a write the browser can mean.
   */
  pluginIds: Set<string>;
  /** Column digest -> directory. Held, never sent. See `columnPaths`. */
  columns: Map<string, string>;
  /** The 32 random bytes both `POST` routes require. Minted once, per process. */
  token: string;
  /** Plans this process is holding, by handle. The only plan an apply can name. */
  plans: Map<string, TogglePlan>;
  /** Where backups and the undo record go. Injected so a test never writes the real one. */
  stateDir: string;
  log: (lines: string[]) => void;
  /** The gate every `POST` passes. A parameter so one can be dropped -- see `PostCheck`. */
  postChecks: readonly PostCheck[];
}

/**
 * How many plans are kept, and why there is a number at all.
 *
 * A plan is a handle onto a `TogglePlan` this process is holding, so the store is a place
 * an anonymous caller could grow without bound -- and it is behind the token, so this is
 * housekeeping rather than a defence. Oldest out first: a browser plans one write, reviews
 * it and applies it, and a second tab is the only reason the number is not 1.
 */
const MAX_PLANS = 8;

/**
 * The largest body either route can mean.
 *
 * Both take three short fields. A limit here is what stops a caller that got past the
 * token from streaming into memory, and it is checked as bytes arrive rather than from
 * `Content-Length`, which is the client's claim about itself.
 */
const MAX_BODY = 8 * 1024;

/** The header the token travels in. Custom on purpose -- see the file header. */
const TOKEN_HEADER = 'x-qm-token';

/**
 * The token, compared without leaking how far the comparison got.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are checked first and a
 * wrong length is simply wrong -- there is nothing to learn from that, the token's length
 * is a constant of this program.
 */
function tokenOk(req: IncomingMessage, token: string): boolean {
  const got = req.headers[TOKEN_HEADER];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The type, without its parameters. `application/json; charset=utf-8` is the same type. */
const contentTypeOf = (req: IncomingMessage): string =>
  (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/**
 * One reason a `POST` does not get to the route.
 *
 * A list of named checks and not a chain of `if`s, for `CHECKS`' reason exactly
 * (`toggle.ts`): a gate can drop one and watch the suite go red, and a guard nobody can
 * delete is a guard nobody has tested. `test/serve-write.test.ts` runs the whole write
 * scenario once per check with that check removed, and every removal must cost a refusal.
 *
 * The reason is the name of a fixed body, so a check cannot invent a message -- the error
 * bodies are the same fixed set every other failure here uses.
 */
export interface PostCheck {
  name: string;
  run(req: IncomingMessage, token: string): 'forbidden' | 'unsupportedMedia' | null;
}

/**
 * Four gates, and the first two are one question split deliberately.
 *
 * `origin-present` and `origin-loopback` could be a single predicate, and were, on the
 * read path -- `if (origin !== undefined)`. That shape passes a request with no `Origin`
 * at all, which is the shape a local process sends and the shape a browser never does. Two
 * checks means the two mutations are separable: drop `origin-present` and a header-less
 * `POST` is accepted, drop `origin-loopback` and one from `https://evil.example.com` is.
 * Folded together, one of those two holes would be invisible.
 *
 * `csrf-token` is the one that is worth anything against a program rather than a page, and
 * `json-body` is what stops the one content type a cross-origin form can send without a
 * preflight this server would fail.
 */
export const POST_CHECKS: readonly PostCheck[] = [
  {
    name: 'origin-present',
    run: (req) => (req.headers.origin === undefined ? 'forbidden' : null),
  },
  {
    name: 'origin-loopback',
    run: (req) => {
      const origin = req.headers.origin;
      return origin !== undefined && !originIsLoopback(origin) ? 'forbidden' : null;
    },
  },
  {
    name: 'csrf-token',
    run: (req, token) => (tokenOk(req, token) ? null : 'forbidden'),
  },
  {
    name: 'json-body',
    run: (req) => (contentTypeOf(req) === 'application/json' ? null : 'unsupportedMedia'),
  },
];

const REFUSAL_STATUS = { forbidden: 403, unsupportedMedia: 415 } as const;

/** The body, or `null` where it was too large or the connection failed. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/** A plan, remembered under its handle, oldest evicted. */
function remember(state: State, id: string, plan: TogglePlan): void {
  state.plans.set(id, plan);
  while (state.plans.size > MAX_PLANS) {
    const oldest = state.plans.keys().next();
    if (oldest.done) break;
    state.plans.delete(oldest.value);
  }
}

/**
 * `POST /api/plan`: what a toggle would do.
 *
 * The two ids in the body are looked up rather than trusted -- a column digest becomes a
 * directory only if the grid published that column, and a plugin id is planned against
 * only if the grid drew that row. So a caller names things this server already said, and
 * `planToggles` is never handed a path that came off a socket.
 */
function planRoute(req: IncomingMessage, res: ServerResponse, state: State, body: unknown): void {
  const b = body as { project?: unknown; plugin?: unknown; value?: unknown };
  if (typeof b.project !== 'string' || typeof b.plugin !== 'string' || typeof b.value !== 'boolean') {
    return send(req, res, 400, ERRORS.badRequest);
  }
  const dir = state.columns.get(b.project);
  if (dir === undefined || !state.pluginIds.has(b.plugin)) {
    return send(req, res, 404, ERRORS.notFound);
  }

  const result = planToggles(state.ctx, PLUGIN_AXIS, dir, [{ id: b.plugin, value: b.value }]);
  if (result.outcome === 'refused') {
    state.log([
      `${b.plugin} = ${b.value} in ${dir}: refused, nothing was written`,
      ...result.refusals.flatMap((r) => [
        `  ${r.code}: ${r.message}`,
        ...r.evidence.map((e) => `    · ${e}`),
        ...(r.fix ? [`    fix: ${r.fix}`] : []),
      ]),
    ]);
    const refused: PlanResponse = { outcome: 'refused', refusals: result.refusals.map((r) => r.code) };
    return send(req, res, 200, payload(JSON_TYPE, JSON.stringify(refused)));
  }

  const id = randomBytes(16).toString('hex');
  // `null` means the plan is for a directory that is not a column, which cannot happen --
  // `dir` came out of `state.columns`. Refused rather than asserted: the alternative to a
  // 500 here is publishing a label for a project the grid never drew.
  const view = planView(state.ctx, result.plan, id);
  if (!view) return send(req, res, 404, ERRORS.notFound);

  remember(state, id, result.plan);
  state.log([`plan ${id} — ${b.plugin} = ${b.value}`, ...describePlan(result.plan)]);
  const planned: PlanResponse = { outcome: 'planned', plan: view };
  return send(req, res, 200, payload(JSON_TYPE, JSON.stringify(planned)));
}

/**
 * `POST /api/apply`: the plan this process is holding, and no other.
 *
 * The handle is taken out of the store *before* the write, so a replayed request finds
 * nothing rather than applying twice. Everything a plan can still get wrong between here
 * and disk -- the entry moved, the file moved, the batch no longer lands where the diff
 * said -- is `applyPlan`'s, unchanged, and its refusal codes come back as they are.
 */
function applyRoute(req: IncomingMessage, res: ServerResponse, state: State, body: unknown): void {
  const b = body as { plan?: unknown };
  if (typeof b.plan !== 'string') return send(req, res, 400, ERRORS.badRequest);

  const plan = state.plans.get(b.plan);
  if (!plan) return send(req, res, 409, ERRORS.stalePlan);
  state.plans.delete(b.plan);

  const result = applyPlan(plan, { now: new Date(), state: state.stateDir });
  state.log(
    result.outcome === 'written'
      ? [
          `applied ${b.plan} — wrote ${result.bytes} bytes to ${plan.target}`,
          ...(result.rebased
            ? ['  note: the file moved while the diff was on screen; the change was re-applied to it as it is now']
            : []),
          `  backup ${result.backup}`,
          '  undo with: qm undo',
        ]
      : [
          `apply ${b.plan} refused: ${result.code} — ${result.message}`,
          ...result.evidence.map((e) => `    · ${e}`),
        ],
  );
  return send(req, res, 200, payload(JSON_TYPE, JSON.stringify(applyView(result))));
}

/**
 * Everything a `POST` must satisfy before its body is read.
 *
 * Token first: a caller that cannot prove it read the terminal buys no parsing, no plan
 * and no `git check-ignore`. Then the content type, because a form-encoded or `text/plain`
 * body is what a cross-origin page can send without a preflight -- refusing it means the
 * only shape this accepts is one that had to be preflighted.
 */
function post(req: IncomingMessage, res: ServerResponse, state: State, pathname: string): void {
  // Ahead of the path, so a caller that fails the gate learns nothing about which paths
  // write, and buys no parsing, no plan and no `git check-ignore`.
  for (const check of state.postChecks) {
    const refusal = check.run(req, state.token);
    if (refusal) return send(req, res, REFUSAL_STATUS[refusal], ERRORS[refusal]);
  }
  if (pathname !== '/api/plan' && pathname !== '/api/apply') {
    return send(req, res, 404, ERRORS.notFound);
  }

  void readBody(req).then((text) => {
    try {
      if (text === null) return send(req, res, 413, ERRORS.tooLarge);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return send(req, res, 400, ERRORS.badRequest);
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return send(req, res, 400, ERRORS.badRequest);
      }
      return pathname === '/api/plan'
        ? planRoute(req, res, state, body)
        : applyRoute(req, res, state, body);
    } catch {
      // The body arrives after `route` returned, so this path has no outer catch to fall
      // into. Same answer as that one: whatever went wrong is this process's business.
      if (res.headersSent) res.destroy();
      else send(req, res, 500, ERRORS.internal);
    }
  });
}

function route(req: IncomingMessage, res: ServerResponse, state: State): void {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
    return send(req, res, 405, ERRORS.methodNotAllowed);
  }
  if (!hostIsLoopback(req.headers.host)) return send(req, res, 403, ERRORS.forbidden);

  // On a read, an `Origin` is checked when the client sent one; on a write it is one of
  // `POST_CHECKS`, where its absence is itself a refusal (QM-44).
  const origin = req.headers.origin;
  if (method !== 'POST' && origin !== undefined && !originIsLoopback(origin)) {
    return send(req, res, 403, ERRORS.forbidden);
  }

  // Absolute-form request lines (`GET http://elsewhere/api/view`) carry their own
  // authority, which is not the one just checked. Only origin-form is served.
  const target = req.url ?? '';
  if (!target.startsWith('/')) return send(req, res, 400, ERRORS.badRequest);
  const url = new URL(target, `http://${HOST}`);

  if (method === 'POST') return post(req, res, state, url.pathname);

  switch (url.pathname) {
    case '/':
      return send(req, res, 200, state.index);

    // The other half of the control plane (QM-55). A GET behind the same loopback and
    // origin checks as the grid -- and no weaker than Fleet standalone, whose own server
    // binds loopback with no token at all. The write routes are what the token guards, and
    // this route writes nothing.
    //
    // Rendered per request rather than cached, because that is what makes the board worth
    // opening: the scan is Python plus `git`, costs no tokens, and a stale board is the one
    // failure a session dashboard cannot afford.
    case '/sessions': {
      const board = renderSessions();
      return send(req, res, board.ok ? 200 : 503, payload(HTML_TYPE, board.html));
    }

    case '/api/view':
      return send(req, res, 200, state.structure);

    case '/api/cost': {
      const id = url.searchParams.get('plugin');
      if (id === null) return send(req, res, 400, ERRORS.badRequest);
      if (!state.pluginIds.has(id)) return send(req, res, 404, ERRORS.notFound);
      const body: CostResponse = { plugin: id, cost: costOf(state.ctx, id) };
      return send(req, res, 200, payload(JSON_TYPE, JSON.stringify(body)));
    }

    default:
      return send(req, res, 404, ERRORS.notFound);
  }
}

/** What the category filter had to work with. Reported, never inferred from an empty UI. */
export interface CategoryCoverage {
  /** False when no matrix could be read at all -- the filter is then absent, not empty. */
  found: boolean;
  matched: number;
  total: number;
}

export interface RunningServer {
  /**
   * The URL to open. Always loopback, always with the port that was actually bound.
   *
   * It carries the token in the **fragment** (QM-44). A fragment is never put on the wire
   * by any client, so this is the one delivery that reaches the browser the operator opened
   * and does not reach a process that merely knows the port -- and a token served over an
   * endpoint would be a token anything local could fetch, which is no token at all.
   */
  url: string;
  port: number;
  /** The same token, for a caller that has to send it rather than open a page. */
  token: string;
  categories: CategoryCoverage;
  close(): Promise<void>;
}

export interface ServeOptions {
  /** Pass 0 for an ephemeral port -- what the tests use. */
  port?: number;
  /** Overrides `category.ts`'s default location for `plugin-matrix.md`. */
  categoryMatrixPath?: string;
  /** Where backups and the undo record go. Defaults to `apply.ts`'s state directory. */
  stateDir?: string;
  /**
   * Where the full text of every plan and every apply goes.
   *
   * The browser payload carries codes and closed value domains and no prose, so this is
   * where a reader gets `describePlan` entire -- the diff, the effect, the notes and the
   * paths. `qm serve` points it at the terminal. Defaulting to a sink rather than to
   * `console.log` keeps a library out of the caller's stdout, and `qm serve` is the caller
   * that opts in.
   */
  log?: (lines: string[]) => void;
  /**
   * The gate every `POST` passes, with `POST_CHECKS` as its default.
   *
   * A parameter for the reason `planToggles` takes its `checks` and `applyPlan` takes
   * `onStaged`: a gate has to be able to run the whole scenario with one guard missing.
   * Nothing in `src/` passes it.
   */
  postChecks?: readonly PostCheck[];
}

/**
 * Read the workspace once, then listen.
 *
 * The snapshot is built before the socket opens so the first request never waits on it,
 * and so a failure to read the workspace is a startup error rather than a hung browser
 * tab. Rejects with the `listen` error -- `EADDRINUSE` above all -- for the caller to
 * report; a server that silently moved to another port would print a URL the user did
 * not ask for and leave the old one to whatever is holding it.
 */
export function startServer(ctx: AuditContext, opts: ServeOptions = {}): Promise<RunningServer> {
  const structure = structureOf(ctx, opts.categoryMatrixPath);
  const state: State = {
    ctx,
    structure: payload(JSON_TYPE, JSON.stringify(structure)),
    index: payload(HTML_TYPE, PAGE, { 'Content-Security-Policy': CSP }),
    pluginIds: new Set(structure.plugins.map((p) => p.id)),
    columns: columnPaths(ctx),
    token: randomBytes(32).toString('hex'),
    plans: new Map(),
    stateDir: opts.stateDir ?? stateDir(),
    log: opts.log ?? (() => {}),
    postChecks: opts.postChecks ?? POST_CHECKS,
  };
  const categories: CategoryCoverage = {
    found: structure.categories !== null,
    matched: Object.keys(structure.categories ?? {}).length,
    total: structure.plugins.length,
  };

  const server = createServer((req, res) => {
    try {
      route(req, res, state);
    } catch {
      // Whatever went wrong is this process's business. The client gets a status.
      if (res.headersSent) res.destroy();
      else send(req, res, 500, ERRORS.internal);
    }
  });

  // Node's own handler for a malformed request line or header block already answers with
  // a bare 400, but that is the runtime's promise rather than this file's. Made explicit
  // so a body can never appear here.
  server.on('clientError', (_err, socket) => {
    // `end` rather than `destroy`: it flushes the status line before closing, where an
    // immediate destroy can truncate it into no response at all.
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    server.once('error', onListenError);

    server.listen({ host: HOST, port: opts.port ?? DEFAULT_PORT }, () => {
      server.removeListener('error', onListenError);
      // Past this point an error is one connection's problem; an unhandled 'error' event
      // would take the whole server down with it.
      server.on('error', () => {});

      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? DEFAULT_PORT);
      resolve({
        url: `http://${HOST}:${port}/#t=${state.token}`,
        port,
        token: state.token,
        categories,
        close: () =>
          new Promise<void>((done) => {
            // Keep-alive connections would otherwise hold the process open past Ctrl-C.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
