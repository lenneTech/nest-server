import { Inject, Injectable } from '@nestjs/common';

import { HUB_CONFIG } from './hub.constants';

/**
 * Per-process cache-bust token for the client bundle (`hub.js?v=<token>`). It changes on every server
 * start, so the browser refetches the script after a restart/redeploy (a dev code change is never
 * masked by the immutable cache), while a single boot keeps the long-lived cache. The app version is
 * deliberately NOT part of this public URL — it would leak the version to unauthenticated requests
 * (the version is shown only in the ADMIN-gated, client-built topbar from session.json).
 */
const HUB_ASSET_TOKEN = Date.now().toString(36);
import { getHubClientJs } from './helpers/hub-client-js.helper';
import { escapeHtml, escapeJsString, HUB_NONCE_PLACEHOLDER } from './helpers/hub-shell.helper';
import { ResolvedHubConfig } from './interfaces/hub-config.interface';

/**
 * Builds the Hub's single, self-contained HTML shell. Every page route serves the same shell (the
 * client router picks the active panel from the URL), so this is stateless apart from the injected
 * config. All server-provided values are escaped; the auth token (when present) is embedded as a JS
 * string so sidecar fetches carry it in cookie-less setups.
 *
 * Overridable: a project may replace it via `overrides.hub.htmlService` to re-skin the cockpit.
 */
@Injectable()
export class CoreHubHtmlService {
  constructor(@Inject(HUB_CONFIG) protected readonly config: ResolvedHubConfig) {}

  /** The shared client runtime script — served verbatim from `GET /{hub}/hub.js`. */
  buildClientScript(): string {
    return getHubClientJs();
  }

