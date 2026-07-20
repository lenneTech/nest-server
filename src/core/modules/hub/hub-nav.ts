/**
 * Single source of truth for the Hub's panels: id, route sub-path, title, sidebar group and the
 * JSON sidecar the client polls. The HTML shell renders the sidebar from this list; the client
 * runtime routes and renders from the same list (embedded into the shell).
 *
 * Pure data — no imports — so both the server shell builder and the client-JS string can share it.
 */

export type HubPanelGroup = 'Overview' | 'Runtime' | 'Data' | 'API & Docs';

export interface HubPanel {
  /** Sidebar group. */
  readonly group: HubPanelGroup;
  /** Stable id (also the client router key). */
  readonly id: string;
  /** Sidecar sub-path relative to the base path (e.g. 'dashboard.json'). Empty when the panel has none. */
  readonly json: string;
  /** Whether the panel depends on an optional source and may render an "unavailable" state. */
  readonly optional?: boolean;
  /** Route sub-path relative to the base path (''=dashboard root). */
  readonly path: string;
  /** Human-readable title. */
  readonly title: string;
}

export const HUB_PANELS: readonly HubPanel[] = [
  { group: 'Overview', id: 'dashboard', json: 'dashboard.json', path: '', title: 'Dashboard' },
  { group: 'Overview', id: 'diagnostics', json: 'diagnostics.json', path: 'diagnostics', title: 'Diagnostics' },
  { group: 'Runtime', id: 'logs', json: 'logs.json', path: 'logs', title: 'Logs' },
  { group: 'Runtime', id: 'traces', json: 'traces.json', path: 'traces', title: 'Request Traces' },
  { group: 'Runtime', id: 'queries', json: 'queries.json', path: 'queries', title: 'Query Performance' },
  { group: 'Runtime', id: 'cron', json: 'cron.json', optional: true, path: 'cron', title: 'Cron Jobs' },
  { group: 'Data', id: 'db', json: 'db.json', path: 'db', title: 'Database' },
  { group: 'Data', id: 'models', json: 'models.json', path: 'models', title: 'Models / ERD' },
  { group: 'Data', id: 'migrations', json: 'migrations.json', path: 'migrations', title: 'Migrations' },
  { group: 'Data', id: 'files', json: 'files.json', path: 'files', title: 'Files' },
  { group: 'Data', id: 'config', json: 'config.json', path: 'config', title: 'Config' },
  {
    group: 'Data',
    id: 'auth-migration',
    json: 'auth-migration.json',
    optional: true,
    path: 'auth-migration',
    title: 'Auth Migration',
  },
  {
    group: 'API & Docs',
    id: 'routes',
    json: 'routes.json',
    optional: true,
    path: 'routes',
    title: 'Routes / Permissions',
  },
  { group: 'API & Docs', id: 'error-codes', json: 'error-codes.json', path: 'error-codes', title: 'Error Codes' },
  { group: 'API & Docs', id: 'emails', json: 'emails.json', path: 'emails', title: 'Email Preview' },
  { group: 'API & Docs', id: 'mailbox', json: 'mailbox.json', optional: true, path: 'mailbox', title: 'Mailbox' },
  { group: 'API & Docs', id: 'ai', json: 'ai.json', optional: true, path: 'ai', title: 'AI' },
] as const;

export const HUB_PANEL_GROUPS: readonly HubPanelGroup[] = ['Overview', 'Runtime', 'Data', 'API & Docs'];

/** Find the panel that a given route sub-path renders. */
export function findHubPanelByPath(subPath: string): HubPanel | undefined {
  const normalized = subPath.replace(/^\/+|\/+$/g, '');
  return HUB_PANELS.find((panel) => panel.path === normalized);
}
