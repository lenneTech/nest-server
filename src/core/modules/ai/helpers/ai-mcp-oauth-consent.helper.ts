/**
 * The built-in MCP OAuth consent page: one build-free HTML document with two views.
 *
 * - **consent** (a user is signed in): which client asks, where the code goes, Allow / Deny. A plain
 *   form POST to `/authorize` — works without JavaScript.
 * - **sign-in** (nobody is signed in): e-mail + password and the two-factor step, against
 *   Better-Auth's own endpoints on the same origin, then a reload of the very same `/authorize`
 *   request. Other methods (passkey, social login) through the app's login page.
 *
 * Everything that reaches the page from outside is escaped: the client's name comes from dynamic
 * registration, i.e. from whoever registered the client. Nothing here decides whether a code is
 * issued — that is `CoreAiMcpOAuthService` (CSRF token, user, client, PKCE challenge).
 */

/** What the page shows. Built by `CoreAiMcpOAuthService`, rendered by {@link renderMcpOAuthConsentPage}. */
export interface IMcpOAuthConsentView {
  /** Host the user knows the application by (the app's host, else the API's) */
  appHost: string;
  /** Better-Auth base path for the sign-in form; absent when Better-Auth is not active */
  authBasePath?: string;
  client: { id: string; name?: string };
  /** CSRF token of the consent form (consent view only) */
  csrfToken?: string;
  /** Why the consent form is shown again */
  notice?: 'expired';
  locale: McpOAuthConsentLocale;
  /** The app's login page, for passkey / social login; `returnsHere` when it sends the user back by itself */
  loginUrl?: { href: string; returnsHere: boolean };
  /** CSP nonce of this response */
  nonce: string;
  /** The OAuth parameters the consent form re-submits to `/authorize` */
  oauthParams: Record<string, string>;
  redirect: { host: string; loopback: boolean };
  /** The signed-in user; absent → sign-in view */
  user?: { email?: string; name?: string };
}

export type McpOAuthConsentLocale = 'de' | 'en';

/** Form field carrying the decision (`approve` / `deny`). */
export const MCP_OAUTH_CONSENT_DECISION_FIELD = 'lt_mcp_consent';
/** Form field carrying the CSRF token. */
export const MCP_OAUTH_CONSENT_TOKEN_FIELD = 'lt_mcp_csrf';

const TEXTS = {
  de: {
    allow: 'Zulassen',
    approveNoscript: 'Zum Bestätigen wird JavaScript benötigt.',
    backupCode: 'Backup-Code verwenden',
    code: 'Bestätigungscode',
    codeFailed: 'Der Code ist ungültig.',
    codeHint: 'Gib den Code aus deiner Authenticator-App ein.',
    confirm: 'Bestätigen',
    continue: 'Ich habe mich angemeldet – weiter',
    deny: 'Ablehnen',
    email: 'E-Mail',
    expired: 'Die Seite war zu lange geöffnet. Bitte bestätige noch einmal.',
    intro: '{client} möchte über MCP in deinem Namen auf {app} zugreifen – mit deinen Rechten.',
    loopback: 'eine Anwendung auf diesem Computer',
    noscript: 'Für die Anmeldung wird JavaScript benötigt.',
    noSignIn: 'Auf diesem Server ist keine Anmeldung für MCP-Clients eingerichtet.',
    otherMethod: 'Mit Passkey oder einem anderen Verfahren anmelden',
    password: 'Passwort',
    signedInAs: 'Angemeldet als {user}',
    switchAccount: 'Anderes Konto',
    signIn: 'Anmelden',
    signInFailed: 'Anmeldung fehlgeschlagen. Bitte prüfe E-Mail und Passwort.',
    signInIntro: 'Melde dich bei {app} an, um {client} den Zugriff zu erlauben.',
    target: 'Die Freigabe geht an:',
    title: 'Zugriff erlauben',
    unnamedClient: 'Eine unbenannte Anwendung',
    warning: 'Erlaube den Zugriff nur, wenn du die Verbindung gerade selbst gestartet hast.',
  },
  en: {
    allow: 'Allow',
    approveNoscript: 'Confirming requires JavaScript.',
    backupCode: 'Use a backup code',
    code: 'Verification code',
    codeFailed: 'The code is invalid.',
    codeHint: 'Enter the code from your authenticator app.',
    confirm: 'Confirm',
    continue: 'I have signed in – continue',
    deny: 'Deny',
    email: 'Email',
    expired: 'This page was open for too long. Please confirm again.',
    intro: '{client} wants to access {app} on your behalf through MCP – with your permissions.',
    loopback: 'an application on this computer',
    noscript: 'Signing in requires JavaScript.',
    noSignIn: 'Sign-in for MCP clients is not set up on this server.',
    otherMethod: 'Sign in with a passkey or another method',
    password: 'Password',
    signedInAs: 'Signed in as {user}',
    switchAccount: 'Use another account',
    signIn: 'Sign in',
    signInFailed: 'Sign-in failed. Please check your email and password.',
    signInIntro: 'Sign in to {app} to allow {client} access.',
    target: 'Access is granted to:',
    title: 'Allow access',
    unnamedClient: 'An unnamed application',
    warning: 'Only allow access if you just started this connection yourself.',
  },
} satisfies Record<McpOAuthConsentLocale, Record<string, string>>;

