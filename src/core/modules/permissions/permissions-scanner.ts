/**
 * Pure permissions scanning functions with no NestJS dependencies.
 *
 * This module is the single source of truth for AST-based permissions scanning.
 * It is used by:
 * - CorePermissionsService (nest-server runtime, adds caching/watcher/HTTP)
 * - lt CLI `lt server permissions` command (dynamic import from node_modules)
 *
 * All functions are standalone and framework-agnostic.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Project, SyntaxKind } from 'ts-morph';

import type {
  EffectiveEndpoint,
  EffectiveMatrixEntry,
  EndpointPermissions,
  FieldPermission,
  FilePermissions,
  MethodPermission,
  ModulePermissions,
  PermissionsReport,
  ReportStats,
  RoleEnumInfo,
  SecurityCheckInfo,
  SecurityWarning,
  WarningsByType,
} from './interfaces/permissions.interface';

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate coverage and warning statistics from scan results.
 */
export function calculateStats(
  modules: ModulePermissions[],
  objects: FilePermissions[],
  warnings: SecurityWarning[],
): ReportStats {
  const warningsByType: WarningsByType = {
    NO_RESTRICTION: 0,
    NO_ROLES: 0,
    NO_SECURITY_CHECK: 0,
    UNRESTRICTED_FIELD: 0,
    UNRESTRICTED_METHOD: 0,
  };
  for (const w of warnings) {
    if (w.type in warningsByType) {
      warningsByType[w.type as keyof WarningsByType]++;
    }
  }

  const totalModels = modules.reduce((s, m) => s + m.models.length, 0);
  let totalMethods = 0;
  let methodsWithRoles = 0;
  for (const mod of modules) {
    for (const ctrl of mod.controllers) {
      for (const m of ctrl.methods) {
        totalMethods++;
        if (m.roles.length > 0 || ctrl.classRoles.length > 0) methodsWithRoles++;
      }
    }
    for (const res of mod.resolvers) {
      for (const m of res.methods) {
        totalMethods++;
        if (m.roles.length > 0 || res.classRoles.length > 0) methodsWithRoles++;
      }
    }
  }

  let modelsWithBothChecks = 0;
  for (const mod of modules) {
    for (const model of mod.models) {
      if (model.classRestriction.length > 0 && model.securityCheck) {
        modelsWithBothChecks++;
      }
    }
  }

  const endpointCoverage = totalMethods > 0 ? Math.round((methodsWithRoles / totalMethods) * 100) : 100;
  const securityCoverage = totalModels > 0 ? Math.round((modelsWithBothChecks / totalModels) * 100) : 100;

  return {
    endpointCoverage,
    securityCoverage,
    totalEndpoints: totalMethods,
    totalModels,
    totalModules: modules.length,
    totalSubObjects: objects.length,
    totalWarnings: warnings.length,
    warningsByType,
  };
}

/**
 * Build an effective permissions matrix for a module, grouping endpoints by role.
 */
export function buildEffectiveMatrix(mod: ModulePermissions): EffectiveMatrixEntry[] {
  const allRoles = new Set<string>();

  for (const ctrl of mod.controllers) {
    for (const r of ctrl.classRoles) allRoles.add(r);
    for (const m of ctrl.methods) {
      for (const r of m.roles) allRoles.add(r);
    }
  }

  for (const res of mod.resolvers) {
    for (const r of res.classRoles) allRoles.add(r);
    for (const m of res.methods) {
      for (const r of m.roles) allRoles.add(r);
    }
  }

  const result: EffectiveMatrixEntry[] = [];

  for (const role of [...allRoles].sort()) {
    const endpoints: EffectiveEndpoint[] = [];

    for (const ctrl of mod.controllers) {
      for (const m of ctrl.methods) {
        const effective = m.roles.length > 0 ? m.roles : ctrl.classRoles;
        if (effective.includes(role)) {
          endpoints.push({ effectiveRoles: effective, method: m.httpMethod, name: m.name, source: 'Controller' });
        }
      }
    }

    for (const res of mod.resolvers) {
      for (const m of res.methods) {
        const effective = m.roles.length > 0 ? m.roles : res.classRoles;
        if (effective.includes(role)) {
          endpoints.push({ effectiveRoles: effective, method: m.httpMethod, name: m.name, source: 'Resolver' });
        }
      }
    }

    result.push({ endpoints, role });
  }

  return result;
}

