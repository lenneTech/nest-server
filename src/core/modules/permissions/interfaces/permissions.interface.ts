/**
 * Configuration for the permissions report module.
 *
 * Follows the "presence implies enabled" pattern:
 * - `true`: Enabled with defaults (admin-only access)
 * - `{ role: 'S_EVERYONE' }`: Enabled with custom role
 * - `{ role: false }`: Enabled without auth check
 * - `{ enabled: false }`: Explicitly disabled
 */
export interface IPermissions {
  enabled?: boolean;
  /**
   * Base path for permission endpoints.
   * - undefined: Defaults to 'permissions'
   * - string: Custom path (e.g. 'admin/permissions')
   *
   * Resulting endpoints: GET /{path}, GET /{path}/json, GET /{path}/markdown, POST /{path}/rescan
   */
  path?: string;
  /**
   * Role required to access permission endpoints.
   * - undefined: Defaults to RoleEnum.ADMIN
   * - string: Specific role (e.g. 'S_EVERYONE' for public access)
   * - false: No role check at all (no auth required)
   */
  role?: false | string;
}

export interface EffectiveEndpoint {
  effectiveRoles: string[];
  method: string;
  name: string;
  source: string;
}

export interface EffectiveMatrixEntry {
  endpoints: EffectiveEndpoint[];
  role: string;
}

export interface EndpointPermissions {
  className: string;
  classRoles: string[];
  filePath: string;
  methods: MethodPermission[];
}

export interface FieldPermission {
  description?: string;
  inherited?: boolean;
  name: string;
  roles: string;
}

export interface FilePermissions {
  className: string;
  classRestriction: string[];
  extendsClass?: string;
  fields: FieldPermission[];
  filePath: string;
  securityCheck?: SecurityCheckInfo;
}

export interface MethodPermission {
  httpMethod: string;
  name: string;
  roles: string[];
  route?: string;
}

export interface ModulePermissions {
  controllers: EndpointPermissions[];
  inputs: FilePermissions[];
  models: FilePermissions[];
  name: string;
  outputs: FilePermissions[];
  resolvers: EndpointPermissions[];
}

export interface PermissionsReport {
  generated: string;
  modules: ModulePermissions[];
  objects: FilePermissions[];
  roleEnums: RoleEnumInfo[];
  stats: ReportStats;
  warnings: SecurityWarning[];
}

export interface ReportStats {
  endpointCoverage: number;
  securityCoverage: number;
  totalEndpoints: number;
  totalModels: number;
  totalModules: number;
  totalSubObjects: number;
  totalWarnings: number;
  warningsByType: WarningsByType;
}

export interface RoleEnumInfo {
  file: string;
  name: string;
  values: { key: string; value: string }[];
}

export interface SecurityCheckInfo {
  fieldsStripped: string[];
  returnsUndefined: boolean;
  summary: string;
}

export interface SecurityWarning {
  details: string;
  file: string;
  module: string;
  type: string;
}

export interface WarningsByType {
  NO_RESTRICTION: number;
  NO_ROLES: number;
  NO_SECURITY_CHECK: number;
  UNRESTRICTED_FIELD: number;
  UNRESTRICTED_METHOD: number;
}
