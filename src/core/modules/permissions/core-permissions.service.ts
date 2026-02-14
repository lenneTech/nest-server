import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import * as fs from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

import type { ModulePermissions, PermissionsReport } from './interfaces/permissions.interface';
import { findProjectRoot, generateMarkdownReport, scanPermissions } from './permissions-scanner';

@Injectable()
export class CorePermissionsService implements OnModuleDestroy {
  private htmlCache: string | null = null;
  private lastScanTime = 0;
  private readonly logger = new Logger(CorePermissionsService.name);
  private markdownCache: string | null = null;
  private readonly basePath: string;
  private report: PermissionsReport | null = null;
  private scanPromise: Promise<PermissionsReport> | null = null;
  private watcher: fs.FSWatcher | null = null;

  /** Minimum interval between scans in milliseconds (prevents abuse of the expensive ts-morph parse) */
  private readonly SCAN_COOLDOWN_MS = 10_000;

  constructor(@Optional() @Inject('PERMISSIONS_PATH') basePath?: string) {
    this.basePath = basePath || 'permissions';
    // File watcher invalidates the cached report whenever a .ts file in src/server/ changes,
    // so the next request triggers a fresh scan automatically.
    this.setupWatcher();
  }

  generateHtml(authToken?: string): string {
    if (!this.htmlCache) {
      if (!this.report) return `<p>No report available. Access /${this.basePath} to trigger scan.</p>`;
      this.htmlCache = this.buildHtml(this.report);
    }
    if (authToken) {
      const escaped = authToken.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
      return this.htmlCache.replace('</body>', `<script>var AUTH_TOKEN='${escaped}';</script></body>`);
    }
    return this.htmlCache;
  }

  generateMarkdown(): string {
    if (this.markdownCache) return this.markdownCache;
    if (!this.report) return `# Permissions Report\n\nNo report available. Access /${this.basePath} to trigger scan.`;
    this.markdownCache = generateMarkdownReport(this.report);
    return this.markdownCache;
  }

  getReport(): PermissionsReport | null {
    return this.report;
  }

  async getOrScan(): Promise<PermissionsReport> {
    if (this.report) return this.report;
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scan();
    return this.scanPromise;
  }

  onModuleDestroy() {
    this.watcher?.close();
  }

  async scan(): Promise<PermissionsReport> {
    // Rate limiting: prevent expensive ts-morph scans from being triggered too frequently
    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_COOLDOWN_MS) {
      if (this.report) return this.report;
    }