/**
 * Collect all role enums from the project's common/enums and modules directories.
 */
export function collectRoleEnums(project: Project, projectPath: string): RoleEnumInfo[] {
  const enums: RoleEnumInfo[] = [];
  const enumPatterns = [
    join(projectPath, 'src', 'server', 'common', 'enums'),
    join(projectPath, 'src', 'server', 'modules'),
  ];

  for (const dir of enumPatterns) {
    try {
      const enumFiles = project.addSourceFilesAtPaths(join(dir, '**', '*.enum.ts'));
      for (const sf of enumFiles) {
        for (const enumDecl of sf.getEnums()) {
          const enumName = enumDecl.getName();
          if (enumName.toLowerCase().includes('role')) {
            const values = enumDecl.getMembers().map((m) => ({
              key: m.getName(),
              value: m.getValue()?.toString() || m.getName(),
            }));
            enums.push({
              file: relative(projectPath, sf.getFilePath()),
              name: enumName,
              values,
            });
          }
        }
      }
    } catch {
      // Directory may not exist
    }
  }

  return enums;
}

/**
 * Detect security gaps in modules and objects and return warnings.
 */
export function detectSecurityGaps(modules: ModulePermissions[], objects: FilePermissions[]): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];

  for (const mod of modules) {
    for (const model of mod.models) {
      if (model.classRestriction.length === 0) {
        warnings.push({
          details: `Model ${model.className} has no @Restricted class-level restriction`,
          file: model.filePath,
          module: mod.name,
          type: 'NO_RESTRICTION',
        });
      }
      if (!model.securityCheck) {
        warnings.push({
          details: `Model ${model.className} has no securityCheck override`,
          file: model.filePath,
          module: mod.name,
          type: 'NO_SECURITY_CHECK',
        });
      }
      for (const field of model.fields) {
        if (field.roles === '*(none)*') {
          warnings.push({
            details: `Field '${field.name}' has no role restriction`,
            file: model.filePath,
            module: mod.name,
            type: 'UNRESTRICTED_FIELD',
          });
        }
      }
    }
    for (const input of mod.inputs) {
      for (const field of input.fields) {
        if (field.roles === '*(none)*') {
          warnings.push({
            details: `Field '${field.name}' has no role restriction`,
            file: input.filePath,
            module: mod.name,
            type: 'UNRESTRICTED_FIELD',
          });
        }
      }
    }
    for (const ctrl of mod.controllers) {
      if (ctrl.classRoles.length === 0) {
        warnings.push({
          details: `Controller ${ctrl.className} has no @Roles class-level restriction`,
          file: ctrl.filePath,
          module: mod.name,
          type: 'NO_ROLES',
        });
      }
      for (const method of ctrl.methods) {
        if (method.roles.length === 0 && ctrl.classRoles.length === 0) {
          warnings.push({
            details: `Method '${method.name}' has no @Roles and class has no @Roles`,
            file: ctrl.filePath,
            module: mod.name,
            type: 'UNRESTRICTED_METHOD',
          });
        }
      }
    }
    for (const res of mod.resolvers) {
      if (res.classRoles.length === 0) {
        warnings.push({
          details: `Resolver ${res.className} has no @Roles class-level restriction`,
          file: res.filePath,
          module: mod.name,
          type: 'NO_ROLES',
        });
      }
      for (const method of res.methods) {
        if (method.roles.length === 0 && res.classRoles.length === 0) {
          warnings.push({
            details: `Method '${method.name}' has no @Roles and class has no @Roles`,
            file: res.filePath,
            module: mod.name,
            type: 'UNRESTRICTED_METHOD',
          });
        }
      }
    }
  }

  for (const obj of objects) {
    for (const field of obj.fields) {
      if (field.roles === '*(none)*') {
        warnings.push({
          details: `Field '${field.name}' has no role restriction`,
          file: obj.filePath,
          module: 'objects',
          type: 'UNRESTRICTED_FIELD',
        });
      }
    }
  }

  return warnings;
}

