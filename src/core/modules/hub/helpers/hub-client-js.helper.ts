/**
 * The Hub's entire client runtime, returned as a string and served from `GET /{hub}/hub.js`.
 *
 * Dependency-free vanilla JS (ES2017). It provides:
 * - a client-side router (pushState navigation between panels without a full reload),
 * - `Hub.fetch` (adds the embedded/stored auth token + `X-Hub-Request` on mutations),
 * - `Hub.poll` (one polling manager: pauses on `document.hidden`, backs off on error),
 * - DOM-only rendering helpers (`textContent`/`createElement`, never `innerHTML`) so panel data can
 *   never inject markup,
 * - `Hub.confirmAction` (type-to-confirm dialog for destructive actions).
 *
 * Per-panel renderers are registered on `Hub.panels`; a generic JSON renderer is the fallback so a
 * panel is functional the moment its sidecar exists. The navigation, environment badge and external
 * links are NOT baked into this public bundle — they arrive from the ADMIN-gated `session.json`
 * payload and are rendered by `buildLayout()` only after a successful auth check, so neither the
 * shell HTML nor this script reveals the Hub's structure to an unauthenticated request.
 */
export function getHubClientJs(): string {
  return `/* @lenne.tech/nest-server Hub client runtime */
(function () {
  'use strict';

  // Cockpit chrome data — populated from the ADMIN-gated session.json payload by buildLayout(), NOT
  // baked into this public bundle (so an anonymous request reveals nothing of the Hub's structure).
  var PANELS = [];
  var PANEL_GROUPS = [];
  var LINKS = {};
  var LOGOUT = '/iam/sign-out';
  var LAYOUT_BUILT = false;
  var BASE = (window.__HUB_BASE__ || '/hub').replace(/\\/+$/, '');
  var TOKEN = window.__HUB_TOKEN__ || null;
  var POLL_MS = window.__HUB_POLL_MS__ || 5000;

  // ---- utilities ---------------------------------------------------------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    // NOTE: style is applied via the CSSOM (node.style.cssText), NOT setAttribute('style', ...).
    // Under the Hub's strict CSP (style-src 'nonce-...', no 'unsafe-inline') a declarative style
    // attribute is blocked ("Applying inline style violates ..."), but CSSOM style mutations are not,
    // so dynamic styling (bar widths, dialog layout, preview iframes) keeps working.
    if (attrs) { for (var k in attrs) { if (k === 'class') { node.className = attrs[k]; } else if (k === 'text') { node.textContent = attrs[k]; } else if (k === 'style') { node.style.cssText = attrs[k]; } else { node.setAttribute(k, attrs[k]); } } }
    if (children) { for (var i = 0; i < children.length; i++) { var c = children[i]; if (c != null) { node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } } }
    return node;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function storedToken() { try { return sessionStorage.getItem('hub.token'); } catch (e) { return null; } }
  function setToken(t) { TOKEN = t; try { if (t) { sessionStorage.setItem('hub.token', t); } else { sessionStorage.removeItem('hub.token'); } } catch (e) {} }
  function authValue() { return TOKEN || storedToken(); }

  function fmtBytes(n) { if (n == null) { return '–'; } var u = ['B', 'KB', 'MB', 'GB', 'TB']; var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; }
  function fmtMs(n) { if (n == null) { return '–'; } return n < 1 ? n.toFixed(2) + ' ms' : Math.round(n) + ' ms'; }
  function fmtDuration(s) { s = Math.floor(s); var d = Math.floor(s / 86400); var h = Math.floor((s % 86400) / 3600); var m = Math.floor((s % 3600) / 60); var parts = []; if (d) { parts.push(d + 'd'); } if (h) { parts.push(h + 'h'); } if (m) { parts.push(m + 'm'); } parts.push((s % 60) + 's'); return parts.join(' '); }
  function relTime(iso) { try { var t = typeof iso === 'number' ? iso : Date.parse(iso); var diff = (Date.now() - t) / 1000; if (diff < 60) { return Math.floor(diff) + 's ago'; } if (diff < 3600) { return Math.floor(diff / 60) + 'm ago'; } if (diff < 86400) { return Math.floor(diff / 3600) + 'h ago'; } return Math.floor(diff / 86400) + 'd ago'; } catch (e) { return String(iso); } }

  // ---- fetch -------------------------------------------------------------
  function hubFetch(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var token = authValue();
    if (token) { headers['Authorization'] = token.indexOf(' ') >= 0 ? token : 'Bearer ' + token; }
    if (opts.method && opts.method !== 'GET') { headers['X-Hub-Request'] = '1'; if (opts.body != null) { headers['Content-Type'] = 'application/json'; } }
    return fetch(BASE + path, {
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      headers: headers,
      method: opts.method || 'GET',
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) { showLogin(); throw new Error('unauthorized'); }
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') >= 0) { return res.json(); }
      return res.text();
    });
  }

  // ---- table -------------------------------------------------------------
  function table(columns, rows) {
    var t = el('table', { class: 'hub-table' });
    var thead = el('thead');
    var htr = el('tr');
    columns.forEach(function (c) { htr.appendChild(el('th', { text: c.label })); });
    thead.appendChild(htr);
    var tbody = el('tbody');
    rows.forEach(function (row) {
      var tr = el('tr');
      columns.forEach(function (c) {
        var v = c.render ? c.render(row) : row[c.key];
        var td = el('td');
        if (v && v.nodeType) { td.appendChild(v); } else { td.textContent = v == null ? '' : String(v); }
        if (c.cls) { td.className = c.cls; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.appendChild(thead); t.appendChild(tbody);
    return t;
  }

  function tiles(items) {
    var wrap = el('div', { class: 'hub-tiles' });
    items.forEach(function (it) {
      wrap.appendChild(el('div', { class: 'hub-tile' }, [
        el('div', { class: 'hub-tile-label', text: it.label }),
        el('div', { class: 'hub-tile-value ' + (it.cls || ''), text: it.value }),
        it.sub ? el('div', { class: 'hub-tile-sub', text: it.sub }) : null,
      ]));
    });
    return wrap;
  }

  function jsonView(value) {
    var pre = el('pre', { class: 'hub-json' });
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }

  function unavailable(hint) {
    return el('div', { class: 'hub-empty' }, [el('p', { text: hint || 'Not available.' })]);
  }

  // ---- confirm dialog ----------------------------------------------------
  function confirmAction(o) {
    var dlg = document.getElementById('hub-confirm');
    clear(dlg);
    var input = el('input', { class: 'hub-input', placeholder: o.keyword });
    var ok = el('button', { class: 'hub-btn hub-btn-danger', text: o.confirmLabel || 'Confirm', disabled: 'disabled' });
    input.addEventListener('input', function () { if (input.value === o.keyword) { ok.removeAttribute('disabled'); } else { ok.setAttribute('disabled', 'disabled'); } });
    ok.addEventListener('click', function () { dlg.close(); o.onConfirm(); });
    var cancel = el('button', { class: 'hub-btn', text: 'Cancel' });
    cancel.addEventListener('click', function () { dlg.close(); });
    dlg.appendChild(el('h3', { text: o.title }));
    dlg.appendChild(el('p', { text: o.message }));
    dlg.appendChild(el('p', { class: 'hub-hint', text: 'Type "' + o.keyword + '" to confirm.' }));
    dlg.appendChild(input);
    dlg.appendChild(el('div', { class: 'hub-dialog-actions' }, [cancel, ok]));
    dlg.showModal();
    input.focus();
  }

  // Run a mutating action: optional type-to-confirm, then POST/DELETE with the X-Hub-Request header.
  function doAction(o) {
    function run() {
      hubFetch(o.path, { body: o.body || {}, method: o.method || 'POST' }).then(function (r) {
        toast((o.label || 'Action') + ': ' + (r && r.ok ? 'done' : 'ok'));
        if (o.onDone) { o.onDone(r); }
      }, function (e) { toast('Failed: ' + e.message, true); });
    }
    if (o.keyword) {
      confirmAction({ confirmLabel: o.confirmLabel, keyword: o.keyword, message: o.message, onConfirm: run, title: o.title });
    } else { run(); }
  }

  function toast(msg, isError) {
    var t = el('div', { class: 'hub-toast' + (isError ? ' hub-toast-err' : ''), text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.parentNode && t.parentNode.removeChild(t); }, 3500);
  }

  // Full-screen login gate: while unauthenticated the app layout stays hidden (body.hub-locked) and
  // ONLY this login card is shown. Email/password → IAM endpoint sets the session cookie (Hub is
  // self-sufficient); a token-paste fallback covers cookie-less setups.
  var loginRendered = false;
  function showLogin() {
    document.body.classList.add('hub-locked');
    stopPoll();
    var gate = document.getElementById('hub-gate');
    if (!gate || loginRendered) { return; }
    loginRendered = true;
    var loginUrl = window.__HUB_LOGIN__ || '/iam/sign-in/email';
    var email = el('input', { autocomplete: 'username', class: 'hub-input', placeholder: 'Email', type: 'email' });
    var pass = el('input', { autocomplete: 'current-password', class: 'hub-input', placeholder: 'Password', type: 'password' });
    var err = el('div', { class: 'hub-hint', style: 'color:var(--err);min-height:16px' });
    var loginBtn = el('button', { class: 'hub-btn hub-btn-primary', style: 'width:100%', text: 'Sign in' });
    function doLogin() {
      err.textContent = '';
      loginBtn.setAttribute('disabled', 'disabled');
      fetch(loginUrl, { body: JSON.stringify({ email: email.value.trim(), password: pass.value }), credentials: 'same-origin', headers: { 'content-type': 'application/json' }, method: 'POST' })
        .then(function (r) { if (r.status >= 200 && r.status < 300) { return r; } throw new Error('Invalid credentials or not an admin.'); })
        .then(function () { enterApp(); })
        .catch(function (e) { err.textContent = e.message; loginBtn.removeAttribute('disabled'); });
    }
    loginBtn.addEventListener('click', doLogin);
    email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { pass.focus(); } });
    pass.addEventListener('keydown', function (e) { if (e.key === 'Enter') { doLogin(); } });

    var tokenInput = el('input', { class: 'hub-input', placeholder: 'Paste admin token', type: 'password' });
    var tokenBtn = el('button', { class: 'hub-btn', style: 'width:100%', text: 'Use token' });
    tokenBtn.addEventListener('click', function () { setToken(tokenInput.value.trim()); enterApp(); });

    var card = el('div', { class: 'hub-gate-card' }, [
      // Brand only — no environment badge. The pre-auth login page must reveal nothing about the app.
      el('div', { class: 'hub-gate-brand', text: 'Hub' }),
      el('h2', { text: 'Sign in' }),
      el('p', { class: 'hub-hint', text: 'Admin access required.' }),
      email, pass, err,
      loginBtn,
      el('details', { style: 'margin-top:28px;border-top:1px solid var(--border);padding-top:16px' }, [
        el('summary', { class: 'hub-hint', style: 'cursor:pointer', text: 'Use an access token instead' }),
        tokenInput, tokenBtn,
      ]),
    ]);
    clear(gate);
    gate.appendChild(card);
    email.focus();
  }

  // Reveal the app after a successful auth check/login and (re)render the active panel. The cockpit
  // chrome is built lazily from the ADMIN-gated session payload (after a fresh login it isn't built
  // yet), so ensure it exists first.
  function enterApp() {
    loginRendered = false;
    if (LAYOUT_BUILT) {
      document.body.classList.remove('hub-locked');
      render(current());
    } else {
      fetchSession();
    }
  }

  // Fetch the ADMIN-gated session payload, build the cockpit chrome from it, reveal the app and render
  // the active panel. A 401/403 keeps only the login form visible.
  function fetchSession() {
    var headers = {};
    var token = authValue();
    if (token) { headers['Authorization'] = token.indexOf(' ') >= 0 ? token : 'Bearer ' + token; }
    return fetch(BASE + '/session.json', { credentials: 'same-origin', headers: headers })
      .then(function (r) {
        if (!r.ok) { showLogin(); return; }
        return r.json().then(function (payload) {
          buildLayout(payload);
          loginRendered = false;
          document.body.classList.remove('hub-locked');
          render(current());
        });
      })
      .catch(function () { showLogin(); });
  }

  // Sign out: clear the session cookie (POST the ADMIN-gated logoutEndpoint, default /iam/sign-out),
  // drop any pasted token, tear down the built layout and show the login gate again. The endpoint is
  // an IAM route (absolute from the origin), NOT under the Hub base path — so no BASE prefix.
  function signOut() {
    var headers = {};
    var token = authValue();
    if (token) { headers['Authorization'] = token.indexOf(' ') >= 0 ? token : 'Bearer ' + token; }
    fetch(LOGOUT, { credentials: 'same-origin', headers: headers, method: 'POST' })
      .then(function () {}, function () {})
      .then(function () {
        setToken(null);
        stopPoll();
        LAYOUT_BUILT = false;
        var appRoot = document.getElementById('hub-app');
        if (appRoot) { clear(appRoot); }
        loginRendered = false;
        showLogin();
      });
  }

  // Build the cockpit chrome (nav + brand/env + external links + topbar + content host) into #hub-app
  // from the session payload. Runs once; a later auth check reuses the built layout.
  function buildLayout(payload) {
    if (LAYOUT_BUILT) { return; }
    payload = payload || {};
    PANELS = payload.panels || [];
    PANEL_GROUPS = payload.panelGroups || [];
    LINKS = payload.links || {};
    LOGOUT = payload.logoutEndpoint || '/iam/sign-out';
    var appRoot = document.getElementById('hub-app');
    if (!appRoot) { return; }
    clear(appRoot);

    var nav = el('nav', { class: 'hub-nav' });
    nav.appendChild(el('div', { class: 'hub-brand' }, [
      document.createTextNode('Hub '),
      el('span', { class: 'hub-env hub-env-' + (payload.env || ''), text: payload.env || '' }),
    ]));
    PANEL_GROUPS.forEach(function (group) {
      var items = PANELS.filter(function (p) { return p.group === group; });
      if (!items.length) { return; }
      nav.appendChild(el('h3', { text: group }));
      items.forEach(function (p) {
        if (p.available === false) {
          // Optional panel whose backing module is absent: greyed out and NOT clickable (no
          // data-panel → the nav click handler ignores it; no href → it is not a link).
          nav.appendChild(el('a', { class: 'hub-nav-disabled', text: p.title, title: p.title + ' — module not enabled' }));
        } else {
          nav.appendChild(el('a', { 'data-panel': p.id, 'data-path': p.path, href: BASE + (p.path ? '/' + p.path : ''), text: p.title }));
        }
      });
    });
    // The external "Permissions" link opens the standalone report — same source as the Routes panel.
    // Hide it when that source is unavailable so there is no dead link (mirrors the greyed nav entry).
    var routesAvailable = PANELS.some(function (p) { return p.id === 'routes' && p.available !== false; });
    var ext = [];
    if (LINKS.swagger) { ext.push(el('a', { class: 'hub-ext', href: LINKS.swagger, rel: 'noopener', target: '_blank', text: 'Swagger' })); }
    if (LINKS.graphql) { ext.push(el('a', { class: 'hub-ext', href: LINKS.graphql, rel: 'noopener', target: '_blank', text: 'GraphQL' })); }
    if (LINKS.permissions && routesAvailable) { ext.push(el('a', { class: 'hub-ext', href: LINKS.permissions, rel: 'noopener', target: '_blank', text: 'Permissions' })); }
    if (LINKS.mailpit) { ext.push(el('a', { class: 'hub-ext', href: LINKS.mailpit, rel: 'noopener', target: '_blank', text: 'Mailpit' })); }
    if (ext.length) { nav.appendChild(el('h3', { text: 'External' })); ext.forEach(function (a) { nav.appendChild(a); }); }

    var signout = el('button', { class: 'hub-btn hub-signout', text: 'Sign out' });
    signout.addEventListener('click', signOut);
    var topbar = el('header', { class: 'hub-topbar' }, [
      el('h1', { id: 'hub-title', text: 'Dashboard' }),
      el('div', { class: 'hub-meta' }, [
        document.createTextNode('v' + (payload.version || '') + ' '),
        el('span', { class: 'hub-dot hub-dot-ok', id: 'hub-refresh', title: 'auto-refresh' }),
        signout,
      ]),
    ]);
    var main = el('div', { class: 'hub-main' }, [topbar, el('div', { class: 'hub-content', id: 'hub-content' })]);
    appRoot.appendChild(el('div', { class: 'hub-layout' }, [nav, main]));

    nav.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-panel]') : null;
      if (a) { e.preventDefault(); navigate(findPanel(a.getAttribute('data-path')), true); }
    });
    LAYOUT_BUILT = true;
  }

  // ---- polling manager ---------------------------------------------------
  var activeTimer = null;
  var activeBackoff = POLL_MS;
  function stopPoll() { if (activeTimer) { clearTimeout(activeTimer); activeTimer = null; } }
  function poll(fn, ms) {
    stopPoll();
    activeBackoff = ms || POLL_MS;
    function tick() {
      if (document.hidden) { activeTimer = setTimeout(tick, activeBackoff); return; }
      Promise.resolve(fn()).then(function () { activeBackoff = ms || POLL_MS; setIndicator('ok'); }, function () { activeBackoff = Math.min(activeBackoff * 2, 60000); setIndicator('err'); }).then(function () { activeTimer = setTimeout(tick, activeBackoff); });
    }
    tick();
  }
  function setIndicator(state) { var d = document.getElementById('hub-refresh'); if (d) { d.className = 'hub-dot hub-dot-' + state; } }

  // ---- router ------------------------------------------------------------
  function current() { var rel = location.pathname.slice(BASE.length).replace(/^\\/+/, ''); return findPanel(rel); }
  function findPanel(rel) { for (var i = 0; i < PANELS.length; i++) { if (PANELS[i].path === rel) { return PANELS[i]; } } return PANELS[0]; }

  function navigate(panel, push) {
    if (push) { history.pushState({ id: panel.id }, '', BASE + (panel.path ? '/' + panel.path : '')); }
    render(panel);
  }

  function highlightNav(panel) {
    var links = document.querySelectorAll('.hub-nav a[data-panel]');
    for (var i = 0; i < links.length; i++) { links[i].classList.toggle('active', links[i].getAttribute('data-panel') === panel.id); }
    var title = document.getElementById('hub-title');
    if (title) { title.textContent = panel.title; }
  }

  function render(panel) {
    stopPoll();
    highlightNav(panel);
    var content = document.getElementById('hub-content');
    clear(content);
    var renderer = Hub.panels[panel.id] || genericRenderer(panel);
    renderer(content, panel);
  }

  function genericRenderer(panel) {
    return function (content) {
      function load() {
        return hubFetch('/' + panel.json).then(function (data) {
          clear(content);
          if (data && data.available === false) { content.appendChild(unavailable(data.hint)); return; }
          content.appendChild(jsonView(data));
        }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
      }
      poll(load, POLL_MS);
    };
  }

  // ---- exported API ------------------------------------------------------
  window.Hub = {
    clear: clear,
    confirmAction: confirmAction,
    doAction: doAction,
    el: el,
    fetch: hubFetch,
    fmtBytes: fmtBytes,
    fmtDuration: fmtDuration,
    fmtMs: fmtMs,
    jsonView: jsonView,
    navigate: navigate,
    panels: {},
    poll: poll,
    relTime: relTime,
    setToken: setToken,
    table: table,
    tiles: tiles,
    unavailable: unavailable,
  };

  // ---- panel renderers ---------------------------------------------------
  function pollInto(content, json, build) {
    poll(function () {
      return hubFetch('/' + json).then(function (data) {
        clear(content);
        if (data && data.available === false) { content.appendChild(unavailable(data.hint)); return; }
        build(content, data);
      }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
    }, POLL_MS);
  }

  Hub.panels.dashboard = function (content) {
    pollInto(content, 'dashboard.json', function (c, d) {
      var mem = d.memory || {};
      c.appendChild(tiles([
        { label: 'Environment', value: (d.build && d.build.env) || '–' },
        { label: 'Version', value: (d.build && d.build.version) || '–', sub: d.build && d.build.commit !== 'unknown' ? d.build.commit : '' },
        { label: 'Uptime', value: fmtDuration(d.uptimeSeconds || 0) },
        { label: 'Heap used', value: fmtBytes(mem.heapUsed), sub: 'of ' + fmtBytes(mem.heapTotal) },
        { label: 'RSS', value: fmtBytes(mem.rss) },
        { label: 'MongoDB', value: (d.mongo && d.mongo.state) || '–', cls: d.mongo && d.mongo.readyState === 1 ? 'ok' : 'warn' },
      ]));
      var feats = d.features || {};
      var frow = el('div', { class: 'hub-tiles' });
      Object.keys(feats).sort().forEach(function (k) {
        frow.appendChild(el('div', { class: 'hub-tile' }, [
          el('div', { class: 'hub-tile-label', text: k }),
          el('div', { class: 'hub-tile-value ' + (feats[k] ? 'ok' : ''), text: feats[k] ? 'on' : 'off' }),
        ]));
      });
      c.appendChild(el('h3', { text: 'Features' }));
      c.appendChild(frow);
    });
  };

  Hub.panels.diagnostics = function (content) {
    pollInto(content, 'diagnostics.json', function (c, d) {
      var m = d.memory || {};
      c.appendChild(tiles([
        { label: 'Node', value: d.nodeVersion }, { label: 'Platform', value: d.platform + '/' + d.arch },
        { label: 'PID', value: d.pid }, { label: 'Uptime', value: fmtDuration(d.uptimeSeconds || 0) },
        { label: 'Heap used', value: fmtBytes(m.heapUsed), sub: 'of ' + fmtBytes(m.heapTotal) },
        { label: 'RSS', value: fmtBytes(m.rss) }, { label: 'External', value: fmtBytes(m.external) },
        { label: 'ArrayBuffers', value: fmtBytes(m.arrayBuffers) },
      ]));
      if (d.buffers && Object.keys(d.buffers).length) {
        c.appendChild(el('h3', { text: 'Collector buffers' }));
        c.appendChild(table([{ key: 'name', label: 'Collector' }, { key: 'state', label: 'State' }, { key: 'fill', label: 'Fill' }],
          Object.keys(d.buffers).map(function (k) { var b = d.buffers[k]; return { fill: b.size + ' / ' + b.capacity, name: k, state: b.enabled ? 'on' : 'off' }; })));
      }
    });
  };

  Hub.panels.db = function (content) {
    pollInto(content, 'db.json', function (c, d) {
      var s = d.stats || {};
      c.appendChild(tiles([
        { label: 'Collections', value: s.collections }, { label: 'Objects', value: s.objects },
        { label: 'Data size', value: fmtBytes(s.dataSize) }, { label: 'Storage', value: fmtBytes(s.storageSize) },
        { label: 'Index size', value: fmtBytes(s.indexSize) },
      ]));
      c.appendChild(table([
        { key: 'name', label: 'Collection' }, { key: 'count', label: 'Docs' },
        { cls: '', key: 'size', label: 'Size', render: function (r) { return fmtBytes(r.size); } },
        { key: 'storageSize', label: 'Storage', render: function (r) { return fmtBytes(r.storageSize); } },
        { key: 'avgObjSize', label: 'Avg obj', render: function (r) { return r.avgObjSize ? fmtBytes(r.avgObjSize) : '–'; } },
      ], d.collections || []));
    });
  };

  Hub.panels.models = function (content) {
    // Models rarely change; load once instead of polling.
    hubFetch('/models.json').then(function (d) {
      clear(content);
      if (d && d.available === false) { content.appendChild(unavailable(d.hint)); return; }
      content.appendChild(tiles([{ label: 'Models', value: d.modelCount }, { label: 'Relations', value: d.relationCount }]));
      var copyBtn = el('button', { class: 'hub-btn', text: 'Copy Mermaid source' });
      copyBtn.addEventListener('click', function () { try { navigator.clipboard.writeText(d.mermaid); copyBtn.textContent = 'Copied!'; } catch (e) {} });
      var liveLink = el('a', { class: 'hub-btn hub-ext', href: 'https://mermaid.live', target: '_blank', rel: 'noopener', text: 'mermaid.live' });
      content.appendChild(el('div', { class: 'hub-dialog-actions', style: 'justify-content:flex-start' }, [copyBtn, liveLink]));
      var pre = el('pre', { class: 'hub-json' }); pre.textContent = d.mermaid; content.appendChild(pre);
      (d.entities || []).forEach(function (ent) {
        content.appendChild(el('h3', { text: ent.name }));
        content.appendChild(table([{ key: 'name', label: 'Field' }, { key: 'type', label: 'Type' }, { key: 'ref', label: 'Ref', render: function (r) { return r.ref || ''; } }], ent.fields || []));
      });
    }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
  };

  Hub.panels.config = function (content) {
    hubFetch('/config.json').then(function (d) { clear(content); content.appendChild(el('p', { class: 'hub-hint', text: 'Secrets are masked.' })); content.appendChild(jsonView(d)); },
      function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
  };

  Hub.panels.migrations = function (content) {
    pollInto(content, 'migrations.json', function (c, d) {
      c.appendChild(tiles([
        { label: 'Completed', value: (d.completed || []).length, cls: 'ok' },
        { label: 'Pending', value: (d.pending || []).length, cls: (d.pending || []).length ? 'warn' : '' },
        { label: 'Last run', value: d.lastRun ? relTime(d.lastRun) : '–' },
      ]));
      var runBtn = el('button', { class: 'hub-btn hub-btn-primary', text: 'Run pending' });
      runBtn.addEventListener('click', function () { doAction({ body: { confirm: 'RUN' }, keyword: 'RUN', label: 'Run migrations', message: 'Run all pending migrations?', path: '/actions/migrations/run', title: 'Run pending migrations', onDone: function () { render(current()); } }); });
      var downBtn = el('button', { class: 'hub-btn hub-btn-danger', text: 'Rollback last' });
      downBtn.addEventListener('click', function () { doAction({ body: { confirm: 'DOWN' }, keyword: 'DOWN', label: 'Rollback', message: 'Roll back the last applied migration?', path: '/actions/migrations/down', title: 'Rollback last migration', onDone: function () { render(current()); } }); });
      c.appendChild(el('div', { class: 'hub-dialog-actions', style: 'justify-content:flex-start;margin-bottom:12px' }, [runBtn, downBtn]));
      if (!d.dirAvailable) { c.appendChild(el('p', { class: 'hub-hint', text: 'Migrations directory not found — pending count unavailable.' })); }
      c.appendChild(el('h3', { text: 'Completed' }));
      c.appendChild(table([{ key: 'name', label: 'Migration' }], (d.completed || []).map(function (n) { return { name: n }; })));
      c.appendChild(el('h3', { text: 'Pending' }));
      c.appendChild(table([{ key: 'name', label: 'Migration' }], (d.pending || []).map(function (n) { return { name: n }; })));
    });
  };

  Hub.panels.files = function (content) {
    pollInto(content, 'files.json', function (c, d) {
      c.appendChild(tiles([{ label: 'Files', value: d.total }, { label: 'Bucket', value: d.bucket }]));
      c.appendChild(table([
        { key: 'filename', label: 'Filename' },
        { key: 'length', label: 'Size', render: function (r) { return fmtBytes(r.length); } },
        { key: 'contentType', label: 'Type', render: function (r) { return r.contentType || '–'; } },
        { key: 'uploadDate', label: 'Uploaded', render: function (r) { return r.uploadDate ? relTime(r.uploadDate) : '–'; } },
        { key: 'id', label: '', render: function (r) {
          var b = el('button', { class: 'hub-btn hub-btn-danger', text: 'Delete' });
          b.addEventListener('click', function () { doAction({ body: { confirm: r.filename }, confirmLabel: 'Delete', keyword: r.filename, label: 'Delete file', message: 'Delete "' + r.filename + '"? This cannot be undone.', method: 'DELETE', path: '/actions/files/' + r.id, title: 'Delete file', onDone: function () { render(current()); } }); });
          return b;
        } },
      ], d.files || []));
    });
  };

  function clearButton(name) {
    var b = el('button', { class: 'hub-btn', text: 'Clear buffer' });
    b.addEventListener('click', function () { doAction({ body: { confirm: 'CLEAR' }, keyword: 'CLEAR', label: 'Clear ' + name, message: 'Clear the ' + name + ' buffer?', path: '/actions/collectors/' + name + '/clear', title: 'Clear ' + name, onDone: function () { render(current()); } }); });
    return el('div', { class: 'hub-dialog-actions', style: 'justify-content:flex-start;margin-bottom:12px' }, [b]);
  }

  Hub.panels.routes = function (content) {
    // Routes / Permissions report (reuses the permissions scanner). Rarely changes — load once.
    hubFetch('/routes.json').then(function (d) {
      clear(content);
      if (d && d.available === false) { content.appendChild(unavailable(d.hint)); return; }
      var s = d.stats || {};
      content.appendChild(tiles([
        { label: 'Endpoints', value: s.totalEndpoints },
        { label: 'Modules', value: s.totalModules },
        { label: 'Models', value: s.totalModels },
        { label: 'Warnings', value: s.totalWarnings, cls: s.totalWarnings ? 'warn' : '' },
        { label: 'Endpoint coverage', value: s.endpointCoverage != null ? s.endpointCoverage + '%' : '–' },
        { label: 'Security coverage', value: s.securityCoverage != null ? s.securityCoverage + '%' : '–' },
      ]));
      if ((d.warnings || []).length) {
        content.appendChild(el('h3', { text: 'Warnings' }));
        content.appendChild(table([
          { key: 'type', label: 'Type', render: function (r) { return el('span', { class: 'hub-chip hub-chip-warn', text: r.type }); } },
          { key: 'module', label: 'Module' },
          { key: 'details', label: 'Details' },
        ], d.warnings));
      }
      // Flatten every controller/resolver method into one searchable endpoint table.
      var rows = [];
      (d.modules || []).forEach(function (m) {
        [].concat(m.controllers || [], m.resolvers || []).forEach(function (c) {
          (c.methods || []).forEach(function (meth) {
            rows.push({
              className: c.className,
              http: meth.httpMethod || 'GQL',
              module: m.name,
              name: meth.name,
              roles: (meth.roles || []).join(', ') || '–',
              route: meth.route || '',
            });
          });
        });
      });
      var search = el('input', { class: 'hub-input', placeholder: 'Search endpoints…' });
      var host = el('div');
      function draw(filter) {
        clear(host);
        var filtered = rows.filter(function (r) {
          return !filter || (r.module + ' ' + r.className + ' ' + r.name + ' ' + r.route + ' ' + r.roles).toLowerCase().indexOf(filter) >= 0;
        });
        host.appendChild(table([
          { key: 'module', label: 'Module' },
          { key: 'className', label: 'Class' },
          { key: 'http', label: 'Method' },
          { key: 'name', label: 'Handler' },
          { key: 'route', label: 'Route' },
          { key: 'roles', label: 'Roles', render: function (r) {
            // Highlight public / unguarded endpoints (S_EVERYONE or no roles) as a warning.
            var open = r.roles === '–' || r.roles.indexOf('S_EVERYONE') >= 0;
            return el('span', { class: 'hub-chip ' + (open ? 'hub-chip-warn' : 'hub-chip-ok'), text: r.roles });
          } },
        ], filtered));
      }
      search.addEventListener('input', function () { draw(search.value.toLowerCase()); });
      content.appendChild(el('h3', { text: 'Endpoints (' + rows.length + ')' }));
      content.appendChild(search);
      content.appendChild(host);
      draw('');
    }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
  };

  Hub.panels['error-codes'] = function (content) {
    hubFetch('/error-codes.json').then(function (d) {
      clear(content);
      if (d && d.available === false) { content.appendChild(unavailable(d.hint)); return; }
      var search = el('input', { class: 'hub-input', placeholder: 'Search error codes…' });
      var host = el('div');
      function draw(filter) {
        clear(host);
        var rows = (d.codes || []).filter(function (r) { return !filter || (r.code + ' ' + (r.en || '') + ' ' + (r.de || '')).toLowerCase().indexOf(filter) >= 0; });
        host.appendChild(table([{ key: 'code', label: 'Code' }, { key: 'en', label: 'EN', render: function (r) { return r.en || ''; } }, { key: 'de', label: 'DE', render: function (r) { return r.de || ''; } }], rows));
      }
      search.addEventListener('input', function () { draw(search.value.toLowerCase()); });
      content.appendChild(search); content.appendChild(host); draw('');
    }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
  };

  Hub.panels.cron = function (content) {
    pollInto(content, 'cron.json', function (c, d) {
      c.appendChild(table([
        { key: 'name', label: 'Job' },
        { key: 'running', label: 'Running', render: function (r) { return el('span', { class: 'hub-chip ' + (r.running ? 'hub-chip-ok' : ''), text: r.running ? 'yes' : 'no' }); } },
        { key: 'lastDate', label: 'Last', render: function (r) { return r.lastDate ? relTime(r.lastDate) : '–'; } },
        { key: 'nextDate', label: 'Next', render: function (r) { return r.nextDate ? relTime(r.nextDate) : '–'; } },
        { key: 'name', label: '', render: function (r) {
          var b = el('button', { class: 'hub-btn', text: 'Trigger' });
          b.addEventListener('click', function () { doAction({ body: { confirm: r.name }, keyword: r.name, label: 'Trigger ' + r.name, message: 'Run cron job "' + r.name + '" now?', path: '/actions/cron/' + encodeURIComponent(r.name) + '/trigger', title: 'Trigger cron job' }); });
          return b;
        } },
      ], d.jobs || []));
      if ((d.intervals || []).length || (d.timeouts || []).length) {
        c.appendChild(el('p', { class: 'hub-hint', text: 'Intervals: ' + (d.intervals || []).length + ' · Timeouts: ' + (d.timeouts || []).length }));
      }
    });
  };

  Hub.panels['auth-migration'] = function (content) {
    pollInto(content, 'auth-migration.json', function (c, d) {
      c.appendChild(tiles([
        { label: 'Total users', value: d.totalUsers },
        { label: 'Fully migrated', value: d.fullyMigratedUsers, cls: 'ok' },
        { label: 'Pending', value: d.pendingMigrationUsers, cls: d.pendingMigrationUsers ? 'warn' : '' },
        { label: 'Progress', value: (d.migrationPercentage || 0) + '%' },
        { label: 'Can disable legacy', value: d.canDisableLegacyAuth ? 'yes' : 'no', cls: d.canDisableLegacyAuth ? 'ok' : '' },
      ]));
      if ((d.pendingUserEmails || []).length) {
        c.appendChild(el('h3', { text: 'Pending users' }));
        c.appendChild(table([{ key: 'email', label: 'Email' }], (d.pendingUserEmails || []).map(function (e) { return { email: e }; })));
      }
    });
  };

  Hub.panels.ai = function (content) {
    pollInto(content, 'ai.json', function (c, d) {
      c.appendChild(tiles([{ label: 'Interactions', value: d.totalInteractions }]));
    });
  };

  Hub.panels.emails = function (content) {
    hubFetch('/emails.json').then(function (d) {
      clear(content);
      if (d && d.available === false) { content.appendChild(unavailable(d.hint)); return; }
      var frame = el('iframe', { class: 'hub-json', sandbox: '', style: 'width:100%;height:520px;background:#fff;border-radius:8px' });
      var wrap = el('div', { style: 'display:flex;gap:16px;align-items:flex-start' });
      var list = el('div', { style: 'flex:0 0 240px' });
      (d.templates || []).forEach(function (t) {
        var localeSel = t.locales && t.locales.length ? ' (' + t.locales.join('/') + ')' : '';
        var btn = el('button', { class: 'hub-btn', style: 'display:block;width:100%;text-align:left;margin-bottom:6px', text: t.name + localeSel });
        btn.addEventListener('click', function () {
          var loc = t.locales && t.locales.length ? '&locale=' + encodeURIComponent(t.locales[0]) : '';
          frame.src = BASE + '/emails/preview?template=' + encodeURIComponent(t.name) + loc;
        });
        list.appendChild(btn);
      });
      wrap.appendChild(list); wrap.appendChild(frame);
      content.appendChild(wrap);
    }, function (e) { clear(content); content.appendChild(unavailable('Failed to load: ' + e.message)); });
  };

  Hub.panels.logs = function (content) {
    content.appendChild(clearButton('logs'));
    var host = el('div', { class: 'hub-json', style: 'max-height:70vh' });
    content.appendChild(host);
    var cursor;
    var seen = [];
    poll(function () {
      var q = cursor !== undefined ? '?since=' + cursor : '';
      return hubFetch('/logs.json' + q).then(function (d) {
        if (d && d.available === false) { clear(host); host.appendChild(unavailable(d.hint)); stopPoll(); return; }
        cursor = d.cursor;
        (d.records || []).forEach(function (r) {
          seen.push(r); if (seen.length > 1000) { seen.shift(); }
          var line = el('div', { style: 'padding:1px 0' }, [
            el('span', { class: 'hub-chip hub-chip-' + (r.level === 'error' || r.level === 'fatal' ? 'err' : r.level === 'warn' ? 'warn' : 'ok'), text: r.level }),
            document.createTextNode(' ' + (r.context ? '[' + r.context + '] ' : '') + r.message),
          ]);
          host.appendChild(line);
        });
        if (d.records && d.records.length) { host.scrollTop = host.scrollHeight; }
      });
    }, 2000);
  };

  Hub.panels.traces = function (content) {
    pollInto(content, 'traces.json', function (c, d) {
      c.appendChild(clearButton('traces'));
      var s = d.summary || {};
      c.appendChild(tiles([
        { label: 'Requests', value: s.total }, { label: 'Avg', value: fmtMs(s.avgMs) },
        { label: 'Slow', value: s.slowCount, cls: s.slowCount ? 'warn' : '' }, { label: 'Errors', value: s.errorCount, cls: s.errorCount ? 'err' : '' },
      ]));
      c.appendChild(table([
        { key: 'method', label: 'Method' },
        { key: 'path', label: 'Path', render: function (r) { return r.path + (r.graphqlOperation ? ' (' + r.graphqlOperation + ')' : ''); } },
        { key: 'statusCode', label: 'Status', render: function (r) { return el('span', { class: 'hub-chip hub-chip-' + (r.statusCode >= 500 ? 'err' : r.statusCode >= 400 ? 'warn' : 'ok'), text: String(r.statusCode) }); } },
        { key: 'durationMs', label: 'Duration', render: function (r) { return fmtMs(r.durationMs); }, cls: '' },
        { key: 'userId', label: 'User', render: function (r) { return r.userId || '–'; } },
        { key: 'timestamp', label: 'When', render: function (r) { return relTime(r.timestamp); } },
      ], (d.traces || []).slice().reverse()));
    });
  };

  Hub.panels.queries = function (content) {
    pollInto(content, 'queries.json', function (c, d) {
      c.appendChild(clearButton('queries'));
      var s = d.summary || {};
      c.appendChild(tiles([
        { label: 'Queries', value: s.total }, { label: 'Avg', value: fmtMs(s.avgMs) },
        { label: 'Warn', value: s.warnCount, cls: s.warnCount ? 'warn' : '' }, { label: 'Critical', value: s.criticalCount, cls: s.criticalCount ? 'err' : '' },
        { label: 'Failed', value: s.failedCount, cls: s.failedCount ? 'err' : '' },
      ]));
      c.appendChild(el('h3', { text: 'Top templates (N+1 suspects)' }));
      c.appendChild(table([
        { key: 'count', label: 'Count' }, { key: 'avgMs', label: 'Avg', render: function (r) { return fmtMs(r.avgMs); } },
        { key: 'maxMs', label: 'Max', render: function (r) { return fmtMs(r.maxMs); } }, { key: 'template', label: 'Shape' },
      ], d.topTemplates || []));
      c.appendChild(el('h3', { text: 'Slowest' }));
      c.appendChild(table([
        { key: 'collection', label: 'Collection' }, { key: 'operation', label: 'Op' },
        { key: 'durationMs', label: 'Duration', render: function (r) { return el('span', { class: 'hub-chip hub-chip-' + (r.classification === 'critical' ? 'err' : r.classification === 'warn' ? 'warn' : 'ok'), text: fmtMs(r.durationMs) }); } },
        { key: 'commandSummary', label: 'Shape' },
      ], d.slowest || []));
    });
  };

  Hub.panels.mailbox = function (content) {
    pollInto(content, 'mailbox.json', function (c, d) {
      c.appendChild(el('p', { class: 'hub-hint', text: 'Mode: ' + d.mode + (d.mode === 'capture' ? ' (mail is intercepted, not sent)' : ' (mail is sent and recorded)') }));
      var frame = el('iframe', { class: 'hub-json', sandbox: '', style: 'width:100%;height:420px;background:#fff;border-radius:8px;margin-top:10px' });
      var cols = [
        { key: 'to', label: 'To' },
        { key: 'subject', label: 'Subject' },
        { key: 'templateName', label: 'Template', render: function (r) { return r.templateName || '–'; } },
        { key: 'timestamp', label: 'When', render: function (r) { return relTime(r.timestamp); } },
        { key: 'seq', label: '', render: function (r) { var b = el('button', { class: 'hub-btn', text: 'View' }); b.addEventListener('click', function () { frame.src = BASE + '/mailbox/' + r.seq + '/html'; }); return r.hasHtml || r.hasText ? b : el('span', { text: '' }); } },
      ];
      c.appendChild(table(cols, (d.mails || []).slice().reverse()));
      c.appendChild(frame);
    });
  };

  // ---- boot --------------------------------------------------------------
  // Fetch the ADMIN-gated session payload FIRST. The app stays hidden (body.hub-locked, set
  // server-side) and #hub-app empty until it succeeds — so nothing of the cockpit (not even the nav)
  // is ever visible to an unauthenticated visitor; they only see the full-screen login gate. The nav
  // click handler is wired inside buildLayout() once the nav actually exists.
  function boot() {
    window.addEventListener('popstate', function () { if (!document.body.classList.contains('hub-locked')) { render(current()); } });
    fetchSession();
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
`;
}
