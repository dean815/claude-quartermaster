/**
 * The sessions view: Session Fleet's board, served by `qm serve` (QM-55).
 *
 * The suite has two local UIs and, before this, two ports and two processes to start. This
 * makes `qm serve` the single port, which is the whole of what a "control plane" means to
 * someone who has to open it.
 *
 * **A subprocess boundary and not a rewrite, because Fleet is already a pipeline.**
 * `collect.py --days N` writes `data.json`; `render.py --local --out F` turns that into one
 * self-contained HTML file; `serve.py` is a ~130-line wrapper over exactly those two calls.
 * So this does what `serve.py` does. `render.py`'s 1,072 lines are untouched, and the
 * property that matters most survives with them: the scan is Python plus `git` with no model
 * in the loop, so re-rendering this view costs **zero tokens**, however often it is loaded.
 *
 * **All six of Fleet's modules import stdlib only**, checked rather than assumed --
 * `requirements.txt` (`rumps`, `pyobjc`, `fonttools`, `brotli`) serves the menu-bar app and
 * the icon generator, neither of which is on this path. So the view needs a `python3` and
 * nothing else, and there is no virtualenv to find or build.
 *
 * **It does not inherit the grid's redaction, and that is a boundary worth naming.**
 * `view/model.ts` projects an allowlist so no absolute path crosses the wire, and
 * `view.test.ts`'s sweep pins it. That sweep covers the **model projection** and not this
 * route, correctly -- these are different mechanisms. This serves a subprocess's HTML, and
 * Fleet's board exists precisely to show which directory each session is in, so it is full
 * of absolute paths by design. The protection here is the same one Fleet has standalone and
 * the same one the grid's own GET routes have: loopback, an origin check, and a page that
 * only ever leaves this machine if someone forwards the port. Do not read the redaction
 * sweep as covering `/sessions`; it does not, and it should not be made to, because
 * redacting the board would delete the board's content.
 *
 * **It degrades to a page rather than to a 500.** No `python3`, no Fleet directory, a script
 * that fails or one that hangs each produce a diagnostic naming the cause. A control plane
 * whose config half dies because its sessions half cannot start is worse than one that says
 * which half is missing -- and the grid is the half people came for.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where Fleet's scripts are, relative to this file.
 *
 * `src/view/` -> repo root -> `plugins/session-fleet`. This resolves inside an installed
 * plugin as well as a checkout, because the marketplace gives quartermaster `"source": "./"`
 * -- its plugin root is the whole repo, so the sibling plugins' files come with it. That
 * copy was noted in QM-55 as inert (`claude plugin details` reports `Skills (2)`, so their
 * skills are never loaded); this is the one thing that reads it, and it is why the layout
 * is not merely harmless but load-bearing.
 */
export const fleetDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'session-fleet');

/** How long either script may run before the view reports a hang instead of waiting. */
const SCRIPT_TIMEOUT_MS = 120_000;

export interface SessionsResult {
  html: string;
  /** False when the page explains a failure rather than showing the board. */
  ok: boolean;
}

const escape = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/**
 * The diagnostic page.
 *
 * Deliberately plain, and deliberately not the grid's stylesheet: this renders when
 * something is wrong with a *subprocess*, and borrowing the working half's chrome to say so
 * reads like the board rendered empty.
 */
function problem(title: string, detail: string, fix: string): SessionsResult {
  return {
    ok: false,
    html: `<!doctype html><meta charset="utf-8"><title>Sessions — unavailable</title>
<style>body{font:14px/1.6 ui-monospace,Menlo,monospace;background:#0f1115;color:#e7e9ef;padding:40px;max-width:70ch}
h1{font:600 20px/1.3 ui-sans-serif,-apple-system,sans-serif;margin:0 0 12px}
code{background:#171a20;padding:2px 6px;border-radius:4px}
pre{background:#171a20;padding:16px;border-radius:8px;border:1px solid #262a33;white-space:pre-wrap;overflow-x:auto}
a{color:#7aa2f7}</style>
<h1>${escape(title)}</h1><p>${escape(detail)}</p><pre>${escape(fix)}</pre>
<p><a href="/">← back to the extensions grid</a></p>`,
  };
}

/**
 * Render the board, or a page saying why not.
 *
 * `days` is Fleet's own window argument and is passed straight through. Nothing here parses
 * Fleet's output: it is served as the bytes `render.py` produced, which is what keeps this a
 * boundary rather than a second renderer that can disagree with the first.
 */
export function renderSessions(days = 7): SessionsResult {
  const dir = fleetDir();
  const collect = join(dir, 'collect.py');
  const render = join(dir, 'render.py');

  if (!existsSync(collect) || !existsSync(render)) {
    return problem(
      'Session Fleet is not installed here',
      `The sessions view runs Fleet's own scripts, and this build has no ${escape(dir)}.`,
      'Install it:  /plugin install session-fleet@claude-quartermaster',
    );
  }

  // A temp file, not Fleet's own `local.html`: two `qm serve` processes rendering at once
  // would otherwise interleave writes into one path, and the plugin directory may be
  // read-only when installed from a marketplace.
  const out = mkdtempSync(join(tmpdir(), 'qm-sessions-'));
  const page = join(out, 'board.html');
  try {
    for (const args of [
      [collect, '--days', String(days)],
      [render, '--local', '--auto-seconds', '0', '--out', page],
    ]) {
      execFileSync('python3', args, {
        cwd: dir,
        timeout: SCRIPT_TIMEOUT_MS,
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
    }
    return { ok: true, html: readFileSync(page, 'utf8') };
  } catch (err) {
    const e = err as { code?: string; stderr?: string; signal?: string };
    if (e.code === 'ENOENT') {
      return problem(
        'No python3 on PATH',
        'The sessions view runs Fleet in Python. Every module it needs is stdlib, so a ' +
          'system python3 is enough — there is no virtualenv to create.',
        'macOS:  xcode-select --install\nor install Python 3 from python.org',
      );
    }
    if (e.signal === 'SIGTERM') {
      return problem(
        'The scan did not finish',
        `Fleet's scan ran past ${SCRIPT_TIMEOUT_MS / 1000}s and was stopped. That usually means a ` +
          'git command is blocked on credentials in one of the scanned repositories.',
        'Run it directly to see where it stops:\n  python3 collect.py --days 7',
      );
    }
    // stderr verbatim: this is a subprocess this repo does not own, and paraphrasing its
    // failure is how a diagnostic starts being wrong about a tool it cannot see.
    return problem(
      'Fleet could not build the board',
      'Its scan or render step exited non-zero. Its own error follows.',
      (e.stderr ?? '(no stderr)').trim().slice(0, 4000),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