  /**
   * Build the full shell HTML with `__CSP_NONCE__` placeholders. The controller replaces the
   * placeholders per request via `injectNonce()`.
   *
   * @param authHeader - the incoming `Authorization` header, embedded so client fetches can replay it
   */
  buildShell(authHeader?: string): string {
    const base = '/' + this.config.path;

    const bootstrap = [
      `window.__HUB_BASE__='${escapeJsString(base)}';`,
      `window.__HUB_POLL_MS__=${Number(this.config.pollIntervalMs) || 5000};`,
      `window.__HUB_LOGIN__='${escapeJsString(this.config.loginEndpoint)}';`,
      authHeader ? `window.__HUB_TOKEN__='${escapeJsString(authHeader)}';` : '',
    ].join('');

    // SECURITY (self-sufficient login): the shell is PUBLIC because it must render the login form
    // before authentication. It therefore carries NO cockpit chrome — no navigation, no environment
    // badge, no version, no external links. The client builds all of that ONLY after a successful
    // ADMIN auth check, from the ADMIN-gated `session.json` payload. So an unauthenticated request to
    // any /hub page reveals nothing of the Hub's structure; #hub-app stays empty until login.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hub · nest-server</title>
  <style nonce="${HUB_NONCE_PLACEHOLDER}">${this.css()}</style>
</head>
<body class="hub-locked">
  <div id="hub-gate" class="hub-gate"></div>
  <div id="hub-app"></div>
  <dialog id="hub-confirm" class="hub-dialog"></dialog>
  <script nonce="${HUB_NONCE_PLACEHOLDER}">${bootstrap}</script>
  <script nonce="${HUB_NONCE_PLACEHOLDER}" src="${escapeHtml(base)}/hub.js?v=${HUB_ASSET_TOKEN}"></script>
</body>
</html>`;
  }

  protected css(): string {
    return `
:root{--bg:#0b0d12;--panel:#141821;--panel2:#1b212d;--border:#242c3a;--text:#e6ebf2;--muted:#8b97a8;--accent:#4f8cff;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.hub-layout{display:flex;min-height:100vh}
.hub-nav{width:230px;flex:0 0 230px;background:var(--panel);border-right:1px solid var(--border);padding:16px 10px;overflow-y:auto}
.hub-brand{font-weight:700;font-size:18px;padding:4px 10px 14px;display:flex;align-items:center;gap:8px}
.hub-env{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;border-radius:4px;background:var(--panel2);color:var(--muted)}
.hub-env-production{background:#3d1418;color:#ff7b72}
.hub-nav h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 10px 4px}
.hub-nav a{display:block;padding:6px 10px;border-radius:6px;color:var(--text);text-decoration:none;font-size:13px}
.hub-nav a:hover{background:var(--panel2)}
.hub-nav a.active{background:var(--accent);color:#fff}
.hub-nav a.hub-nav-disabled{opacity:.38;cursor:not-allowed}
.hub-nav a.hub-nav-disabled:hover{background:none}
.hub-nav a.hub-ext::after{content:' ↗';color:var(--muted)}
.hub-main{flex:1;min-width:0;display:flex;flex-direction:column}
.hub-topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid var(--border)}
.hub-topbar h1{font-size:18px;margin:0}
.hub-meta{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:8px}
.hub-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--muted)}
.hub-dot-ok{background:var(--ok)}.hub-dot-err{background:var(--err)}
.hub-content{padding:22px;overflow:auto}
.hub-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.hub-tile{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px}
.hub-tile-label{color:var(--muted);font-size:12px}
.hub-tile-value{font-size:22px;font-weight:600;margin-top:4px}
.hub-tile-value.ok{color:var(--ok)}.hub-tile-value.warn{color:var(--warn)}.hub-tile-value.err{color:var(--err)}
.hub-tile-sub{color:var(--muted);font-size:11px;margin-top:4px}
.hub-table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.hub-table th{text-align:left;padding:8px 12px;background:var(--panel2);color:var(--muted);font-size:12px;font-weight:600;cursor:pointer}
.hub-table td{padding:8px 12px;border-top:1px solid var(--border);font-size:13px}
.hub-table tr:hover td{background:var(--panel2)}
.hub-json{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;max-width:100%}
.hub-empty{color:var(--muted);padding:40px;text-align:center;border:1px dashed var(--border);border-radius:8px}
.hub-btn{background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer}
.hub-btn:hover{border-color:var(--accent)}
.hub-btn:disabled{opacity:.5;cursor:not-allowed}
.hub-btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
.hub-btn-danger{background:var(--err);border-color:var(--err);color:#fff}
.hub-signout{padding:4px 10px;font-size:12px;margin-left:4px}
.hub-input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;color:var(--text);margin:8px 0;font-size:13px}
.hub-dialog{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:440px;width:90%}
.hub-dialog::backdrop{background:rgba(0,0,0,.6)}
.hub-dialog h3{margin:0 0 8px}
.hub-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.hub-hint{color:var(--muted);font-size:12px}
.hub-chip{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:var(--panel2);color:var(--muted)}
.hub-chip-ok{background:#132d1c;color:var(--ok)}.hub-chip-warn{background:#2d2611;color:var(--warn)}.hub-chip-err{background:#3d1418;color:var(--err)}
.hub-toast{position:fixed;bottom:20px;right:20px;background:var(--panel2);border:1px solid var(--accent);color:var(--text);padding:12px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,.4)}
.hub-toast-err{border-color:var(--err)}
/* Auth gate: nothing of the app is visible until authenticated. The client builds the layout into
   #hub-app only after a successful auth check, so body.hub-locked just hides the (empty) app root. */
.hub-gate{display:none;position:fixed;inset:0;background:var(--bg);z-index:100;align-items:center;justify-content:center;padding:20px}
.hub-locked .hub-gate{display:flex}
.hub-locked #hub-app{display:none}
.hub-gate-card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:28px;width:360px;max-width:100%}
.hub-gate-card h2{margin:0 0 4px}
.hub-gate-brand{font-weight:700;font-size:20px;margin-bottom:18px;display:flex;align-items:center;gap:8px}
`;
  }
}
