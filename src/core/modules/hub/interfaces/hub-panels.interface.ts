/**
 * Response DTOs for the Hub JSON sidecars — the stable contract between the server data providers
 * and the client runtime (and any future richer UI). Every panel that depends on an optional source
 * returns `{ available: false, hint }` instead of erroring when that source is absent.
 */

export interface HubUnavailable {
  available: false;
  hint: string;
}

/**
 * Cockpit-chrome data served (ADMIN-gated) by `GET /{hub}/session.json`. The public shell HTML
 * carries none of this — the client builds the navigation, environment badge, version and external
 * links from this payload only AFTER the auth probe succeeds, so an unauthenticated request reveals
 * nothing of the Hub's structure.
 */
export interface HubSessionData {
  authenticated: true;
  env: string;
  links: Record<string, string | undefined>;
  logoutEndpoint: string;
  panelGroups: string[];
  panels: { available: boolean; group: string; id: string; optional: boolean; path: string; title: string }[];
  version: string;
}

export interface HubDashboardData {
  build: { commit?: string; env: string; version: string };
  features: Record<string, boolean>;
  health?: { details?: Record<string, unknown>; status: string };
  links: Record<string, string>;
  memory: { heapTotal: number; heapUsed: number; rss: number };
  mongo: { readyState: number; state: string };
  time: string;
  uptimeSeconds: number;
}

export interface HubDiagnosticsData {
  arch: string;
  buffers: Record<string, { capacity: number; enabled: boolean; size: number }>;
  cpuUsage: { system: number; user: number };
  env: string;
  memory: { arrayBuffers: number; external: number; heapTotal: number; heapUsed: number; rss: number };
  nodeVersion: string;
  pid: number;
  platform: string;
  time: string;
  uptimeSeconds: number;
}

export interface HubDbData {
  collections: HubDbCollection[];
  stats: { collections: number; dataSize: number; indexSize: number; objects: number; storageSize: number };
}

export interface HubDbCollection {
  avgObjSize?: number;
  count: number;
  indexCount?: number;
  indexSize?: number;
  name: string;
  size: number;
  storageSize: number;
}

export interface HubModelsData {
  entities: { fields: { name: string; ref?: string; type: string }[]; name: string }[];
  mermaid: string;
  modelCount: number;
  relationCount: number;
}

export interface HubMigrationsData {
  completed: string[];
  dirAvailable: boolean;
  lastRun?: string;
  pending: string[];
  source: 'collection' | 'runner';
}

export interface HubFilesData {
  bucket: string;
  files: { contentType?: string; filename: string; id: string; length: number; uploadDate?: string }[];
  total: number;
}

export interface HubCronData {
  intervals: string[];
  jobs: { lastDate?: string; name: string; nextDate?: string; running: boolean }[];
  timeouts: string[];
}

export interface HubErrorCodesData {
  codes: { code: string; de?: string; en?: string }[];
  locale: string;
}

export interface HubEmailsData {
  templates: { locales: string[]; name: string; source: 'framework' | 'project' }[];
}

export interface HubMailboxData {
  cursor: number;
  dropped: number;
  mails: HubMailboxEntry[];
  mode: 'capture' | 'copy';
}

export interface HubLogRecord {
  context?: string;
  level: string;
  message: string;
  seq: number;
  stack?: string;
  timestamp: number;
}

export interface HubLogsData {
  cursor: number;
  dropped: number;
  records: HubLogRecord[];
}

export interface HubTraceRecord {
  aborted?: boolean;
  contentLength?: number;
  durationMs: number;
  error?: boolean;
  graphqlOperation?: string;
  method: string;
  path: string;
  seq: number;
  slow?: boolean;
  statusCode: number;
  timestamp: number;
  userId?: string;
}

export interface HubTracesData {
  cursor: number;
  dropped: number;
  summary: { avgMs: number; errorCount: number; slowCount: number; total: number };
  traces: HubTraceRecord[];
}

export interface HubQueryRecord {
  classification: 'critical' | 'ok' | 'warn';
  collection: string;
  commandSummary: string;
  durationMs: number;
  errorMessage?: string;
  failed?: boolean;
  operation: string;
  requestId: number;
  seq: number;
  timestamp: number;
}

export interface HubQueryTemplate {
  avgMs: number;
  count: number;
  maxMs: number;
  template: string;
}

export interface HubQueriesData {
  cursor: number;
  recent: HubQueryRecord[];
  slowest: HubQueryRecord[];
  summary: { avgMs: number; criticalCount: number; failedCount: number; total: number; warnCount: number };
  topTemplates: HubQueryTemplate[];
}

export interface HubMailboxEntry {
  bcc?: string;
  cc?: string;
  from?: string;
  hasHtml: boolean;
  hasText: boolean;
  seq: number;
  subject?: string;
  templateName?: string;
  timestamp: number;
  to?: string;
}
