/**
 * What the server promises on top of what the projection already proves.
 *
 * `view.test.ts` shows `viewFrom` publishes nothing sensitive. That says nothing about
 * this file: a server can bind the wrong interface, answer a request from a page it
 * should not, or hand back a stack trace on the one path nobody exercised. Each of those
 * bypasses a clean projection entirely, so they are tested here on the bytes off the
 * socket rather than on the object that produced them.
 *
 * Three properties are load-bearing, in descending order of what a mistake costs:
 *
 *  1. The socket is loopback and the caller is loopback. Wrong, this publishes every
 *     project on the machine to the LAN.
 *  2. Error paths carry no filesystem path and no stack. Wrong, the boundary the whole
 *     of `view/model.ts` exists to hold is bypassed by a 404.
 *  3. Structure costs no subprocess. Wrong, the grid takes ~25s to appear rather than
 *     ~1s, which is the reason the endpoints split where they do.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { gunzipSync } from 'node:zlib';

import type { PluginCost, PluginCostIndex } from '../src/cost/plugins.ts';
import type { AuditContext } from '../src/detect.ts';
import { startServer, type RunningServer } from '../src/view/server.ts';
import { loadFixtureWorkspace } from './fixtures/differential/load.ts';

/**
 * A price index that records what it was asked for.
 *
 * The point of the split is that structure costs nothing, and "costs nothing" is only
 * checkable by watching the thing that would have cost something. A stub returning
 * `undefined` would pass whether or not the request priced all 42 rows.
 */
class RecordingCosts implements PluginCostIndex {
  readonly asked: string[] = [];
  private readonly answers: Map<string, PluginCost | null>;

  constructor(answers: Map<string, PluginCost | null> = new Map()) {
    this.answers = answers;
  }

  get(id: string): PluginCost | null | undefined {
    this.asked.push(id);
    return this.answers.get(id);
  }

  entries(): Iterable<[string, PluginCost | null]> {
    return this.answers.entries();
  }

  get size(): number {
    return this.answers.size;
  }
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Bytes actually on the wire, before any decompression. */
  wire: number;
}

interface RequestOptions {
  host?: string;
  headers?: Record<string, string>;
  method?: string;
}

function request(port: number, path: string, opts: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        timeout: 5_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body:
              res.headers['content-encoding'] === 'gzip'
                ? gunzipSync(raw).toString('utf8')
                : raw.toString('utf8'),
            wire: raw.length,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', reject);
    req.end();
  });
}

/** Bytes in, bytes out. For request lines Node's client will not send. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 5_000 }, () => socket.write(text));
    let out = '';
    socket.on('data', (c: Buffer) => (out += c.toString('utf8')));
    socket.on('close', () => resolve(out));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(out);
    });
    socket.on('error', () => resolve(out));
  });
}

/** Anything absolute-looking, on either spelling. Same rule `view.test.ts` applies. */
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

// ---------------------------------------------------------------------------

const ws = loadFixtureWorkspace();
const costs = new RecordingCosts();
const ctx: AuditContext = {
  ws,
  measurements: [],
  pluginCosts: costs,
  scope: null,
  inventories: new Map(),
};

let server: RunningServer;

before(async () => {
  // Port 0: the OS picks a free one, so the suite never fights a running `qm serve`.
  server = await startServer(ctx, { port: 0 });
});

after(async () => {
  await server.close();
});

describe('the socket', () => {
  test('binds loopback, and says so', async () => {
    const res = await request(server.port, '/api/view');
    assert.equal(res.status, 200);
    assert.ok(server.url.startsWith('http://127.0.0.1:'), server.url);
  });

  /**
   * The criterion that matters most. `listen(port)` without a host binds every
   * interface, and the failure is silent: everything still works from the browser.
   *
   * Reported as skipped rather than passing where there is no routable interface --
   * a check with nothing to connect to proves nothing, and should not read as if it did.
   */
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NetworkInterfaceInfo => i !== undefined && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  test('and refuses the connection on this machine\'s LAN address', {
    skip: !lan.length && 'no non-loopback IPv4 on this machine',
  }, async () => {
    for (const address of lan) {
      const outcome = await request(server.port, '/api/view', { host: address }).then(
        (r) => `reachable: HTTP ${r.status}`,
        (e: NodeJS.ErrnoException) => `unreachable: ${e.code ?? e.message}`,
      );
      assert.ok(outcome.startsWith('unreachable'), `${address} -> ${outcome}`);
    }
  });

  test('a port already taken is an error, not a quiet move to another one', async () => {
    await assert.rejects(
      startServer(ctx, { port: server.port }),
      (err: NodeJS.ErrnoException) => err.code === 'EADDRINUSE',
    );
  });
});

