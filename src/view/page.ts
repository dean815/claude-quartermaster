/**
 * The grid, as one self-contained page.
 *
 * No dependency reaches this file and none ever will: the policy the server sets is
 * `default-src 'none'` with `connect-src 'self'`, so a framework would have to arrive
 * inlined anyway -- and the moment it does, the no-egress property stops being something
 * a reviewer can establish by reading one file. Plain HTML, one stylesheet, one script.
 *
 * Four decisions shape everything below.
 *
 * **`value` and `origin` are never folded together.** The value picks the glyph; the
 * origin picks the styling. That separation is why `model.ts` exists at all -- the A-F
 * enum it replaced could not express a four-valued skill -- so plugins, MCP servers and
 * skills go through one `rowHtml`, and a skill is four glyphs in the same table rather
 * than a second renderer that would drift from the first the week either is touched.
 *
 * **`origin` and `scope` are different facts.** `origin` is the relationship between
 * scopes: did this project decide, agree, or say nothing. `scope` is which file won, and
 * takes the provenance icon. Both appear on every cell, because "overridden" without "by
 * the local file" does not tell anyone where to go and edit.
 *
 * **The DOM is built as strings and listened to once.** The live workspace is 42 plugin,
 * 39 MCP and 430 skill rows over 24 projects -- about 12,000 cells. A listener per cell is
 * 12,000 closures for an interaction that happens a few times a minute, so one delegated
 * handler on `main` covers every cell, header and row. Highlighting a project rewrites one
 * CSS rule rather than touching 500 nodes: the selector engine is already optimised for
 * exactly that, and a loop is not.
 *
 * **First paint does not wait on a price.** `/api/cost` spawns `claude plugin details`,
 * ~0.6s each; 42 of them serially is ~25s of blank grid. Slice 2 split the endpoints for
 * this, so the page draws from `/api/view` alone and prices land afterwards, a few in
 * flight at a time.
 *
 * Read-only. There is no write route to call, and the add/remove control is rendered inert
 * on purpose -- see `phase2`.
 */

/**
 * The page.
 *
 * A constant rather than a function: nothing from the server is interpolated into it,
 * which is what lets `page.test.ts` establish that no absolute path can reach a browser
 * from here by reading the string itself. Everything the page shows arrives over
 * `/api/view`, through the allowlist in `view/model.ts`.
 */