/** The locale for an `Accept-Language` header: German when the first preference is German, else English. */
export function mcpOAuthConsentLocale(acceptLanguage: unknown): McpOAuthConsentLocale {
  const first = typeof acceptLanguage === 'string' ? acceptLanguage.split(',')[0].trim().toLowerCase() : '';
  return first.startsWith('de') ? 'de' : 'en';
}

/**
 * Security headers of the page. `frame-ancestors 'none'` + `X-Frame-Options` stop clickjacking of the
 * Allow button. No `form-action`: browsers apply it to the redirect after the POST, and that
 * redirect goes to the client's callback on another origin.
 */
export function mcpOAuthConsentHeaders(nonce: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
      "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

/** Every text of the page in one locale. */
export type McpOAuthConsentTexts = (typeof TEXTS)[McpOAuthConsentLocale];

/**
 * Project adjustments for {@link renderMcpOAuthConsentPage}: replacement texts per locale (merged over
 * the built-in ones, so a project changes only what it needs, e.g. its form of address) and CSS
 * appended after the built-in styles (its colours and font). Neither touches the markup, the scripts or
 * the security headers — what makes the page safe stays the framework's.
 */
export interface IMcpOAuthConsentPageOptions {
  styles?: string;
  texts?: Partial<Record<McpOAuthConsentLocale, Partial<McpOAuthConsentTexts>>>;
}

/** Renders the page. Every dynamic value goes through {@link escapeHtml}. */
export function renderMcpOAuthConsentPage(
  view: IMcpOAuthConsentView,
  options: IMcpOAuthConsentPageOptions = {},
): string {
  const t: Texts = { ...TEXTS[view.locale], ...options.texts?.[view.locale] };
  const clientName = view.client.name?.trim() || t.unnamedClient;
  // One pass: a client name is chosen by whoever registered the client, so a name containing
  // `{app}` must not be expanded by a second replace.
  const fill = (text: string) =>
    escapeHtml(text).replace(
      /\{(client|app)\}/g,
      (_, key: string) => `<strong>${escapeHtml(key === 'client' ? clientName : view.appHost)}</strong>`,
    );

  const body = view.user ? consentView(view, t, fill) : signInView(view, t, fill);
  return `<!doctype html>
<html lang="${view.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${escapeHtml(t.title)} – ${escapeHtml(view.appHost)}</title>
<style nonce="${escapeHtml(view.nonce)}">${STYLES}${options.styles ?? ''}</style>
</head>
<body>
<main class="card">
${body}
</main>
${pageScript(view)}
</body>
</html>
`;
}

type Texts = McpOAuthConsentTexts;

function consentView(view: IMcpOAuthConsentView, t: Texts, fill: (text: string) => string): string {
  const target = view.redirect.loopback
    ? `${escapeHtml(t.loopback)} (${escapeHtml(view.redirect.host)})`
    : escapeHtml(view.redirect.host);
  const who = view.user?.email || view.user?.name;
  const hidden = Object.entries(view.oauthParams)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  // The account comes first and is not muted: a session planted by login CSRF must be noticed
  // before Allow, not after.
  const account = who
    ? `<p class="account">${escapeHtml(t.signedInAs).replace('{user}', () => `<strong>${escapeHtml(who)}</strong>`)}${
        view.authBasePath
          ? `<a href="" id="lt-mcp-switch" class="switch" data-sign-out="${escapeHtml(`${view.authBasePath}/sign-out`)}">${escapeHtml(t.switchAccount)}</a>`
          : ''
      }</p>`
    : '';
  // Allow starts disabled: only the guard script enables it, so a page without the script can never
  // be clicked into an approval (see MCP_OAUTH_CONSENT_GUARD_SCRIPT).
  return `<h1>${escapeHtml(t.title)}</h1>
${account}
${view.notice === 'expired' ? `<p class="notice" role="alert">${escapeHtml(t.expired)}</p>` : ''}
<p>${fill(t.intro)}</p>
<p class="target">${escapeHtml(t.target)} <strong>${target}</strong></p>
<p class="warning">${escapeHtml(t.warning)}</p>
<noscript><p class="notice">${escapeHtml(t.approveNoscript)}</p></noscript>
<form method="post" action="authorize" class="actions">
${hidden}
<input type="hidden" name="${MCP_OAUTH_CONSENT_TOKEN_FIELD}" value="${escapeHtml(view.csrfToken ?? '')}">
<button type="submit" name="${MCP_OAUTH_CONSENT_DECISION_FIELD}" value="deny" class="secondary">${escapeHtml(t.deny)}</button>
<button type="submit" name="${MCP_OAUTH_CONSENT_DECISION_FIELD}" value="approve" class="primary" id="lt-mcp-allow" disabled>${escapeHtml(t.allow)}</button>
</form>`;
}

/** The script of the view: the consent guard, or the sign-in script; nothing when there is no sign-in. */
function pageScript(view: IMcpOAuthConsentView): string {
  const script = view.user ? MCP_OAUTH_CONSENT_GUARD_SCRIPT : view.authBasePath ? MCP_OAUTH_CONSENT_SCRIPT : '';
  return script ? `<script nonce="${escapeHtml(view.nonce)}">${script}</script>` : '';
}

function signInView(view: IMcpOAuthConsentView, t: Texts, fill: (text: string) => string): string {
  const other = view.loginUrl
    ? `<div class="other">
<a href="${escapeHtml(view.loginUrl.href)}"${view.loginUrl.returnsHere ? '' : ' target="_blank" rel="noopener noreferrer"'}>${escapeHtml(t.otherMethod)}</a>
${view.loginUrl.returnsHere ? '' : `<a href="" class="continue">${escapeHtml(t.continue)}</a>`}
</div>`
    : '';
  if (!view.authBasePath) {
    return `<h1>${escapeHtml(t.signIn)}</h1>
<p>${escapeHtml(t.noSignIn)}</p>
${other}`;
  }
  return `<h1>${escapeHtml(t.signIn)}</h1>
<p>${fill(t.signInIntro)}</p>
<noscript><p class="notice">${escapeHtml(t.noscript)}</p></noscript>
<div id="lt-mcp-signin" data-auth-base="${escapeHtml(view.authBasePath)}" data-sign-in-failed="${escapeHtml(t.signInFailed)}" data-code-failed="${escapeHtml(t.codeFailed)}">
<form id="lt-mcp-password" method="post" hidden>
<label>${escapeHtml(t.email)}<input name="email" type="email" autocomplete="username" required></label>
<label>${escapeHtml(t.password)}<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit" class="primary">${escapeHtml(t.signIn)}</button>
</form>
<form id="lt-mcp-second-factor" method="post" hidden>
<p class="muted">${escapeHtml(t.codeHint)}</p>
<label>${escapeHtml(t.code)}<input name="code" autocomplete="one-time-code" inputmode="numeric" required></label>
<label class="inline"><input name="backup" type="checkbox"> ${escapeHtml(t.backupCode)}</label>
<button type="submit" class="primary">${escapeHtml(t.confirm)}</button>
</form>
<p id="lt-mcp-error" class="notice" role="alert" hidden></p>
</div>
${other}`;
}

/**
 * Client script of the consent view: arms Allow, and offers "use another account".
 *
 * Allow is rendered `disabled`; this script enables it, but a click counts only when the user has
 * shown intent on THIS page: it is visible and focused, and at least 600 ms after it got there a
 * pointer moved, a key was pressed or a touch began. That defeats double-clickjacking — a hostile
 * page opens a popup, sends this window to `/authorize` behind it and lets the second click of a
 * "double-click" land on Allow: that click arrives within milliseconds of the window regaining
 * focus, and with the mouse resting where it was. Blur and hiding reset it. A click that does not
 * count is simply not submitted; the user clicks again.
 */
export const MCP_OAUTH_CONSENT_GUARD_SCRIPT = `(function () {
  var allow = document.getElementById('lt-mcp-allow');
  if (allow) {
    var since = 0;
    var armed = false;
    var reset = function () { since = 0; armed = false; };
    var watch = function () {
      if (document.visibilityState === 'visible' && document.hasFocus()) { if (!since) { since = Date.now(); } } else { reset(); }
    };
    var intent = function (event) {
      watch();
      var stationaryClick = event.type === 'pointerdown' && event.pointerType === 'mouse';
      if (since && !stationaryClick && Date.now() - since >= 600) { armed = true; }
    };
    window.addEventListener('blur', reset);
    window.addEventListener('focus', watch);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { watch(); } else { reset(); } });
    document.addEventListener('pointermove', intent);
    document.addEventListener('pointerdown', intent);
    document.addEventListener('keydown', intent);
    allow.addEventListener('click', function (event) { if (!armed) { event.preventDefault(); } });
    allow.disabled = false;
    watch();
  }
  var other = document.getElementById('lt-mcp-switch');
  if (other) {
    other.addEventListener('click', function (event) {
      event.preventDefault();
      var done = function () { location.reload(); };
      fetch(other.getAttribute('data-sign-out'), { body: '{}', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, method: 'POST' }).then(done, done);
    });
  }
})();`;

/**
 * Client script of the sign-in view. Plain ES5, no dependencies, no build: it signs in through
 * Better-Auth's endpoints on this origin — the same ones the app's login uses — and reloads, so the
 * unchanged `/authorize` request is answered again, now with a session. It never touches the consent
 * decision.
 */
export const MCP_OAUTH_CONSENT_SCRIPT = `(function () {
  var root = document.getElementById('lt-mcp-signin');
  if (!root) { return; }
  var base = root.getAttribute('data-auth-base');
  var passwordForm = document.getElementById('lt-mcp-password');
  var factorForm = document.getElementById('lt-mcp-second-factor');
  var error = document.getElementById('lt-mcp-error');
  // Both forms are rendered hidden and with method="post": without this script nothing can be
  // submitted, and nothing would ever put the password into a URL.
  passwordForm.hidden = false;
  function fail(message) { error.textContent = message; error.hidden = false; }
  function post(path, body) {
    return fetch(base + path, {
      body: JSON.stringify(body),
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    }).then(function (response) {
      return response.json().then(function (json) { return json; }, function () { return {}; }).then(function (json) {
        return { body: json || {}, ok: response.ok };
      });
    });
  }
  passwordForm.addEventListener('submit', function (event) {
    event.preventDefault();
    error.hidden = true;
    post('/sign-in/email', { email: passwordForm.elements.email.value, password: passwordForm.elements.password.value })
      .then(function (result) {
        if (result.body.requiresTwoFactor || result.body.twoFactorRedirect) {
          passwordForm.hidden = true;
          factorForm.hidden = false;
          return;
        }
        if (!result.ok) { fail(root.getAttribute('data-sign-in-failed')); return; }
        location.reload();
      }, function () { fail(root.getAttribute('data-sign-in-failed')); });
  });
  factorForm.addEventListener('submit', function (event) {
    event.preventDefault();
    error.hidden = true;
    var path = factorForm.elements.backup.checked ? '/two-factor/verify-backup-code' : '/two-factor/verify-totp';
    post(path, { code: factorForm.elements.code.value })
      .then(function (result) {
        if (!result.ok) { fail(root.getAttribute('data-code-failed')); return; }
        location.reload();
      }, function () { fail(root.getAttribute('data-code-failed')); });
  });
})();`;

/** Escape the five HTML-significant characters. */
function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--text:#1d2129;--muted:#5b6270;--border:#d9dde3;--primary:#1f6feb;--primary-text:#fff;--notice:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e6e8eb;--muted:#9aa1ad;--border:#2c313a;--primary:#4c8dff;--notice:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 16px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.account{padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px}
.account .switch{display:block;margin-top:4px}
button:disabled{opacity:.6;cursor:default}
.target strong{overflow-wrap:anywhere}
.warning{color:var(--muted);font-size:13px;border-left:3px solid var(--border);padding-left:10px}
.notice{color:var(--notice)}
label{display:block;margin:0 0 12px;font-size:13px;color:var(--muted)}
label.inline{display:flex;gap:8px;align-items:center}
input:not([type=checkbox]){display:block;width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text);font:inherit}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
button{padding:9px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font:inherit;cursor:pointer}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-text)}
form#lt-mcp-password button,form#lt-mcp-second-factor button{width:100%}
.other{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;font-size:13px}
a{color:var(--primary)}
`;