describe('who may ask', () => {
  /** A name in someone else's DNS zone can point at 127.0.0.1. The Host header cannot. */
  test('a Host that is not loopback is refused', async () => {
    for (const host of ['evil.example.com', 'evil.example.com:80', 'localhost.evil.com', '127.0.0.1.evil.com']) {
      const res = await request(server.port, '/api/view', { headers: { host } });
      assert.equal(res.status, 403, host);
      assert.equal(res.body, '{"error":"forbidden"}');
    }
  });

  test('the loopback spellings are accepted', async () => {
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, '[::1]', 'LOCALHOST']) {
      assert.equal((await request(server.port, '/api/view', { headers: { host } })).status, 200, host);
    }
  });

  test('a cross-origin page is refused, including an opaque origin', async () => {
    for (const origin of ['https://evil.example.com', 'http://evil.example.com', 'null', 'file://']) {
      const res = await request(server.port, '/api/view', { headers: { origin } });
      assert.equal(res.status, 403, origin);
    }
  });

  test('and no CORS header is ever emitted, so a browser blocks what slips past', async () => {
    for (const path of ['/', '/api/view', '/nope']) {
      const res = await request(server.port, path, { headers: { origin: `http://127.0.0.1:${server.port}` } });
      assert.equal(res.headers['access-control-allow-origin'], undefined, path);
      assert.equal(res.headers['access-control-allow-credentials'], undefined, path);
    }
  });

  test('read-only: anything but GET or HEAD is refused', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await request(server.port, '/api/view', { method });
      assert.equal(res.status, 405, method);
    }
  });

  /** Absolute-form carries its own authority, which is not the one just checked. */
  test('an absolute-form request line is refused', async () => {
    const res = await request(server.port, 'http://evil.example.com/api/view');
    assert.equal(res.status, 400);
  });
});

describe('structure arrives without paying for a price', () => {
  test('building the snapshot asked for no price at all', () => {
    // `startServer` builds it before it listens. 42 spawns here is ~25s of blank screen.
    assert.deepEqual(costs.asked, []);
  });

  test('nor does serving it', async () => {
    costs.asked.length = 0;
    await request(server.port, '/api/view');
    await request(server.port, '/api/view');
    assert.deepEqual(costs.asked, []);
  });

  test('and a row carries no cost key, rather than a null one', async () => {
    const view = JSON.parse((await request(server.port, '/api/view')).body);
    const rows = [...view.plugins, ...view.mcpServers, ...view.skills];
    assert.ok(rows.length > 0, 'the fixture produced no rows');
    for (const row of rows) {
      assert.ok(!('cost' in row), `${row.id} published a cost it was never asked for`);
      assert.deepEqual(Object.keys(row).sort(), ['cells', 'id', 'kind']);
    }
  });

  test('the payload carries what the grid needs to draw itself', async () => {
    const view = JSON.parse((await request(server.port, '/api/view')).body);
    assert.ok(Date.parse(view.generatedAt) > 0, view.generatedAt);
    assert.ok(view.projects.length > 0, 'no projects');
    assert.ok(view.plugins.length > 0, 'no plugin rows');
    // Every cell names a column that exists, or the grid cannot place it.
    const columns = new Set(view.projects.map((p: { id: string }) => p.id));
    for (const row of view.plugins) {
      assert.equal(row.cells.length, view.projects.length, row.id);
      for (const cell of row.cells) assert.ok(columns.has(cell.project), `${row.id} -> ${cell.project}`);
    }
  });
});

describe('a price is asked for one row at a time', () => {
  const id = 'feature-dev@claude-plugins-official';

  test('the fixture has the row this section prices', async () => {
    const view = JSON.parse((await request(server.port, '/api/view')).body);
    assert.ok(
      view.plugins.some((r: { id: string }) => r.id === id),
      `pick another id; the fixture has ${view.plugins.length} rows`,
    );
  });

  test('asking for one prices exactly one', async () => {
    costs.asked.length = 0;
    const res = await request(server.port, '/api/cost?plugin=' + encodeURIComponent(id));
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { plugin: id, cost: null });
    assert.deepEqual(costs.asked, [id]);
  });

  /**
   * An id becomes an argv entry to `claude plugin details`. `execFileSync` runs no shell,
   * so this is not injection -- it is that an unrecognised id would otherwise buy the
   * caller one process spawn per request.
   */
  test('an id the workspace does not have never reaches a subprocess', async () => {
    costs.asked.length = 0;
    // `feature-dev` is the marketplace-less half of a real id: close is not a match.
    for (const bogus of ['nope@nowhere', '../../etc/passwd', '', 'feature-dev']) {
      const res = await request(server.port, '/api/cost?plugin=' + encodeURIComponent(bogus));
      assert.equal(res.status, 404, bogus);
    }
    assert.deepEqual(costs.asked, []);
  });

  test('and asking for nothing is a bad request', async () => {
    const res = await request(server.port, '/api/cost');
    assert.equal(res.status, 400);
  });
});