/**
 * Discover module directories under the given modules directory.
 */
export function discoverModules(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .filter((item) => statSync(join(modulesDir, item)).isDirectory())
    .sort();
}

/**
 * Find the project root containing src/server/modules/.
 * Walks up from startPath (default: process.cwd()) up to 10 levels.
 */
export function findProjectRoot(startPath?: string): string | null {
  let current = startPath || process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(current, 'src', 'server', 'modules'))) {
      return current;
    }
    const parent = join(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Scan a NestJS project and return a full PermissionsReport.
 *
 * This is the main entry point for external consumers (e.g. lt CLI).
 *
 * @param projectPath - Absolute path to the project root (must contain src/server/modules/)
 * @param logger - Optional logging callbacks for progress reporting
 */
export function scanPermissions(
  projectPath: string,
  logger?: { log?: (msg: string) => void; warn?: (msg: string) => void },
): PermissionsReport {
  const log = logger?.log || (() => {});
  const warn = logger?.warn || (() => {});

  log('Scanning permissions...');

  const project = new Project({ compilerOptions: { allowJs: true }, skipAddingFilesFromTsConfig: true });
  const modulesDir = join(projectPath, 'src', 'server', 'modules');
  const objectsDir = join(projectPath, 'src', 'server', 'common', 'objects');

  // Preload nest-server base classes once (used by resolveInheritedFields for all models)
  preloadBaseClasses(project, projectPath);

  const roleEnums = collectRoleEnums(project, projectPath);
  const moduleNames = discoverModules(modulesDir);
  const modules: ModulePermissions[] = [];

  for (const name of moduleNames) {
    try {
      modules.push(scanModule(project, modulesDir, name, projectPath));
    } catch (error) {
      warn(`Failed to scan module '${name}': ${error}`);
    }
  }

  const objects = scanObjects(project, objectsDir, projectPath);
  const warnings = detectSecurityGaps(modules, objects);
  const stats = calculateStats(modules, objects, warnings);

  log(`Scan complete: ${modules.length} modules, ${objects.length} objects, ${warnings.length} warnings`);

  return {
    generated: new Date().toISOString(),
    modules,
    objects,
    roleEnums,
    stats,
    warnings,
  };
}

/**
 * Scan a single module directory for models, inputs, outputs, controllers, and resolvers.
 */
export function scanModule(
  project: Project,
  modulesDir: string,
  moduleName: string,
  projectPath: string,
): ModulePermissions {
  const moduleDir = join(modulesDir, moduleName);
  const result: ModulePermissions = {
    controllers: [],
    inputs: [],
    models: [],
    name: moduleName,
    outputs: [],
    resolvers: [],
  };

  // Models
  for (const file of listDir(moduleDir).filter((f) => f.endsWith('.model.ts'))) {
    try {
      const sf = project.addSourceFileAtPath(join(moduleDir, file));
      const perms = parseFilePermissions(sf, relative(projectPath, join(moduleDir, file)), true);
      if (perms) {
        const classDecl = sf.getClasses()[0];
        if (classDecl) {
          const inheritedFields = resolveInheritedFields(project, classDecl);
          const localNames = new Set(perms.fields.map((f) => f.name));
          for (const iField of inheritedFields) {
            if (!localNames.has(iField.name)) perms.fields.push(iField);
          }
        }
        result.models.push(perms);
      }
    } catch {
      /* skip */
    }
  }

  // Inputs
  const inputDir = join(moduleDir, 'inputs');
  for (const file of listDir(inputDir).filter((f) => f.endsWith('.input.ts'))) {
    try {
      const sf = project.addSourceFileAtPath(join(inputDir, file));
      const perms = parseFilePermissions(sf, relative(projectPath, join(inputDir, file)), false);
      if (perms) result.inputs.push(perms);
    } catch {
      /* skip */
    }
  }

  // Outputs
  const outputDir = join(moduleDir, 'outputs');
  for (const file of listDir(outputDir).filter((f) => f.endsWith('.output.ts'))) {
    try {
      const sf = project.addSourceFileAtPath(join(outputDir, file));
      const perms = parseFilePermissions(sf, relative(projectPath, join(outputDir, file)), false);
      if (perms) result.outputs.push(perms);
    } catch {
      /* skip */
    }
  }

  // Controllers
  for (const file of listDir(moduleDir).filter((f) => f.endsWith('.controller.ts'))) {
    try {
      const sf = project.addSourceFileAtPath(join(moduleDir, file));
      const perms = parseEndpointPermissions(sf, relative(projectPath, join(moduleDir, file)));
      if (perms) result.controllers.push(perms);
    } catch {
      /* skip */
    }
  }

  // Resolvers
  for (const file of listDir(moduleDir).filter((f) => f.endsWith('.resolver.ts'))) {
    try {
      const sf = project.addSourceFileAtPath(join(moduleDir, file));
      const perms = parseEndpointPermissions(sf, relative(projectPath, join(moduleDir, file)));
      if (perms) result.resolvers.push(perms);
    } catch {
      /* skip */
    }
  }

  return result;
}

/**
 * Scan SubObjects directory for .object.ts files.
 */
export function scanObjects(project: Project, objectsDir: string, projectPath: string): FilePermissions[] {
  const objects: FilePermissions[] = [];
  if (!existsSync(objectsDir)) return objects;

  for (const dir of listDir(objectsDir)) {
    const dirPath = join(objectsDir, dir);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listDir(dirPath).filter((f) => f.endsWith('.object.ts'))) {
      try {
        const sf = project.addSourceFileAtPath(join(dirPath, file));
        const perms = parseFilePermissions(sf, relative(projectPath, join(dirPath, file)), false);
        if (perms) objects.push(perms);
      } catch {
        /* skip */
      }
    }
  }

  return objects;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers (exported for advanced usage, but normally not needed directly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract roles from decorator arguments, handling array syntax and enum prefixes.
 */
export function extractDecoratorRoles(decoratorArgs: string[]): string[] {
  const roles: string[] = [];
  for (const arg of decoratorArgs) {
    const cleaned = arg.trim();
    if (cleaned.startsWith('[')) {
      const inner = cleaned.slice(1, -1);
      for (const item of inner.split(',')) {
        roles.push(formatRole(item.trim()));
      }
    } else {
      roles.push(formatRole(cleaned));
    }
  }
  return roles;
}

/**
 * Analyze a securityCheck() method body using regex patterns to detect:
 * - `delete obj.field` statements (direct field removal)
 * - Named arrays like `fieldsToRemove = [...]` (batch field removal)
 * - Helper calls like `removeKeys(obj, [...])` (utility-based removal)
 * - `return undefined/null` (full object suppression)
 */
export function extractSecurityCheckInfo(classDecl: any): SecurityCheckInfo | undefined {
  const method = classDecl.getMethod('securityCheck');
  if (!method) return undefined;

  const body = method.getBodyText() || '';
  const fieldsStripped: string[] = [];

  const deleteMatches = body.matchAll(/delete\s+\w+\.(\w+)/g);
  for (const m of deleteMatches) fieldsStripped.push(m[1]);

  const arrayMatches = body.matchAll(/(?:fieldsToRemove|removeFields|stripFields|fieldsToStrip)\s*=\s*\[([^\]]+)\]/g);
  for (const m of arrayMatches) {
    fieldsStripped.push(...m[1].split(',').map((f: string) => f.trim().replace(/['"]/g, '')));
  }

  const graphqlFieldMatches = body.matchAll(/(?:removeKeys|filterKeys)\s*\([^,]*,\s*\[([^\]]+)\]/g);
  for (const m of graphqlFieldMatches) {
    fieldsStripped.push(...m[1].split(',').map((f: string) => f.trim().replace(/['"]/g, '')));
  }

  const returnsUndefined = body.includes('return undefined') || body.includes('return null');

  const summaryParts: string[] = ['Present'];
  if (fieldsStripped.length > 0) summaryParts.push(`Strips fields: ${fieldsStripped.join(', ')}`);
  if (returnsUndefined) summaryParts.push('May return undefined');

  return { fieldsStripped: [...new Set(fieldsStripped)], returnsUndefined, summary: summaryParts.join('. ') };
}

/** Strip enum prefix (e.g. 'RoleEnum.ADMIN' -> 'ADMIN') */
export function formatRole(role: string): string {
  if (!role) return '';
  const dotIndex = role.lastIndexOf('.');
  return dotIndex >= 0 ? role.substring(dotIndex + 1) : role;
}

/** Format roles array for display in Markdown output. */
export function formatRolesDisplay(roles: string[]): string {
  if (roles.length === 0) return '*(none)*';
  if (roles.length === 1) return `\`${roles[0]}\``;
  return roles.map((r) => `\`${r}\``).join(', ');
}

/**
 * Generate a Markdown report from a PermissionsReport.
 *
 * This is the single source of truth for Markdown output, used by both
 * the nest-server runtime endpoint and the CLI command.
 */
export function generateMarkdownReport(report: PermissionsReport, projectPath?: string): string {
  const lines: string[] = [];

  // Header
  lines.push('# Permissions Report');
  lines.push('');
  lines.push(`> Generated: ${report.generated}`);
  if (projectPath) lines.push(`> Project: ${projectPath}`);
  lines.push(
    `> Modules: ${report.stats.totalModules} | Models: ${report.stats.totalModels} | Endpoints: ${report.stats.totalEndpoints} | SubObjects: ${report.stats.totalSubObjects}`,
  );
  lines.push(
    `> Warnings: ${report.stats.totalWarnings} | Endpoint Coverage: ${report.stats.endpointCoverage}% | Security Coverage: ${report.stats.securityCoverage}%`,
  );
  lines.push('');

  // Table of contents
  lines.push('## Table of Contents');
  lines.push('');
  lines.push('- [Role Index](#role-index)');
  lines.push('- [Summary](#summary)');
  lines.push('- [Warnings](#warnings)');
  for (const mod of report.modules) {
    const anchor = mod.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    lines.push(`- [Module: ${mod.name}](#module-${anchor})`);
  }
  if (report.objects.length > 0) {
    lines.push('- [SubObjects](#subobjects)');
  }
  lines.push('');

  // Role index
  lines.push('## Role Index');
  lines.push('');
  if (report.roleEnums.length > 0) {
    lines.push('| Enum | Value | Type |');
    lines.push('|------|-------|------|');
    for (const enumInfo of report.roleEnums) {
      for (const v of enumInfo.values) {
        const isSystem = v.key.startsWith('S_');
        lines.push(
          `| ${enumInfo.name}.${v.key} | ${isSystem ? '*(system)*' : `\`${v.value}\``} | ${isSystem ? 'System' : 'Real'} |`,
        );
      }
    }
  } else {
    lines.push('*No role enums found.*');
  }
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Module | Models | Inputs | Outputs | Controllers | Resolvers | Warnings |');
  lines.push('|--------|--------|--------|---------|-------------|-----------|----------|');
  for (const mod of report.modules) {
    const modWarnings = report.warnings.filter((w) => w.module === mod.name).length;
    lines.push(
      `| ${mod.name} | ${mod.models.length} | ${mod.inputs.length} | ${mod.outputs.length} | ${mod.controllers.length} | ${mod.resolvers.length} | ${modWarnings} |`,
    );
  }
  lines.push('');

  if (report.stats.totalWarnings > 0) {
    lines.push('### Warnings by Type');
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|------|-------|');
    for (const [type, count] of Object.entries(report.stats.warningsByType)) {
      if (count > 0) lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');
  }

  // Warnings
  lines.push('## Warnings');
  lines.push('');
  if (report.warnings.length > 0) {
    lines.push('| # | Module | File | Type | Details |');
    lines.push('|---|--------|------|------|---------|');
    report.warnings.forEach((w, i) => {
      const fileName = w.file.split('/').pop() || w.file;
      lines.push(`| ${i + 1} | ${w.module} | ${fileName} | ${w.type} | ${w.details} |`);
    });
  } else {
    lines.push('*No warnings found.*');
  }
  lines.push('');

  // Module details
  for (const mod of report.modules) {
    lines.push('---');
    lines.push('');
    lines.push(`## Module: ${mod.name}`);
    lines.push('');

    // Models
    for (const model of mod.models) {
      lines.push(`### Model: ${model.className}`);
      lines.push(`- **File:** \`${model.filePath}\``);
      if (model.extendsClass) lines.push(`- **Extends:** \`${model.extendsClass}\``);
      lines.push(
        `- **Class Restriction:** ${model.classRestriction.length > 0 ? model.classRestriction.map((r) => `\`${r}\``).join(', ') : '*(none)*'}`,
      );
      if (model.securityCheck) {
        lines.push(`- **securityCheck:** ${model.securityCheck.summary}`);
      } else {
        lines.push('- **securityCheck:** Not present');
      }
      lines.push('');

      if (model.fields.length > 0) {
        lines.push('| Field | Roles | Source |');
        lines.push('|-------|-------|--------|');
        for (const field of model.fields) {
          const source = field.inherited ? 'inherited' : 'local';
          lines.push(`| ${field.name} | ${field.roles} | ${source} |`);
        }
      }
      lines.push('');
    }

    // Inputs
    for (const input of mod.inputs) {
      lines.push(`### Input: ${input.className}`);
      lines.push(`- **File:** \`${input.filePath}\``);
      if (input.extendsClass) lines.push(`- **Extends:** \`${input.extendsClass}\``);
      lines.push(
        `- **Class Restriction:** ${input.classRestriction.length > 0 ? input.classRestriction.map((r) => `\`${r}\``).join(', ') : '*(none)*'}`,
      );
      lines.push('');

      if (input.fields.length > 0) {
        lines.push('| Field | Roles |');
        lines.push('|-------|-------|');
        for (const field of input.fields) {
          lines.push(`| ${field.name} | ${field.roles} |`);
        }
      }
      lines.push('');
    }

    // Outputs
    for (const output of mod.outputs) {
      lines.push(`### Output: ${output.className}`);
      lines.push(`- **File:** \`${output.filePath}\``);
      if (output.extendsClass) lines.push(`- **Extends:** \`${output.extendsClass}\``);
      lines.push('');

      if (output.fields.length > 0) {
        lines.push('| Field | Roles |');
        lines.push('|-------|-------|');
        for (const field of output.fields) {
          lines.push(`| ${field.name} | ${field.roles} |`);
        }
      }
      lines.push('');
    }

    // Controllers
    for (const ctrl of mod.controllers) {
      lines.push(`### Controller: ${ctrl.className}`);
      lines.push(`- **File:** \`${ctrl.filePath}\``);
      lines.push(
        `- **Class Roles:** ${ctrl.classRoles.length > 0 ? ctrl.classRoles.map((r) => `\`${r}\``).join(', ') : '*(none)*'}`,
      );
      lines.push('');

      if (ctrl.methods.length > 0) {
        lines.push('| Method | HTTP | Route | Roles | Effective |');
        lines.push('|--------|------|-------|-------|-----------|');
        for (const m of ctrl.methods) {
          const effective =
            m.roles.length > 0 ? formatRolesDisplay(m.roles) : `${formatRolesDisplay(ctrl.classRoles)} (class)`;
          lines.push(
            `| ${m.name} | ${m.httpMethod} | ${m.route || '/'} | ${formatRolesDisplay(m.roles)} | ${effective} |`,
          );
        }
      }
      lines.push('');
    }

    // Resolvers
    for (const res of mod.resolvers) {
      lines.push(`### Resolver: ${res.className}`);
      lines.push(`- **File:** \`${res.filePath}\``);
      lines.push(
        `- **Class Roles:** ${res.classRoles.length > 0 ? res.classRoles.map((r) => `\`${r}\``).join(', ') : '*(none)*'}`,
      );
      lines.push('');

      if (res.methods.length > 0) {
        lines.push('| Method | Type | Roles | Effective |');
        lines.push('|--------|------|-------|-----------|');
        for (const m of res.methods) {
          const effective =
            m.roles.length > 0 ? formatRolesDisplay(m.roles) : `${formatRolesDisplay(res.classRoles)} (class)`;
          lines.push(`| ${m.name} | ${m.httpMethod} | ${formatRolesDisplay(m.roles)} | ${effective} |`);
        }
      }
      lines.push('');
    }

    // Effective matrix
    const matrix = buildEffectiveMatrix(mod);
    if (matrix.length > 0) {
      lines.push(`### Effective Permissions: ${mod.name}`);
      lines.push('');
      lines.push('| Role | Endpoint Access |');
      lines.push('|------|-----------------|');
      for (const entry of matrix) {
        const endpointList = entry.endpoints.map((e) => `${e.method} ${e.name}`).join(', ');
        lines.push(`| \`${entry.role}\` | ${endpointList || '*(none)*'} |`);
      }
      lines.push('');
    }
  }

  // SubObjects
  if (report.objects.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## SubObjects');
    lines.push('');

    for (const obj of report.objects) {
      lines.push(`### ${obj.className}`);
      lines.push(`- **File:** \`${obj.filePath}\``);
      if (obj.extendsClass) lines.push(`- **Extends:** \`${obj.extendsClass}\``);
      lines.push(
        `- **Class Restriction:** ${obj.classRestriction.length > 0 ? obj.classRestriction.map((r) => `\`${r}\``).join(', ') : '*(none)*'}`,
      );
      lines.push('');

      if (obj.fields.length > 0) {
        lines.push('| Field | Roles | Source |');
        lines.push('|-------|-------|--------|');
        for (const field of obj.fields) {
          const source = field.inherited ? 'inherited' : 'local';
          lines.push(`| ${field.name} | ${field.roles} | ${source} |`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse endpoint permissions (controller/resolver) from a source file.
 */
export function parseEndpointPermissions(sourceFile: any, filePath: string): EndpointPermissions | undefined {
  const classes = sourceFile.getClasses();
  if (classes.length === 0) return undefined;

  const classDecl = classes[0];
  const className = classDecl.getName() || 'Unknown';
  const classRoles = parseRolesDecorator(classDecl);

  let controllerPrefix = '';
  const controllerDeco = classDecl.getDecorator('Controller');
  if (controllerDeco) {
    const args = controllerDeco.getArguments();
    if (args.length > 0) controllerPrefix = args[0].getText().replace(/['"]/g, '');
  }

  const methods: MethodPermission[] = [];
  for (const method of classDecl.getMethods()) {
    const methodName = method.getName();
    if (methodName.startsWith('_') || ['onModuleDestroy', 'onModuleInit'].includes(methodName)) continue;

    const methodRoles = parseRolesDecorator(method);

    for (const httpDeco of ['Delete', 'Get', 'Patch', 'Post', 'Put']) {
      const deco = method.getDecorator(httpDeco);
      if (deco) {
        const args = deco.getArguments();
        const route = args.length > 0 ? args[0].getText().replace(/['"]/g, '') : '/';
        const fullRoute = controllerPrefix
          ? `/${controllerPrefix}/${route}`.replace(/\/+/g, '/')
          : `/${route}`.replace(/\/+/g, '/');
        methods.push({ httpMethod: httpDeco.toUpperCase(), name: methodName, roles: methodRoles, route: fullRoute });
      }
    }

    for (const gqlDeco of ['Mutation', 'Query', 'Subscription']) {
      const deco = method.getDecorator(gqlDeco);
      if (deco) {
        methods.push({ httpMethod: gqlDeco, name: methodName, roles: methodRoles });
      }
    }
  }

  return { className, classRoles, filePath, methods };
}

/**
 * Parse field permissions from a class property, checking @UnifiedField and @Restricted decorators.
 */
export function parseFieldPermission(prop: any): FieldPermission {
  const fieldName = prop.getName();
  let roles = '*(none)*';
  let description: string | undefined;

  const unifiedField = prop.getDecorator('UnifiedField');
  if (unifiedField) {
    const args = unifiedField.getArguments();
    if (args.length > 0) {
      const optionsArg = args[0];
      if (optionsArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
        const objLit = optionsArg.asKind(SyntaxKind.ObjectLiteralExpression);

        const rolesProp = objLit?.getProperty('roles');
        if (rolesProp) {
          const init = rolesProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
          if (init) {
            const rolesText = init.getText();
            if (rolesText.startsWith('[')) {
              const inner = rolesText.slice(1, -1);
              const roleList = inner.split(',').map((r: string) => formatRole(r.trim()));
              roles = roleList.map((r: string) => `\`${r}\``).join(', ');
            } else {
              roles = `\`${formatRole(rolesText)}\``;
            }
          }
        }

        const descProp = objLit?.getProperty('description');
        if (descProp) {
          const init = descProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
          if (init) description = init.getText().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }

  if (roles === '*(none)*') {
    const restricted = prop.getDecorator('Restricted');
    if (restricted) {
      const args = restricted.getArguments().map((a: any) => a.getText());
      if (args.length > 0) {
        const roleList = extractDecoratorRoles(args);
        roles = roleList.map((r: string) => `\`${r}\``).join(', ');
      }
    }
  }

  return { description, name: fieldName, roles };
}

/**
 * Parse file permissions (model/input/output) from a source file.
 */
export function parseFilePermissions(sourceFile: any, filePath: string, isModel: boolean): FilePermissions | undefined {
  const classes = sourceFile.getClasses();
  if (classes.length === 0) return undefined;

  const classDecl = classes[0];
  const className = classDecl.getName() || 'Unknown';
  const extendsExpr = classDecl.getExtends();
  const extendsClass = extendsExpr?.getText()?.replace(/<.*>/, '') || undefined;
  const classRestriction = parseRestrictedDecorator(classDecl);
  const securityCheck = isModel ? extractSecurityCheckInfo(classDecl) : undefined;

  const fields: FieldPermission[] = [];
  for (const prop of classDecl.getProperties()) {
    fields.push(parseFieldPermission(prop));
  }

  return { className, classRestriction, extendsClass, fields, filePath, securityCheck };
}

/** Parse @Restricted decorator roles from a class or property. */
export function parseRestrictedDecorator(node: any): string[] {
  const restricted = node.getDecorator('Restricted');
  if (!restricted) return [];
  const args = restricted.getArguments().map((a: any) => a.getText());
  return extractDecoratorRoles(args);
}

/** Parse @Roles decorator roles from a class or method. */
export function parseRolesDecorator(node: any): string[] {
  const roles = node.getDecorator('Roles');
  if (!roles) return [];
  const args = roles.getArguments().map((a: any) => a.getText());
  return extractDecoratorRoles(args);
}

/**
 * Resolve inherited fields from base classes in node_modules/@lenne.tech/nest-server.
 * Recursively walks the inheritance chain.
 *
 * Requires base classes to be preloaded via preloadBaseClasses() (called once in scanPermissions).
 */
export function resolveInheritedFields(project: Project, classDecl: any): FieldPermission[] {
  const inherited: FieldPermission[] = [];
  const extendsExpr = classDecl.getExtends();
  if (!extendsExpr) return inherited;

  const baseClassName = extendsExpr.getText().replace(/<.*>/, '');

  // Search already-loaded source files (preloaded in scanPermissions)
  for (const sf of project.getSourceFiles()) {
    for (const cls of sf.getClasses()) {
      if (cls.getName() === baseClassName) {
        for (const prop of cls.getProperties()) {
          const field = parseFieldPermission(prop);
          field.inherited = true;
          inherited.push(field);
        }
        const parentFields = resolveInheritedFields(project, cls);
        inherited.push(...parentFields);
        return inherited;
      }
    }
  }

  return inherited;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function preloadBaseClasses(project: Project, projectPath: string): void {
  const nestServerPaths = [
    join(projectPath, 'node_modules', '@lenne.tech', 'nest-server', 'src'),
    join(projectPath, 'node_modules', '@lenne.tech', 'nest-server', 'dist'),
  ];
  for (const basePath of nestServerPaths) {
    try {
      if (existsSync(basePath)) {
        project.addSourceFilesAtPaths(join(basePath, '**', '*.ts'));
      }
    } catch {
      // Base path not available
    }
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