export const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>quartermaster</title>
<style>
:root{
  --bg:#0e1013;--bg2:#15181c;--panel:#191d22;--fg:#d8dce3;--dim:#767f8b;--line:#252a30;
  --on:#5ec27a;--off:#4d545d;--part:#6ea8fe;--warn:#e8b339;--hl:rgba(110,168,254,.15);
  /* Provenance marks. Declared once so the grid and the legend cannot disagree, and
     drawn rather than lettered so a cell needs no extra element to carry them. Data URIs
     are what \`img-src 'self' data:\` leaves available; a sprite file would be a request. */
  --i-user:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cg fill='none' stroke='%238b93a1' stroke-width='1.1'%3E%3Ccircle cx='5' cy='5' r='3.7'/%3E%3Cellipse cx='5' cy='5' rx='1.7' ry='3.7'/%3E%3Cpath d='M1.3 5h7.4'/%3E%3C/g%3E%3C/svg%3E");
  --i-project:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cg fill='none' stroke='%238b93a1' stroke-width='1.1'%3E%3Cpath d='M2.2 1.7h4.5a1.3 1.3 0 011.3 1.3v5.3H3.5a1.3 1.3 0 01-1.3-1.3z'/%3E%3Cpath d='M2.2 6.9h5.6'/%3E%3C/g%3E%3C/svg%3E");
  --i-local:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cg fill='none' stroke='%238b93a1' stroke-width='1.1'%3E%3Crect x='1.2' y='1.9' width='7.6' height='5.3' rx='.9'/%3E%3Cpath d='M3.7 8.6h2.6'/%3E%3C/g%3E%3C/svg%3E");
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
h1{font-size:13px;font-weight:600;margin:0;letter-spacing:.04em}
button,select,input{font:inherit;color:inherit}
header{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;
  padding:10px 14px;border-bottom:1px solid var(--line);background:var(--bg2)}
.snap{color:var(--dim);font-size:11px;max-width:900px}
.snap b{color:var(--fg);font-weight:500}
code{background:#000;padding:0 4px;border-radius:3px;color:var(--fg)}

nav{display:flex;gap:18px;align-items:center;flex-wrap:wrap;
  padding:8px 14px;border-bottom:1px solid var(--line)}
.g2{display:flex;gap:6px;align-items:center}
.g2>.lbl{color:var(--dim);font-size:11px}
button.tab,select{background:var(--panel);border:1px solid var(--line);border-radius:4px;
  padding:3px 9px;cursor:pointer}
button.tab[aria-selected=true]{background:#233043;border-color:#35496a;color:#cfe0ff}
select:disabled{opacity:.4;cursor:not-allowed}
label.ck{display:flex;gap:5px;align-items:center;cursor:pointer;
  padding:2px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel)}
label.ck input{margin:0}
.badge{font-size:10px;color:var(--warn);border:1px solid rgba(232,179,57,.4);
  border-radius:3px;padding:0 4px}

.legend{display:flex;gap:14px;flex-wrap:wrap;padding:6px 14px;
  border-bottom:1px solid var(--line);color:var(--dim);font-size:11px;align-items:center}
.legend .sw{display:inline-block;width:13px;text-align:center;font-style:normal}
.legend .bar{color:var(--line)}
.lgi{display:inline-block;width:10px;height:10px;vertical-align:-1px;
  background-repeat:no-repeat;background-size:10px 10px}
.lgi[data-s=user]{background-image:var(--i-user)}
.lgi[data-s=project]{background-image:var(--i-project)}
.lgi[data-s=local]{background-image:var(--i-local)}

main{padding:0 0 200px}
section.kind{border-bottom:1px solid var(--line)}
.head{display:flex;gap:10px;align-items:center;padding:8px 14px;cursor:pointer;
  user-select:none;background:var(--bg2)}
.head .n{color:var(--dim);font-size:11px}
.head .caret{color:var(--dim);width:10px}
.head .sp{flex:1}
.scroll{overflow:auto;max-height:74vh}

table.g{border-collapse:separate;border-spacing:0;font-size:12px}
.g th{font-weight:400}
.g th.rh{position:sticky;left:0;z-index:2;background:var(--bg);text-align:left;
  width:250px;min-width:250px;max-width:250px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;padding:0 8px;border-right:1px solid var(--line);color:var(--fg);
  cursor:pointer}
.g thead th{position:sticky;top:0;z-index:3;background:var(--bg2);
  border-bottom:1px solid var(--line)}
.g thead th.rh{z-index:4;background:var(--bg2);color:var(--dim);font-size:11px;
  vertical-align:bottom;padding-bottom:6px;cursor:default}
.g th.ch{width:24px;min-width:24px;height:158px;vertical-align:bottom;padding:0 0 6px;
  cursor:pointer}
.g th.ch span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;
  color:var(--dim);font-size:11px;max-height:148px;overflow:hidden;display:block}
.g th.ch:hover span{color:var(--fg)}
.g th.hc{padding:0 8px 6px;text-align:right;color:var(--dim);font-size:11px;
  vertical-align:bottom;min-width:112px}
tr.grp td{padding:5px 8px;color:var(--dim);font-size:11px;background:#12151a;
  border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
tr.grp b{color:var(--fg);font-weight:500}

td.c{position:relative;width:24px;min-width:24px;height:20px;line-height:20px;
  text-align:center;font-size:11px;cursor:pointer}
td.c[data-v=true],td.c[data-v=on]{color:var(--on)}
td.c[data-v=false],td.c[data-v=off]{color:var(--off)}
td.c[data-v=name-only],td.c[data-v=user-invocable-only]{color:var(--part)}
td.c[data-o=inherited]{opacity:.45;font-style:italic}
td.c[data-o=overridden]{font-weight:700}
td.c[data-o=restated]{font-weight:700;background:rgba(232,179,57,.13);
  box-shadow:inset 0 0 0 1px rgba(232,179,57,.35)}
td.c[data-o=restated]::before{content:"\\25B3";position:absolute;left:1px;top:-2px;
  font-size:8px;line-height:1;color:var(--warn)}
/* round-trip is bold like overridden and carries no warning tint, because the entry is in
   force -- it must not read as the redundant state it resolves alongside (QM-43). Its own
   glyph, a filled triangle against restated's hollow one, so the two are distinguishable
   in one glance without reading the tooltip. (No backticks in here: this whole page is a
   template literal, and one closes it.) */
td.c[data-o=round-trip]{font-weight:700}
td.c[data-o=round-trip]::before{content:"\\25B2";position:absolute;left:1px;top:-2px;
  font-size:8px;line-height:1;color:var(--part)}
td.c[data-s]::after{content:"";position:absolute;right:1px;top:1px;width:8px;height:8px;
  opacity:.85;background-repeat:no-repeat;background-size:8px 8px}
td.c[data-s=user]::after{background-image:var(--i-user)}
td.c[data-s=project]::after{background-image:var(--i-project)}
td.c[data-s=local]::after{background-image:var(--i-local)}

td.cost{padding:0 8px;text-align:right;white-space:nowrap;font-size:11px;min-width:112px}
.q{color:var(--dim)}
.np{color:var(--warn)}
.tok{color:var(--fg)}
.na{color:#3d434b}

table.p{border-collapse:collapse;font-size:12px;margin:12px 14px 8px}
.p th,.p td{padding:4px 14px;text-align:right;border-bottom:1px solid var(--line);
  white-space:nowrap}
.p th{color:var(--dim);font-weight:400;font-size:11px;position:sticky;top:0;
  background:var(--bg2)}
.p th:first-child,.p td:first-child{text-align:left}
.p tbody tr{cursor:pointer}
.p tbody tr:hover>td{background:#161a1f}
.p tr.global>td{background:#151b16;border-bottom:1px solid #2a3a2a;color:#cfe8cf}
.p tr.global td:first-child{font-weight:600}
.sub{color:var(--dim);font-size:10px}
.note{margin:0 14px 24px;color:var(--dim);font-size:11px;max-width:900px;line-height:1.6}

aside{position:fixed;right:0;bottom:0;width:min(560px,100%);max-height:56vh;overflow:auto;
  background:var(--panel);border:1px solid var(--line);border-radius:6px 0 0 0;
  padding:10px 12px;box-shadow:0 -6px 24px rgba(0,0,0,.5);z-index:9}
aside h2{font-size:12px;margin:0 0 6px;font-weight:600;word-break:break-all}
aside table{border-collapse:collapse;font-size:11px;width:100%}
aside td{padding:2px 8px 2px 0;vertical-align:top}
aside tr.won td{color:var(--on)}
aside .k{color:var(--dim);width:86px}
aside .x{position:absolute;right:10px;top:8px;cursor:pointer;color:var(--dim)}
footer{position:fixed;left:0;bottom:0;padding:4px 14px;color:var(--dim);font-size:11px;
  background:var(--bg2);border-top:1px solid var(--line);border-right:1px solid var(--line);
  border-radius:0 6px 0 0;z-index:8}
.err{padding:20px 14px;color:var(--warn);line-height:1.7}
</style>
<style id="hlrule"></style>
<style id="catrule"></style>

<header>
  <h1>quartermaster</h1>
  <div class="snap" id="snap">reading&#8230;</div>
</header>

<nav>
  <div class="g2">
    <button class="tab" id="tab-ext" data-view="ext" aria-selected="true">extensions</button>
    <button class="tab" id="tab-proj" data-view="proj" aria-selected="false">projects</button>
  </div>
  <div class="g2" id="kinds"><span class="lbl">type</span></div>
  <div class="g2" id="catwrap" hidden><span class="lbl">category</span><select id="cat"></select></div>
  <div class="g2"><span class="lbl">highlight</span><select id="hl"></select></div>
</nav>

<div class="legend">
  <span><i class="sw" style="color:var(--on)">&#9679;</i>on / enabled</span>
  <span><i class="sw" style="color:var(--part)">&#9680;</i>name-only</span>
  <span><i class="sw" style="color:var(--part)">&#9681;</i>user-invocable-only</span>
  <span><i class="sw" style="color:var(--off)">&#9675;</i>off / disabled</span>
  <span class="bar">|</span>
  <span><i style="opacity:.45;font-style:italic">glyph</i> inherited</span>
  <span><b>glyph</b> overridden</span>
  <span><i style="color:var(--warn)">&#9651;</i> restated &#8212; redundant</span>
  <span><i style="color:var(--part)">&#9650;</i> round-trip &#8212; in force</span>
  <span class="bar">|</span>
  <span>decided at
    <span class="lgi" data-s="user"></span> user
    <span class="lgi" data-s="project"></span> project
    <span class="lgi" data-s="local"></span> local</span>
</div>

<main id="main">
  <div id="view-ext"></div>
  <div id="view-proj" hidden></div>
</main>

<aside id="detail" hidden><span class="x" id="detail-x">&#10005;</span><div id="detail-body"></div></aside>
<footer id="stat">&#8230;</footer>

<script>
(function () {
  'use strict';

  var T0 = performance.now();
  var S = null;         // StructureResponse
  var PROJECTS = [];    // columns, in payload order
  var CATS = null;      // plugin id -> bucket, or null when no matrix was read
  var HL = null;        // highlighted project id
  var COST = {};        // plugin id -> {state:'wait'|'none'|'ok', cost}
  var COST_CELLS = {};  // plugin id -> [td]
  var PSTATS = null;
  var GSTATS = null;
  var costDone = 0, costTotal = 0, paintedAt = 0;

  /**
   * One descriptor per extension kind.
   *
   * Skills start closed. 430 rows over 24 projects is 10,320 of the ~12,000 cells, and
   * \`skillOverrides\` is set nowhere in a typical workspace -- so nearly every one of them
   * carries the same glyph, and rendering them costs 84% of the first paint to draw a wall
   * of identical marks. The section renders on the click that asks for it. Virtualising
   * instead was rejected: scroll-window arithmetic is permanent maintenance for a section
   * most sessions never open. The day deferral stops being enough is when one kind alone
   * passes a few thousand rows, and the answer then is a filter, not a viewport.
   */
  var SECTIONS = [
    { key: 'plugin', list: 'plugins', title: 'plugins', open: true },
    { key: 'mcp', list: 'mcpServers', title: 'MCP servers', open: true },
    { key: 'skill', list: 'skills', title: 'skills', open: false }
  ];

  /** What the resolver falls back to when nothing sets a value. Needed by the global row. */
  var FALLBACK = { plugin: false, mcp: false, skill: 'on' };

  var GLYPH = {
    'true': '\\u25CF', 'false': '\\u25CB',
    'on': '\\u25CF', 'name-only': '\\u25D0', 'user-invocable-only': '\\u25D1', 'off': '\\u25CB'
  };
  var VNAME = {
    'true': 'enabled', 'false': 'disabled', 'on': 'on', 'name-only': 'name-only',
    'user-invocable-only': 'user-invocable-only', 'off': 'off'
  };
  /**
   * Most interesting first: the grouping answers "what is anyone actually scoping".
   *
   * round-trip sits above restated and below overridden because it is a project deciding
   * something -- its entry is in force -- that happens to land on the inherited value.
   * Ranking it with restated would file a live decision under "changes nothing", which is
   * the confusion QM-43 exists to undo.
   */
  var RANK = { overridden: 0, 'round-trip': 1, restated: 2, inherited: 3 };
  var GROUPS = [
    ['overridden', 'overridden in at least one project'],
    ['round-trip', 'set twice and back again \\u2014 in force, and not redundant'],
    ['restated', 'restated in at least one project \\u2014 changes nothing today'],
    ['inherited', 'inherited everywhere \\u2014 no project has an opinion']
  ];
  var UNCAT = 'uncategorised';

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ENT[c]; }); }
  function num(n) { return n.toLocaleString('en-US'); }
  function el(id) { return document.getElementById(id); }

  // -------------------------------------------------------------------------

  function boot() {
    fetch('/api/view')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(render)
      .catch(function (e) {
        el('main').innerHTML = '<p class="err">could not read /api/view \\u2014 ' +
          esc(e.message) + '<br>is <code>qm serve</code> still running?</p>';
      });
  }

  function render(data) {
    S = data;
    CATS = data.categories || null;
    buildProjects();
    header();
    controls();
    for (var i = 0; i < SECTIONS.length; i++) mountSection(SECTIONS[i]);
    paintedAt = performance.now();
    stat();
    // Only now: a price is a subprocess, and nothing about it belongs between the user
    // and a structure that is already in memory.
    fillCosts();
  }

  /**
   * Column identity is the digest, never the label.
   *
   * Two projects may legitimately both be called \`web\` -- the label is a bare directory
   * name by construction, since \`view/model.ts\` will not publish a path. Where labels
   * collide the digest disambiguates them.
   *
   * Collision is judged on the *shortened* form, not the full label, and the label is
   * shortened first so the digest always fits in a rotated column header. Suffixing an
   * untruncated label instead put the disambiguator in the part the header clips, which
   * is worse than not disambiguating: it looks decided when it is not. Two long labels
   * that differ only past the cut are the same case as two identical ones, and now get
   * the same answer. The full label stays on the title and in the detail panel.
   */
  var MAX_LABEL = 15;

  function shorten(s) {
    return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '\\u2026' : s;
  }

  function buildProjects() {
    var short = S.projects.map(function (p) { return shorten(p.label); });
    var seen = {};
    short.forEach(function (s) { seen[s] = (seen[s] || 0) + 1; });
    PROJECTS = S.projects.map(function (p, i) {
      return {
        id: p.id, label: p.label, cost: p.cost,
        disp: short[i] + (seen[short[i]] > 1 ? '\\u00b7' + p.id.slice(0, 4) : '')
      };
    });
  }

  function header() {
    var t = new Date(S.generatedAt);
    var note = 'read off disk once, at startup. A config edit shows up on a ' +
      'restart of <code>qm serve</code>, not on a page refresh \\u2014 the same rule a ' +
      'running Claude Code session follows for its own startup set.';
    el('snap').innerHTML = 'snapshot <b>' +
      esc(isNaN(t.getTime()) ? S.generatedAt : t.toLocaleString()) + '</b> \\u00b7 ' + note;
  }

  // -------------------------------------------------------------------------
  // controls

  function controls() {
    var kinds = el('kinds');
    SECTIONS.forEach(function (sec) {
      var l = document.createElement('label');
      l.className = 'ck';
      l.innerHTML = '<input type="checkbox" data-kind="' + esc(sec.key) + '" checked>' +
        esc(sec.title);
      kinds.appendChild(l);
    });

    // Two filters, not one. Type says which surface decides a row; category says what kind
    // of work the plugin is for. Folding them together makes "every MCP server in the
    // Domain-conditional bucket" unaskable -- and the buckets name plugins only.
    var buckets = {};
    if (CATS) for (var k in CATS) buckets[CATS[k]] = 1;
    var names = Object.keys(buckets).sort();
    if (names.length) {
      var opts = ['<option value="">all categories</option>'];
      names.forEach(function (n) {
        opts.push('<option value="' + esc(n) + '">' + esc(n) + '</option>');
      });
      opts.push('<option value="' + UNCAT + '">' + UNCAT + '</option>');
      el('cat').innerHTML = opts.join('');
      el('catwrap').hidden = false;
    }

    var hl = ['<option value="">none</option>'];
    PROJECTS.forEach(function (p) {
      hl.push('<option value="' + esc(p.id) + '">' + esc(p.disp) + '</option>');
    });
    el('hl').innerHTML = hl.join('');

    var nav = document.querySelector('nav');
    nav.addEventListener('click', onNavClick);
    nav.addEventListener('change', onNavChange);
    el('detail-x').addEventListener('click', function () { el('detail').hidden = true; });
    el('main').addEventListener('click', onMainClick);
  }

  function onNavClick(e) {
    var tab = e.target.closest('button.tab');
    if (tab) setView(tab.getAttribute('data-view'));
  }

  function onNavChange(e) {
    var t = e.target;
    var kind = t.getAttribute('data-kind');
    if (kind) {
      var sec = document.querySelector('section[data-kind="' + kind + '"]');
      if (sec) sec.hidden = !t.checked;
      return;
    }
    if (t.id === 'hl') setHighlight(t.value || null);
    else if (t.id === 'cat') setCategory(t.value);
  }

  function setView(v) {
    el('tab-ext').setAttribute('aria-selected', String(v === 'ext'));
    el('tab-proj').setAttribute('aria-selected', String(v === 'proj'));
    el('view-ext').hidden = v !== 'ext';
    el('view-proj').hidden = v === 'ext';
    if (v === 'proj' && !el('view-proj').firstChild) renderProjects();
  }

  /**
   * Highlighting is one CSS rule, not 500 class changes.
   *
   * The id is a hex digest off the wire, and it is checked against that shape before it is
   * spliced into a selector -- a payload that ever carried something else cannot write CSS
   * from here.
   */
  function setHighlight(id) {
    if (id && !/^[0-9a-f]{4,64}$/.test(id)) id = null;
    HL = id;
    el('hlrule').textContent = id
      ? '.g td[data-p="' + id + '"],.g th[data-p="' + id + '"],' +
        'table.p tr[data-p="' + id + '"]>td{background:var(--hl)}' +
        '.g th[data-p="' + id + '"] span{color:#cfe0ff}'
      : '';
    if (el('hl').value !== (id || '')) el('hl').value = id || '';
  }

  function setCategory(v) {
    var safe = v.replace(/["\\\\]/g, '');
    el('catrule').textContent = safe
      ? 'section[data-kind=plugin] tr[data-cat]:not([data-cat="' + safe + '"]){display:none}'
      : '';
    // The taxonomy names plugins. Saying so beats leaving two sections sitting unfiltered
    // beside a filter that never applied to them.
    var notes = document.querySelectorAll('.catnote');
    for (var i = 0; i < notes.length; i++) notes[i].hidden = !safe;
  }

  // -------------------------------------------------------------------------
  // extension view

  function mountSection(sec) {
    var rows = S[sec.list];
    var s = document.createElement('section');
    s.className = 'kind';
    s.setAttribute('data-kind', sec.key);
    s.innerHTML =
      '<div class="head" data-toggle="' + esc(sec.key) + '">' +
        '<span class="caret">' + (sec.open ? '\\u25BE' : '\\u25B8') + '</span>' +
        '<b>' + esc(sec.title) + '</b>' +
        '<span class="n">' + rows.length + ' \\u00d7 ' + PROJECTS.length + ' projects</span>' +
        (sec.key === 'plugin' ? '' :
          '<span class="n catnote" hidden>\\u2014 the matrix names plugins only</span>') +
        '<span class="sp"></span>' + phase2(sec) +
      '</div>' +
      '<div class="scroll" data-body="' + esc(sec.key) + '"></div>';
    el('view-ext').appendChild(s);
    if (sec.open) fillSection(sec);
  }

  /**
   * The add/remove control, rendered and inert.
   *
   * Writes are Phase 2 (DEA-112). It is here because its absence changes the layout -- a
   * header that grows a control later is a different header -- and disabled rather than
   * hidden, because a control nobody can see is a control nobody can review.
   */
  function phase2(sec) {
    return '<span class="g2 p2" title="writes are Phase 2 (DEA-112); this control does ' +
      'nothing yet"><select disabled><option>add / remove ' + esc(sec.title) +
      '\\u2026</option></select><span class="badge">Phase 2</span></span>';
  }

  function fillSection(sec) {
    var host = document.querySelector('[data-body="' + sec.key + '"]');
    if (host.firstChild) return;
    host.innerHTML = tableHtml(sec);
    if (sec.key === 'plugin') indexCostCells(host);
  }

  function tableHtml(sec) {
    var rows = S[sec.list];
    var buckets = { overridden: [], 'round-trip': [], restated: [], inherited: [] };
    for (var i = 0; i < rows.length; i++) buckets[groupOf(rows[i])].push(i);

    var h = ['<table class="g"><thead><tr><th class="rh">', esc(sec.title), '</th>'];
    for (var j = 0; j < PROJECTS.length; j++) {
      h.push('<th class="ch" data-p="', esc(PROJECTS[j].id), '" title="',
        esc(PROJECTS[j].label), '"><span>', esc(PROJECTS[j].disp), '</span></th>');
    }
    h.push('<th class="hc">always-on tok</th></tr></thead>');

    for (var g = 0; g < GROUPS.length; g++) {
      var idx = buckets[GROUPS[g][0]];
      if (!idx.length) continue;
      h.push('<tbody><tr class="grp"><td colspan="', String(PROJECTS.length + 2), '">',
        GROUPS[g][1], ' <b>', String(idx.length), '</b></td></tr>');
      for (var k = 0; k < idx.length; k++) h.push(rowHtml(sec, rows[idx[k]], idx[k]));
      h.push('</tbody>');
    }
    return h.join('') + '</table>';
  }

  /** A row's group is the most interesting thing any of its cells says. */
  function groupOf(row) {
    var best = 'inherited';
    for (var i = 0; i < row.cells.length; i++) {
      if (RANK[row.cells[i].origin] < RANK[best]) best = row.cells[i].origin;
    }
    return best;
  }

  /**
   * One row builder for all three kinds.
   *
   * A boolean and a four-valued skill differ only in which glyph the value maps to, so
   * they differ only in a lookup. A separate skill renderer is how the two would drift.
   */
  function rowHtml(sec, row, i) {
    var cat = sec.key === 'plugin' ? ((CATS && CATS[row.id]) || UNCAT) : null;
    var h = ['<tr data-k="', esc(sec.key), '" data-i="', String(i), '"',
      cat ? ' data-cat="' + esc(cat) + '"' : '', '><th class="rh" title="',
      esc(row.id + (cat ? '  \\u2014  ' + cat : '')), '">', esc(row.id), '</th>'];

    for (var j = 0; j < row.cells.length; j++) {
      var c = row.cells[j];
      var v = String(c.value);
      var won = c.chain.length ? c.chain[c.chain.length - 1] : null;
      h.push('<td class="c" data-p="', esc(c.project), '" data-v="', esc(v),
        '" data-o="', esc(c.origin), '"', won ? ' data-s="' + esc(won.scope) + '"' : '',
        ' title="', esc(VNAME[v] + ' \\u00b7 ' + c.origin + ' \\u00b7 ' +
          (won ? 'decided at ' + won.scope : 'nothing set a value')),
        '">', GLYPH[v] || '?', '</td>');
    }

    h.push(sec.key === 'plugin'
      ? '<td class="cost" data-cost="' + String(i) + '">' + costHtml(row.id) + '</td>'
      : '<td class="cost"><span class="na" title="no per-extension price exists for this ' +
        'kind">\\u2014</span></td>');
    return h.join('') + '</tr>';
  }

  function indexCostCells(host) {
    COST_CELLS = {};
    var tds = host.querySelectorAll('td[data-cost]');
    for (var i = 0; i < tds.length; i++) {
      var id = S.plugins[+tds[i].getAttribute('data-cost')].id;
      (COST_CELLS[id] = COST_CELLS[id] || []).push(tds[i]);
    }
  }

  /**
   * Three states, kept apart.
   *
   * \`null\` from \`/api/cost\` is an answer -- asked, and nothing could price it -- and a row
   * nobody has asked about yet must not borrow it. Unasked reads as pending; asked and
   * unanswerable says so in its own words.
   */
  function costHtml(id) {
    var c = COST[id];
    if (!c || c.state === 'wait') return '<span class="q" title="not priced yet">\\u2026</span>';
    if (c.state === 'none') {
      return '<span class="np" title="asked, and nothing could price it">no price</span>';
    }
    return '<span class="tok">' + num(c.cost.alwaysOnTokens) + '</span>' +
      (c.cost.mcpUncounted
        ? '<span class="np" title="excludes MCP servers this plugin provides"> +mcp</span>'
        : '');
  }

  // -------------------------------------------------------------------------
  // project view

  function stats() {
    if (PSTATS) return PSTATS;
    var out = {};
    PROJECTS.forEach(function (p) { out[p.id] = { plugins: [], mcp: 0, skills: 0 }; });
    S.plugins.forEach(function (r) {
      r.cells.forEach(function (c) { if (c.value === true) out[c.project].plugins.push(r.id); });
    });
    S.mcpServers.forEach(function (r) {
      r.cells.forEach(function (c) { if (c.value === true) out[c.project].mcp++; });
    });
    S.skills.forEach(function (r) {
      r.cells.forEach(function (c) { if (c.value !== 'on') out[c.project].skills++; });
    });
    PSTATS = out;
    return out;
  }

  /**
   * What a project would get if it said nothing at all.
   *
   * Read off the \`user\`-scope link of the cell's chain -- the same file for every column,
   * which is exactly why it is worth a pinned row: flipping it moves every project that
   * does not override, and that blast radius is invisible in a per-project view.
   */
  function globalValue(row, fallback) {
    for (var i = 0; i < row.cells.length; i++) {
      var ch = row.cells[i].chain;
      for (var j = ch.length - 1; j >= 0; j--) if (ch[j].scope === 'user') return ch[j].value;
    }
    return fallback;
  }

  function globalStats() {
    if (GSTATS) return GSTATS;
    var g = { plugins: [], mcp: 0, skills: 0 };
    S.plugins.forEach(function (r) {
      if (globalValue(r, FALLBACK.plugin) === true) g.plugins.push(r.id);
    });
    S.mcpServers.forEach(function (r) { if (globalValue(r, FALLBACK.mcp) === true) g.mcp++; });
    S.skills.forEach(function (r) { if (globalValue(r, FALLBACK.skill) !== 'on') g.skills++; });
    GSTATS = g;
    return g;
  }

  function renderProjects() {
    var st = stats();
    var g = globalStats();
    var h = ['<table class="p"><thead><tr><th>project</th><th>plugins on</th>',
      '<th>MCP on</th><th>skills scoped</th><th>baseline chars / session</th>',
      '<th>always-on tok</th></tr></thead><tbody>',
      '<tr class="global"><td>global <span class="sub">user scope \\u2014 what every ',
      'project inherits</span></td><td>', String(g.plugins.length), '</td><td>',
      String(g.mcp), '</td><td>', String(g.skills),
      '</td><td class="sub">not a global property</td><td data-tok="*"></td></tr>'];

    PROJECTS.forEach(function (p) {
      var s = st[p.id];
      var b = p.cost.baselineChars;
      h.push('<tr data-p="', esc(p.id), '"><td title="', esc(p.label), '">', esc(p.disp),
        '</td><td>',
        String(s.plugins.length), '</td><td>', String(s.mcp), '</td><td>', String(s.skills),
        '</td><td>',
        b.samples
          ? num(b.median) + ' <span class="sub">median \\u00b7 p95 ' + num(b.p95) +
            ' \\u00b7 n=' + b.samples + '</span>'
          : '<span class="sub">no sessions measured</span>',
        '</td><td data-tok="', esc(p.id), '"></td></tr>');
    });

    el('view-proj').innerHTML = h.join('') + '</tbody></table>' +
      '<p class="note">Counts are what resolves active for that project. Baseline chars ' +
      'are the measured startup block across that project\\u2019s own sessions \\u2014 a ' +
      'distribution with its sample count, never a point estimate. Always-on tokens sum ' +
      'the priced plugins enabled there and name what is still unpriced rather than ' +
      'quietly leaving it out of the total.</p>';
    updateTotals();
  }

  function updateTotals() {
    var host = el('view-proj');
    if (!host.firstChild) return;
    var st = stats();
    var cells = host.querySelectorAll('td[data-tok]');
    for (var i = 0; i < cells.length; i++) {
      var key = cells[i].getAttribute('data-tok');
      cells[i].innerHTML = totalHtml(key === '*' ? globalStats().plugins : st[key].plugins);
    }
  }

  function totalHtml(ids) {
    var sum = 0, pending = 0, none = 0;
    for (var i = 0; i < ids.length; i++) {
      var c = COST[ids[i]];
      if (!c || c.state === 'wait') pending++;
      else if (c.state === 'none') none++;
      else sum += c.cost.alwaysOnTokens;
    }
    return '<span class="tok">' + num(sum) + '</span>' +
      (pending ? '<span class="q"> +' + pending + ' pending</span>' : '') +
      (none ? '<span class="np"> +' + none + ' no price</span>' : '');
  }

  // -------------------------------------------------------------------------
  // prices

  /**
   * Bounded concurrency, because each answer is a subprocess.
   *
   * Serial is 0.6s x 42 = ~25s of a grid filling one row at a time. Unbounded is 42
   * simultaneous \`claude plugin details\` processes on the machine the user is working on.
   * Five in flight keeps the server busy without turning a page load into a fork bomb.
   */
  function fillCosts() {
    var ids = S.plugins.map(function (r) { return r.id; });
    costTotal = ids.length;
    if (!costTotal) return;
    var next = 0;

    function pump() {
      if (next >= ids.length) return;
      var id = ids[next++];
      COST[id] = { state: 'wait' };
      fetch('/api/cost?plugin=' + encodeURIComponent(id))
        .then(function (r) { return r.ok ? r.json() : { cost: null }; })
        .then(function (body) { setCost(id, body.cost); })
        .catch(function () { setCost(id, null); })
        .then(function () { costDone++; stat(); pump(); });
    }
    for (var i = 0; i < 5; i++) pump();
  }

  function setCost(id, cost) {
    COST[id] = cost ? { state: 'ok', cost: cost } : { state: 'none' };
    var cells = COST_CELLS[id] || [];
    for (var i = 0; i < cells.length; i++) cells[i].innerHTML = costHtml(id);
    updateTotals();
  }

  // -------------------------------------------------------------------------
  // interaction -- one listener for every cell, header and row

  function onMainClick(e) {
    if (e.target.closest('.p2')) return;

    var head = e.target.closest('.head');
    if (head) return toggleSection(head);

    var col = e.target.closest('th.ch');
    if (col) return toggleHighlight(col.getAttribute('data-p'));

    var prow = e.target.closest('table.p tr[data-p]');
    if (prow) return toggleHighlight(prow.getAttribute('data-p'));

    var cell = e.target.closest('td.c');
    if (cell) return showCell(cell);

    var rh = e.target.closest('tr[data-k] th.rh');
    if (rh) {
      var tr = rh.closest('tr');
      showRow(tr.getAttribute('data-k'), +tr.getAttribute('data-i'));
    }
  }

  function toggleHighlight(id) { setHighlight(HL === id ? null : id); }

  function toggleSection(head) {
    var key = head.getAttribute('data-toggle');
    var sec = SECTIONS.filter(function (s) { return s.key === key; })[0];
    sec.open = !sec.open;
    head.querySelector('.caret').textContent = sec.open ? '\\u25BE' : '\\u25B8';
    var body = document.querySelector('[data-body="' + key + '"]');
    body.style.display = sec.open ? '' : 'none';
    if (sec.open) fillSection(sec);
  }

  function rowOf(kind, i) {
    var sec = SECTIONS.filter(function (s) { return s.key === kind; })[0];
    return S[sec.list][i];
  }

  function projectOf(id) {
    for (var i = 0; i < PROJECTS.length; i++) if (PROJECTS[i].id === id) return PROJECTS[i];
    return null;
  }

  function showCell(td) {
    var tr = td.closest('tr');
    var kind = tr.getAttribute('data-k');
    var row = rowOf(kind, +tr.getAttribute('data-i'));
    var pid = td.getAttribute('data-p');
    var cell = row.cells.filter(function (c) { return c.project === pid; })[0];
    var p = projectOf(pid);
    var won = cell.chain.length ? cell.chain[cell.chain.length - 1] : null;
    var why = cell.origin === 'restated'
      ? 'set to the value it would have inherited anyway'
      : cell.origin === 'round-trip'
      ? 'set more than once here, the entries disagree, and the winner lands back on the '
        + 'inherited value \u2014 it is in force, and removing it flips this cell'
      : cell.origin === 'inherited' ? 'this project set nothing'
      : 'this project disagrees with what it would inherit';

    var h = ['<h2>', esc(row.id), ' <span class="k">in</span> ', esc(p ? p.disp : pid),
      '</h2><table>',
      '<tr><td class="k">value</td><td>', GLYPH[String(cell.value)], ' ',
      esc(VNAME[String(cell.value)]), '</td></tr>',
      '<tr><td class="k">origin</td><td>', esc(cell.origin), ' <span class="k">\\u2014 ',
      why, '</span></td></tr>',
      '<tr><td class="k">decided at</td><td>',
      won ? '<span class="lgi" data-s="' + esc(won.scope) + '"></span> ' + esc(won.scope)
        : '<span class="k">nothing set a value</span>',
      '</td></tr></table>'];

    if (cell.chain.length) {
      h.push('<h2 style="margin-top:10px">precedence chain</h2><table>');
      cell.chain.forEach(function (l, i) {
        var last = i === cell.chain.length - 1;
        h.push('<tr', last ? ' class="won"' : '', '><td class="k">', esc(l.scope),
          '</td><td>', GLYPH[String(l.value)], ' ', esc(VNAME[String(l.value)]),
          '</td><td>', esc(l.source), '</td><td>', last ? '\\u2190 won' : '', '</td></tr>');
      });
      h.push('</table>');
    }
    h.push(costDetail(kind, row.id));
    el('detail-body').innerHTML = h.join('');
    el('detail').hidden = false;
    setHighlight(pid);
  }

  function showRow(kind, i) {
    var row = rowOf(kind, i);
    var counts = { overridden: 0, 'round-trip': 0, restated: 0, inherited: 0 };
    row.cells.forEach(function (c) { counts[c.origin]++; });
    var cat = kind === 'plugin' ? ((CATS && CATS[row.id]) || UNCAT) : null;
    el('detail-body').innerHTML =
      '<h2>' + esc(row.id) + '</h2><table>' +
      '<tr><td class="k">kind</td><td>' + esc(row.kind) + '</td></tr>' +
      (cat ? '<tr><td class="k">category</td><td>' + esc(cat) + '</td></tr>' : '') +
      '<tr><td class="k">across</td><td>' + counts.overridden + ' overridden \\u00b7 ' +
      counts['round-trip'] + ' round-trip \\u00b7 ' +
      counts.restated + ' restated \\u00b7 ' + counts.inherited + ' inherited</td></tr>' +
      '</table>' + costDetail(kind, row.id);
    el('detail').hidden = false;
  }

  function costDetail(kind, id) {
    if (kind !== 'plugin') {
      return '<p class="k" style="margin:10px 0 0">No per-extension price. The measured ' +
        'per-server cost is keyed by tool namespace, which is not the config key, and a ' +
        'confidently wrong number costs more than an empty cell.</p>';
    }
    var c = COST[id];
    if (!c || c.state === 'wait') {
      return '<p class="k" style="margin:10px 0 0">Price not asked for yet.</p>';
    }
    if (c.state === 'none') {
      return '<p class="np" style="margin:10px 0 0">Asked, and nothing could price it.</p>';
    }
    var h = ['<h2 style="margin-top:10px">cost</h2><table>',
      '<tr><td class="k">always-on</td><td>', num(c.cost.alwaysOnTokens), ' tok',
      c.cost.mcpUncounted
        ? ' <span class="np">excludes MCP servers this plugin provides</span>' : '',
      '</td></tr>'];
    c.cost.components.forEach(function (k) {
      h.push('<tr><td class="k">', esc(k.name), '</td><td>', String(k.count), '</td></tr>');
    });
    return h.join('') + '</table>';
  }

  // -------------------------------------------------------------------------

  function stat() {
    var cells = 0;
    for (var i = 0; i < SECTIONS.length; i++) cells += S[SECTIONS[i].list].length * PROJECTS.length;
    el('stat').innerHTML = PROJECTS.length + ' projects \\u00b7 ' + num(cells) +
      ' cells \\u00b7 first paint ' + (paintedAt - T0).toFixed(0) + 'ms \\u00b7 prices ' +
      costDone + '/' + costTotal +
      (CATS ? '' : ' \\u00b7 <span class="np">no category matrix \\u2014 filter hidden</span>');
  }

  boot();
})();
</script>
`;