describe('the wire', () => {
  test('the structure payload is compressed when the client accepts it', async () => {
    const plain = await request(server.port, '/api/view');
    const zipped = await request(server.port, '/api/view', { headers: { 'accept-encoding': 'gzip' } });

    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.body, plain.body, 'compression changed the payload');
    assert.ok(zipped.wire < plain.wire, `${zipped.wire} !< ${plain.wire}`);
    // Same bytes, differently framed: a wrong Content-Length truncates in the browser.
    assert.equal(Number(zipped.headers['content-length']), zipped.wire);
    assert.equal(zipped.headers['vary'], 'Accept-Encoding');
  });

  test('a small body is not compressed, and says so consistently', async () => {
    const res = await request(server.port, '/nope', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(Number(res.headers['content-length']), res.wire);
  });

  /**
   * The page is the only response a browser executes, and it renders the whole
   * workspace. The policy is what stops it sending any of that anywhere.
   */
  test('the page may not talk to anything but this server', async () => {
    const csp = (await request(server.port, '/')).headers['content-security-policy'];
    assert.ok(typeof csp === 'string' && csp.length > 0, 'no policy on the page');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    // No scheme and no host anywhere in it: every source is this origin or nothing.
    assert.ok(!/https?:\/\//.test(csp), csp);
  });

  test('nothing is cached, and nothing is sniffed', async () => {
    for (const path of ['/', '/api/view', '/nope']) {
      const res = await request(server.port, path);
      assert.equal(res.headers['cache-control'], 'no-store', path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    }
  });
});

describe('error paths leak nothing', () => {
  test('every failure answers with a fixed body', async () => {
    const replies = [
      await request(server.port, '/nope'),
      await request(server.port, '/api/cost'),
      await request(server.port, '/api/cost?plugin=nope@nowhere'),
      await request(server.port, '/api/view', { method: 'POST' }),
      await request(server.port, '/api/view', { headers: { host: 'evil.example.com' } }),
      await request(server.port, 'http://evil.example.com/api/view'),
      await request(server.port, '/api/view/../../../../etc/passwd'),
    ];

    for (const res of replies) {
      const whole = res.body + JSON.stringify(res.headers);
      assert.ok(!/\bat .+:\d+:\d+/.test(whole), `stack frame: ${whole}`);
      assert.ok(!whole.includes('node:internal'), whole);
      for (const s of stringsIn(res.body)) assert.ok(!looksAbsolute(s), s);
      // One of five reasons, and nothing that came in with the request.
      assert.match(res.body, /^\{"error":"(bad_request|forbidden|not_found|method_not_allowed|internal)"\}$/);
    }
  });

  test('a malformed request line gets a bare status line', async () => {
    const reply = await raw(server.port, 'GARBAGE ///\x01\x02 NOT-HTTP\r\n\r\n');
    assert.match(reply, /^HTTP\/1\.1 400 Bad Request\r\n/);
    const [, body = ''] = reply.split('\r\n\r\n');
    assert.equal(body, '', `a body appeared on the clientError path: ${body}`);
  });
});

/**
 * The redaction check, redone on the socket.
 *
 * The fixture is a real workspace with its names swapped onto `/Users/testuser`, read
 * from paths under this repo -- so both the recorded home and the reading path are
 * absolute strings that must not survive the trip.
 */
describe('nothing sensitive survives the trip', () => {
  test('no string in any response body is an absolute path', async () => {
    const bodies = [
      (await request(server.port, '/api/view')).body,
      (await request(server.port, '/api/cost?plugin=feature-dev@claude-plugins-official')).body,
    ];
    let scanned = 0;
    for (const body of bodies) {
      const strings = stringsIn(body);
      scanned += strings.length;
      assert.deepEqual(strings.filter(looksAbsolute), []);
      assert.deepEqual(strings.filter((s) => s.includes('testuser')), []);
    }
    assert.ok(scanned > 100, `only ${scanned} strings scanned`);
  });

  test('the fixture home appears nowhere in the raw bytes either', async () => {
    const body = (await request(server.port, '/api/view')).body;
    // Substring over the whole payload, not per string: a path can be embedded.
    assert.ok(!body.includes('/Users/testuser'), 'recorded home reached the wire');
    assert.ok(!body.includes(ws.home), 'the directory the fixture was read from reached the wire');
  });
});