    try {
      this.lastScanTime = now;
      const projectRoot = findProjectRoot();
      if (!projectRoot) {
        throw new Error('Could not find project root (src/server/modules/ not found)');
      }

      // Delegate to the standalone scanner (single source of truth for scan logic)
      this.report = scanPermissions(projectRoot, {
        log: (msg) => this.logger.log(msg),
        warn: (msg) => this.logger.warn(msg),
      });

      this.htmlCache = null;
      this.markdownCache = null;
      return this.report;
    } catch (error) {
      this.logger.error('Permissions scan failed', error);
      throw error;
    } finally {
      this.scanPromise = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: HTML helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Collect all unique role names from a module's models, controllers, and resolvers */
  private collectModuleRoles(mod: ModulePermissions): string[] {
    const roles = new Set<string>();
    for (const model of mod.models) {
      for (const r of model.classRestriction) roles.add(r);
      for (const f of model.fields) {
        const matches = f.roles.match(/`([^`]+)`/g);
        if (matches) matches.forEach((m) => roles.add(m.replace(/`/g, '')));
      }
    }
    for (const ctrl of mod.controllers) {
      for (const r of ctrl.classRoles) roles.add(r);
      for (const m of ctrl.methods) {
        for (const r of m.roles) roles.add(r);
      }
    }
    for (const res of mod.resolvers) {
      for (const r of res.classRoles) roles.add(r);
      for (const m of res.methods) {
        for (const r of m.roles) roles.add(r);
      }
    }
    return [...roles].sort();
  }

  private badge(role: string): string {
    return `<span class="badge ${this.getBadgeClass(role)}">${this.escapeHtml(role)}</span>`;
  }

  private badgeList(roles: string[]): string {
    return roles.length > 0 ? roles.map((r) => this.badge(r)).join(' ') : '<em>(none)</em>';
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private getBadgeClass(role: string): string {
    if (!role) return 'badge-custom';
    const r = role.toUpperCase();
    if (r === 'S_EVERYONE') return 'badge-everyone';
    if (r === 'S_NO_ONE') return 'badge-noone';
    if (r === 'ADMIN') return 'badge-admin';
    if (r === 'S_USER') return 'badge-user';
    if (r === 'S_SELF') return 'badge-self';
    if (r === 'S_CREATOR') return 'badge-creator';
    return 'badge-custom';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: HTML section builders
  // ─────────────────────────────────────────────────────────────────────────

  private buildClientJs(data: string): string {
    const basePath = JSON.stringify('/' + this.basePath);
    return `<script>
var DATA = ${data};
var BASE_PATH = ${basePath};

(function() {
  var sel = document.getElementById('roleFilter');
  var roles = {};

  // Collect roles from roleEnums
  DATA.roleEnums.forEach(function(e) { e.values.forEach(function(v) { roles[v.key] = true; }); });

  // Collect roles from actual scan data
  DATA.modules.forEach(function(mod) {
    mod.models.forEach(function(model) {
      model.classRestriction.forEach(function(r) { roles[r] = true; });
      model.fields.forEach(function(f) {
        var m = f.roles.match(/\x60([^\x60]+)\x60/g);
        if (m) m.forEach(function(r) { roles[r.replace(/\x60/g, '')] = true; });
      });
    });
    mod.controllers.forEach(function(ep) {
      ep.classRoles.forEach(function(r) { roles[r] = true; });
      ep.methods.forEach(function(m) { m.roles.forEach(function(r) { roles[r] = true; }); });
    });
    mod.resolvers.forEach(function(ep) {
      ep.classRoles.forEach(function(r) { roles[r] = true; });
      ep.methods.forEach(function(m) { m.roles.forEach(function(r) { roles[r] = true; }); });
    });
  });

  Object.keys(roles).sort().forEach(function(r) {
    var o = document.createElement('option');
    o.value = r; o.textContent = r;
    sel.appendChild(o);
  });
})();

function toggle(el) {
  el.classList.toggle('open');
  var content = el.nextElementSibling;
  if (content) content.classList.toggle('open');
}

function filterAll() {
  var q = document.getElementById('search').value.toLowerCase();
  var role = document.getElementById('roleFilter').value;
  var warnOnly = document.getElementById('warnOnly').checked;

  // Filter module sections
  document.querySelectorAll('.module-section').forEach(function(section) {
    var text = section.textContent.toLowerCase();
    var hasWarnings = section.dataset.hasWarnings === 'true';
    var sectionRoles = (section.dataset.roles || '').split(',');
    var show = true;
    if (q && !text.includes(q)) show = false;
    if (warnOnly && !hasWarnings) show = false;
    if (role && sectionRoles.indexOf(role) === -1) show = false;
    section.style.display = show ? '' : 'none';
  });

  // Filter warnings table rows
  var warningsSection = document.getElementById('warnings');
  if (warningsSection) {
    var rows = warningsSection.querySelectorAll('tbody tr');
    rows.forEach(function(row) {
      var text = row.textContent.toLowerCase();
      var show = true;
      if (q && !text.includes(q)) show = false;
      row.style.display = show ? '' : 'none';
    });
  }

  // Filter subobjects section
  var subObjSection = document.getElementById('subobjects');
  if (subObjSection) {
    subObjSection.querySelectorAll('div > h3').forEach(function(h3) {
      var container = h3.parentElement;
      if (!container) return;
      var text = container.textContent.toLowerCase();
      var show = true;
      if (q && !text.includes(q)) show = false;
      container.style.display = show ? '' : 'none';
    });
  }
}

document.querySelectorAll('th').forEach(function(th) {
  th.addEventListener('click', function() {
    var table = this.closest('table');
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    var idx = Array.from(this.parentNode.children).indexOf(this);
    var rows = Array.from(tbody.querySelectorAll('tr'));
    var asc = this.dataset.sort !== 'asc';
    rows.sort(function(a, b) {
      var at = (a.children[idx] || {}).textContent || '';
      var bt = (b.children[idx] || {}).textContent || '';
      return asc ? at.localeCompare(bt) : bt.localeCompare(at);
    });
    this.dataset.sort = asc ? 'asc' : 'desc';
    rows.forEach(function(r) { tbody.appendChild(r); });
  });
});

function exportAs(fmt) {
  var blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'permissions.' + fmt;
  a.click();
}

function exportMarkdown() {
  var opts = { credentials: 'same-origin' };
  if (typeof AUTH_TOKEN !== 'undefined' && AUTH_TOKEN) {
    opts.headers = { 'Authorization': AUTH_TOKEN };
  }
  fetch(BASE_PATH + '/markdown', opts)
    .then(function(res) { return res.text(); })
    .then(function(text) {
      var blob = new Blob([text], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'permissions.md';
      a.click();
    });
}

function rescan(e) {
  var btn = e ? e.target : this;
  btn.disabled = true;
  btn.textContent = 'Scanning...';
  var opts = { method: 'POST', credentials: 'same-origin' };
  if (typeof AUTH_TOKEN !== 'undefined' && AUTH_TOKEN) {
    opts.headers = { 'Authorization': AUTH_TOKEN };
  }
  fetch(BASE_PATH + '/rescan', opts)
    .then(function(res) { if (!res.ok) throw new Error(res.status); window.location.reload(); })
    .catch(function(err) { alert('Rescan failed: ' + err); btn.disabled = false; btn.textContent = 'Rescan'; });
}
</script>`;
  }

  private buildCss(): string {
    return `<style>
:root {
  --bg: #ffffff; --fg: #1a1a2e; --bg-card: #f8f9fa; --border: #dee2e6;
  --primary: #0d6efd; --success: #198754; --warning: #ffc107; --danger: #dc3545;
  --role-everyone: #198754; --role-noone: #dc3545; --role-admin: #0d6efd;
  --role-user: #e6a817; --role-self: #6c757d; --role-custom: #fd7e14;
  --shadow: 0 1px 3px rgba(0,0,0,0.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a2e; --fg: #e0e0e0; --bg-card: #16213e; --border: #3a3a5c;
    --shadow: 0 1px 3px rgba(0,0,0,0.4);
  }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
.layout { display: flex; min-height: 100vh; }
.sidebar { width: 260px; position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--bg-card); border-right: 1px solid var(--border); padding: 1rem; flex-shrink: 0; }
.sidebar h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--primary); margin-bottom: 0.5rem; }
.sidebar a { display: block; padding: 0.25rem 0.5rem; color: var(--fg); text-decoration: none; font-size: 0.85rem; border-radius: 4px; }
.sidebar a:hover { background: var(--border); }
.sidebar a.indent { padding-left: 1.5rem; font-size: 0.8rem; opacity: 0.8; }
.main { flex: 1; padding: 2rem; max-width: 1200px; }
.dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
.stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; text-align: center; box-shadow: var(--shadow); }
.stat .num { font-size: 2rem; font-weight: 700; color: var(--primary); }
.stat .label { font-size: 0.8rem; opacity: 0.7; }
.stat.warn .num { color: var(--warning); }
.stat.danger .num { color: var(--danger); }
.controls { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; align-items: center; }
.controls input, .controls select { padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font-size: 0.9rem; }
.controls input { flex: 1; min-width: 200px; }
.controls label { font-size: 0.85rem; display: flex; align-items: center; gap: 0.3rem; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; color: #fff; }
.badge-everyone { background: var(--role-everyone); }
.badge-noone { background: var(--role-noone); }
.badge-admin { background: var(--role-admin); }
.badge-user { background: var(--role-user); color: #000; }
.badge-self, .badge-creator { background: var(--role-self); }
.badge-custom { background: var(--role-custom); }
.badge-warn { background: var(--warning); color: #000; }
section { margin-bottom: 2rem; }
h1 { font-size: 1.8rem; margin-bottom: 0.5rem; }
h2 { font-size: 1.4rem; margin: 1.5rem 0 0.75rem; padding-bottom: 0.3rem; border-bottom: 2px solid var(--primary); }
h3 { font-size: 1.1rem; margin: 1rem 0 0.5rem; }
.meta { font-size: 0.85rem; opacity: 0.7; margin-bottom: 0.25rem; }
table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; font-size: 0.85rem; }
th, td { padding: 0.4rem 0.6rem; text-align: left; border: 1px solid var(--border); }
th { background: var(--bg-card); cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { background: var(--border); }
tr:nth-child(even) { background: var(--bg-card); }
.collapsible { cursor: pointer; }
.collapsible::before { content: '\\25B6'; display: inline-block; margin-right: 0.5rem; transition: transform 0.2s; font-size: 0.8rem; }
.collapsible.open::before { transform: rotate(90deg); }
.collapse-content { display: none; }
.collapse-content.open { display: block; }
.warning-row { background: rgba(255, 193, 7, 0.1) !important; }
.btn { padding: 0.4rem 0.8rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-card); color: var(--fg); cursor: pointer; font-size: 0.8rem; margin: 0.25rem 0; }
.btn:hover { background: var(--border); }
.module-header { position: sticky; top: 0; background: var(--bg); z-index: 10; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
@media (max-width: 768px) {
  .sidebar { display: none; }
  .main { padding: 1rem; }
  .dashboard { grid-template-columns: repeat(2, 1fr); }
}
</style>`;
  }

  private buildHtml(report: PermissionsReport): string {
    const data = JSON.stringify(report).replace(/</g, '\\u003c');
    const s = report.stats;
    const coverageClass = (pct: number) => (pct >= 90 ? '' : pct >= 70 ? 'warn' : 'danger');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Permissions Report</title>
${this.buildCss()}
</head>
<body>
<div class="layout">
${this.buildSidebarHtml(report)}
<div class="main">
<h1>Permissions Report</h1>
<p class="meta">Generated: ${this.escapeHtml(report.generated)}</p>

<section id="dashboard">
<div class="dashboard">
  <div class="stat"><div class="num">${s.totalModules}</div><div class="label">Modules</div></div>
  <div class="stat"><div class="num">${s.totalModels}</div><div class="label">Models</div></div>
  <div class="stat"><div class="num">${s.totalEndpoints}</div><div class="label">Endpoints</div></div>
  <div class="stat"><div class="num">${s.totalSubObjects}</div><div class="label">SubObjects</div></div>
  <div class="stat ${s.totalWarnings > 0 ? 'danger' : ''}"><div class="num">${s.totalWarnings}</div><div class="label">Warnings</div></div>
  <div class="stat ${coverageClass(s.endpointCoverage)}"><div class="num">${s.endpointCoverage}%</div><div class="label">Endpoint Coverage</div></div>
  <div class="stat ${coverageClass(s.securityCoverage)}"><div class="num">${s.securityCoverage}%</div><div class="label">Security Coverage</div></div>
</div>
</section>

<section>
<div class="controls">
  <input type="text" id="search" placeholder="Search modules, fields, roles..." oninput="filterAll()">
  <select id="roleFilter" onchange="filterAll()">
    <option value="">All Roles</option>
  </select>
  <label><input type="checkbox" id="warnOnly" onchange="filterAll()"> Warnings only</label>
</div>
</section>

${this.buildRoleIndexSection(report)}
${this.buildWarningsSection(report)}
${this.buildModuleSectionsHtml(report)}
${this.buildObjectsSectionsHtml(report)}

</div>
</div>

${this.buildClientJs(data)}
</body>
</html>`;
  }

  private buildModuleSectionsHtml(report: PermissionsReport): string {
    let html = '';
    for (const mod of report.modules) {
      const hasWarnings = report.warnings.some((w) => w.module === mod.name);
      const allRoles = this.collectModuleRoles(mod);
      html += `<section class="module-section" id="mod-${this.escapeHtml(mod.name)}" data-module="${this.escapeHtml(mod.name)}" data-has-warnings="${hasWarnings}" data-roles="${this.escapeHtml(allRoles.join(','))}">\n`;
      html += `<div class="module-header"><h2 class="collapsible open" onclick="toggle(this)">Module: ${this.escapeHtml(mod.name)}</h2></div>\n<div class="collapse-content open">\n`;

      // Models
      for (const model of mod.models) {
        html += `<div id="model-${this.escapeHtml(mod.name)}-${this.escapeHtml(model.className)}">`;
        html += `<h3>Model: ${this.escapeHtml(model.className)}</h3>`;
        html += `<p class="meta">File: ${this.escapeHtml(model.filePath)}</p>`;
        if (model.extendsClass) html += `<p class="meta">Extends: ${this.escapeHtml(model.extendsClass)}</p>`;
        html += `<p class="meta">Class Restriction: ${model.classRestriction.length > 0 ? model.classRestriction.map((r) => this.badge(r)).join(' ') : '<em>(none)</em>'}</p>`;
        html += `<p class="meta">securityCheck: ${model.securityCheck ? this.escapeHtml(model.securityCheck.summary) : '<em>Not present</em>'}</p>`;
        if (model.fields.length > 0) {
          html += '<table><thead><tr><th>Field</th><th>Roles</th><th>Source</th></tr></thead><tbody>';
          for (const f of model.fields) {
            html += `<tr><td>${this.escapeHtml(f.name)}</td><td>${this.escapeHtml(f.roles)}</td><td>${f.inherited ? 'inherited' : 'local'}</td></tr>`;
          }
          html += '</tbody></table>';
        }
        html += '</div>\n';
      }

      // Inputs
      for (const input of mod.inputs) {
        html += `<div><h3>Input: ${this.escapeHtml(input.className)}</h3>`;
        html += `<p class="meta">File: ${this.escapeHtml(input.filePath)}</p>`;
        if (input.extendsClass) html += `<p class="meta">Extends: ${this.escapeHtml(input.extendsClass)}</p>`;
        if (input.fields.length > 0) {
          html += '<table><thead><tr><th>Field</th><th>Roles</th></tr></thead><tbody>';
          for (const f of input.fields) {
            html += `<tr><td>${this.escapeHtml(f.name)}</td><td>${this.escapeHtml(f.roles)}</td></tr>`;
          }
          html += '</tbody></table>';
        }
        html += '</div>\n';
      }

      // Controllers
      for (const ctrl of mod.controllers) {
        html += `<div id="ctrl-${this.escapeHtml(mod.name)}-${this.escapeHtml(ctrl.className)}">`;
        html += `<h3>Controller: ${this.escapeHtml(ctrl.className)}</h3>`;
        html += `<p class="meta">File: ${this.escapeHtml(ctrl.filePath)}</p>`;
        html += `<p class="meta">Class Roles: ${this.badgeList(ctrl.classRoles)}</p>`;
        if (ctrl.methods.length > 0) {
          html +=
            '<table><thead><tr><th>Method</th><th>HTTP</th><th>Route</th><th>Roles</th><th>Effective</th></tr></thead><tbody>';
          for (const m of ctrl.methods) {
            const eff = m.roles.length > 0 ? m.roles : ctrl.classRoles;
            html += `<tr><td>${this.escapeHtml(m.name)}</td><td>${this.escapeHtml(m.httpMethod)}</td><td>${this.escapeHtml(m.route || '/')}</td><td>${this.badgeList(m.roles)}</td><td>${this.badgeList(eff)}${m.roles.length === 0 && ctrl.classRoles.length > 0 ? ' (class)' : ''}</td></tr>`;
          }
          html += '</tbody></table>';
        }
        html += '</div>\n';
      }

      // Resolvers
      for (const res of mod.resolvers) {
        html += `<div id="res-${this.escapeHtml(mod.name)}-${this.escapeHtml(res.className)}">`;
        html += `<h3>Resolver: ${this.escapeHtml(res.className)}</h3>`;
        html += `<p class="meta">File: ${this.escapeHtml(res.filePath)}</p>`;
        html += `<p class="meta">Class Roles: ${this.badgeList(res.classRoles)}</p>`;
        if (res.methods.length > 0) {
          html += '<table><thead><tr><th>Method</th><th>Type</th><th>Roles</th><th>Effective</th></tr></thead><tbody>';
          for (const m of res.methods) {
            const eff = m.roles.length > 0 ? m.roles : res.classRoles;
            html += `<tr><td>${this.escapeHtml(m.name)}</td><td>${this.escapeHtml(m.httpMethod)}</td><td>${this.badgeList(m.roles)}</td><td>${this.badgeList(eff)}${m.roles.length === 0 && res.classRoles.length > 0 ? ' (class)' : ''}</td></tr>`;
          }
          html += '</tbody></table>';
        }
        html += '</div>\n';
      }

      html += '</div></section>\n';
    }
    return html;
  }

  private buildObjectsSectionsHtml(report: PermissionsReport): string {
    if (report.objects.length === 0) return '';

    let html = '<section id="subobjects"><h2>SubObjects</h2>\n';
    for (const obj of report.objects) {
      html += `<div><h3>${this.escapeHtml(obj.className)}</h3>`;
      html += `<p class="meta">File: ${this.escapeHtml(obj.filePath)}</p>`;
      if (obj.extendsClass) html += `<p class="meta">Extends: ${this.escapeHtml(obj.extendsClass)}</p>`;
      if (obj.fields.length > 0) {
        html += '<table><thead><tr><th>Field</th><th>Roles</th><th>Source</th></tr></thead><tbody>';
        for (const f of obj.fields) {
          html += `<tr><td>${this.escapeHtml(f.name)}</td><td>${this.escapeHtml(f.roles)}</td><td>${f.inherited ? 'inherited' : 'local'}</td></tr>`;
        }
        html += '</tbody></table>';
      }
      html += '</div>\n';
    }
    html += '</section>\n';
    return html;
  }

  private buildRoleIndexSection(report: PermissionsReport): string {
    let rows = '';
    if (report.roleEnums.length > 0) {
      for (const e of report.roleEnums) {
        for (const v of e.values) {
          const isSystem = v.key.startsWith('S_');
          rows += `<tr><td>${this.escapeHtml(e.name)}.${this.escapeHtml(v.key)}</td><td>${isSystem ? '(system)' : this.escapeHtml(v.value)}</td><td>${this.badge(isSystem ? 'System' : 'Real')}</td></tr>\n`;
        }
      }
    }

    const content =
      report.roleEnums.length > 0
        ? `<table><thead><tr><th>Enum</th><th>Value</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p><em>No role enums found.</em></p>';

    return `<section id="role-index">
<h2 class="collapsible open" onclick="toggle(this)">Role Index</h2>
<div class="collapse-content open">
${content}
</div>
</section>`;
  }

  private buildSidebarHtml(report: PermissionsReport): string {
    let links = '';
    for (const mod of report.modules) {
      links += `<a href="#mod-${this.escapeHtml(mod.name)}">${this.escapeHtml(mod.name)}</a>\n`;
      for (const model of mod.models) {
        links += `<a href="#model-${this.escapeHtml(mod.name)}-${this.escapeHtml(model.className)}" class="indent">Model: ${this.escapeHtml(model.className)}</a>\n`;
      }
      for (const ctrl of mod.controllers) {
        links += `<a href="#ctrl-${this.escapeHtml(mod.name)}-${this.escapeHtml(ctrl.className)}" class="indent">Ctrl: ${this.escapeHtml(ctrl.className)}</a>\n`;
      }
      for (const res of mod.resolvers) {
        links += `<a href="#res-${this.escapeHtml(mod.name)}-${this.escapeHtml(res.className)}" class="indent">Resolver: ${this.escapeHtml(res.className)}</a>\n`;
      }
    }

    return `<nav class="sidebar">
  <h3>Permissions Report</h3>
  <a href="#dashboard">Dashboard</a>
  <a href="#role-index">Role Index</a>
  <a href="#warnings">Warnings (${report.warnings.length})</a>
  <hr style="margin:0.5rem 0;border-color:var(--border)">
  ${links}
  ${report.objects.length > 0 ? '<hr style="margin:0.5rem 0;border-color:var(--border)"><a href="#subobjects">SubObjects</a>' : ''}
  <hr style="margin:0.5rem 0;border-color:var(--border)">
  <button class="btn" onclick="exportAs('json')">Export JSON</button>
  <button class="btn" onclick="exportMarkdown()">Export Markdown</button>
  <button class="btn" onclick="rescan(event)">Rescan</button>
</nav>`;
  }

  private buildWarningsSection(report: PermissionsReport): string {
    let rows = '';
    for (let i = 0; i < report.warnings.length; i++) {
      const w = report.warnings[i];
      const fileName = w.file.split('/').pop() || w.file;
      rows += `<tr class="warning-row"><td>${i + 1}</td><td>${this.escapeHtml(w.module)}</td><td>${this.escapeHtml(fileName)}</td><td><span class="badge badge-warn">${this.escapeHtml(w.type)}</span></td><td>${this.escapeHtml(w.details)}</td></tr>\n`;
    }

    const content =
      report.warnings.length > 0
        ? `<table><thead><tr><th>#</th><th>Module</th><th>File</th><th>Type</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p><em>No warnings found.</em></p>';

    return `<section id="warnings">
<h2 class="collapsible open" onclick="toggle(this)">Warnings (${report.warnings.length})</h2>
<div class="collapse-content open">
${content}
</div>
</section>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: File watcher
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Watch src/server/ for .ts file changes and invalidate the cached report.
   * This avoids stale data when developers modify decorators while the server is running.
   */
  private setupWatcher() {
    try {
      const root = findProjectRoot();
      if (!root) return;
      const watchPath = join(root, 'src', 'server');
      if (!existsSync(watchPath)) return;
      this.watcher = fs.watch(watchPath, { recursive: true }, (_eventType, filename) => {
        if (filename?.endsWith('.ts')) {
          this.logger.debug(`File changed: ${filename}, invalidating cache`);
          this.report = null;
          this.htmlCache = null;
          this.markdownCache = null;
        }
      });
      this.watcher.on('error', (err) => {
        this.logger.warn(`File watcher error: ${err.message}, manual rescan needed`);
      });
    } catch (err) {
      this.logger.warn(`File watcher setup failed: ${err}, manual rescan needed`);
    }
  }
}
