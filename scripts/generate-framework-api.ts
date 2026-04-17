/**
 * Generate FRAMEWORK-API.md — a compact, machine-readable API reference
 * extracted from the nest-server source code via ts-morph.
 *
 * Run: npx tsx scripts/generate-framework-api.ts
 * Integrated into: pnpm run build (post-step)
 */

import { Project, type InterfaceDeclaration } from 'ts-morph';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTPUT = resolve(ROOT, 'FRAMEWORK-API.md');

// ─── ts-morph setup ──────────────────────────────────────────────

const project = new Project({ tsConfigFilePath: resolve(ROOT, 'tsconfig.json') });

function getSourceFile(relativePath: string) {
  const full = resolve(ROOT, relativePath);
  const sf = project.getSourceFile(full);
  if (!sf) throw new Error(`Source file not found: ${full}`);
  return sf;
}

// ─── Interface extraction ────────────────────────────────────────

function extractInterfaceFields(iface: InterfaceDeclaration): string[] {
  return iface.getProperties().map((prop) => {
    const name = prop.getName();
    const type = prop.getType().getText(prop).replace(/import\([^)]+\)\./g, '');
    const optional = prop.hasQuestionToken() ? '?' : '';
    const jsDocs = prop.getJsDocs();
    let defaultVal = '';
    let description = '';

    for (const doc of jsDocs) {
      const text = doc.getDescription().trim();
      if (text) description = text.split('\n')[0].trim();
      for (const tag of doc.getTags()) {
        if (tag.getTagName() === 'default') {
          defaultVal = tag.getCommentText()?.trim() || '';
        }
      }
    }

    const parts = [`  - \`${name}${optional}\`: \`${truncateType(type)}\``];
    if (defaultVal) parts.push(`(default: \`${defaultVal}\`)`);
    if (description) parts.push(`— ${truncateDescription(description)}`);
    return parts.join(' ');
  });
}

function truncateType(type: string): string {
  // Simplify very long union/intersection types
  if (type.length > 80) {
    return type.substring(0, 77) + '...';
  }
  return type;
}

function truncateDescription(desc: string): string {
  if (desc.length > 120) {
    return desc.substring(0, 117) + '...';
  }
  return desc;
}

// ─── CrudService method extraction ──────────────────────────────

function extractCrudServiceMethods(): string[] {
  const sf = getSourceFile('src/core/common/services/crud.service.ts');
  const crudClass = sf.getClassOrThrow('CrudService');
  const methods: string[] = [];

  for (const method of crudClass.getMethods()) {
    const name = method.getName();
    // Skip private methods and overload implementations
    if (name.startsWith('#') || name.startsWith('_')) continue;

    const isAsync = method.isAsync();
    const params = method.getParameters().map((p) => {
      const paramName = p.getName();
      const paramType = p.getType().getText(p).replace(/import\([^)]+\)\./g, '');
      const optional = p.hasQuestionToken() || p.hasInitializer() ? '?' : '';
      return `${paramName}${optional}: ${truncateType(paramType)}`;
    });

    const returnType = method.getReturnType().getText(method).replace(/import\([^)]+\)\./g, '');

    // Get first line of JSDoc
    let desc = '';
    for (const doc of method.getJsDocs()) {
      const text = doc.getDescription().trim();
      if (text) {
        desc = text.split('\n')[0].trim();
        break;
      }
    }

    const asyncPrefix = isAsync ? 'async ' : '';
    const line = `- \`${asyncPrefix}${name}(${params.join(', ')})\`: \`${truncateType(returnType)}\`${desc ? ` — ${truncateDescription(desc)}` : ''}`;
    methods.push(line);
  }

  return methods;
}

// ─── CoreModule.forRoot extraction ──────────────────────────────

function extractForRootSignatures(): string[] {
  const sf = getSourceFile('src/core.module.ts');
  const coreModule = sf.getClassOrThrow('CoreModule');
  const lines: string[] = [];

  // Get the method with overloads
  const forRootMethods = coreModule.getMethod('forRoot');
  if (!forRootMethods) return lines;

  const overloads = forRootMethods.getOverloads();
  for (const overload of overloads) {
    const params = overload.getParameters().map((p) => {
      const name = p.getName();
      const type = p.getType().getText(p).replace(/import\([^)]+\)\./g, '');
      const optional = p.hasQuestionToken() ? '?' : '';
      return `${name}${optional}: ${truncateType(type)}`;
    });
    const returnType = overload.getReturnType().getText(overload).replace(/import\([^)]+\)\./g, '');
    // The legacy 3+ param signature is deprecated; the IAM-only (1-2 params) is recommended.
    const isDeprecated = overload.getParameters().length > 2;
    const prefix = isDeprecated ? '~~' : '';
    const suffix = isDeprecated ? '~~ *(deprecated)*' : '';
    lines.push(`- ${prefix}\`CoreModule.forRoot(${params.join(', ')})\`: \`${truncateType(returnType)}\`${suffix}`);
  }

  return lines;
}

// ─── Module overview ────────────────────────────────────────────

function extractCoreModules(): string[] {
  const lines: string[] = [];
  const modulesDir = resolve(ROOT, 'src/core/modules');

  // Read the directory manually
  const { readdirSync, existsSync } = require('node:fs');
  const dirs = readdirSync(modulesDir, { withFileTypes: true })
    .filter((d: any) => d.isDirectory())
    .map((d: any) => d.name)
    .sort();

  for (const dir of dirs) {
    const readmePath = resolve(modulesDir, dir, 'README.md');
    const checklistPath = resolve(modulesDir, dir, 'INTEGRATION-CHECKLIST.md');
    const hasReadme = existsSync(readmePath);
    const hasChecklist = existsSync(checklistPath);

    const docs: string[] = [];
    if (hasReadme) docs.push('README');
    if (hasChecklist) docs.push('CHECKLIST');

    lines.push(`| \`${dir}\` | ${docs.join(', ') || '—'} | \`src/core/modules/${dir}/\` |`);
  }

  return lines;
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const serverOptionsSf = getSourceFile('src/core/common/interfaces/server-options.interface.ts');

  // Extract key interfaces
  const targetInterfaces = [
    'IServerOptions',
    'IAuth',
    'IMultiTenancy',
    'IErrorCode',
    'IJwt',
    'ICookiesConfig',
    'ICorsConfig',
    'ICoreModuleOverrides',
  ];

  const interfaceSections: string[] = [];

  for (const name of targetInterfaces) {
    const iface = serverOptionsSf.getInterface(name);
    if (!iface) continue;

    const fields = extractInterfaceFields(iface);
    interfaceSections.push(`### ${name}\n\n${fields.join('\n')}`);
  }

  // IBetterAuth is a type alias (union), extract the underlying interfaces
  const betterAuthInterfaces = ['IBetterAuthPasskeyConfig', 'IBetterAuthTwoFactorConfig', 'IBetterAuthJwtConfig', 'IBetterAuthEmailVerificationConfig', 'IBetterAuthRateLimit', 'IBetterAuthSignUpChecksConfig'];

  for (const name of betterAuthInterfaces) {
    const iface = serverOptionsSf.getInterface(name);
    if (!iface) continue;

    const fields = extractInterfaceFields(iface);
    interfaceSections.push(`### ${name}\n\n${fields.join('\n')}`);
  }

  // IBetterAuth type alias — document it specially
  const betterAuthAlias = serverOptionsSf.getTypeAlias('IBetterAuth');
  if (betterAuthAlias) {
    // Get the two underlying interfaces
    const withPasskey = serverOptionsSf.getInterface('IBetterAuthWithPasskey');
    const withoutPasskey = serverOptionsSf.getInterface('IBetterAuthWithoutPasskey');
    const baseFields: string[] = [];

    // Use whichever has the most fields as the reference
    const ref = withoutPasskey || withPasskey;
    if (ref) {
      baseFields.push(...extractInterfaceFields(ref));
    }

    interfaceSections.splice(
      // Insert after IServerOptions
      interfaceSections.findIndex((s) => s.startsWith('### IAuth')) || 1,
      0,
      `### IBetterAuth (type alias: IBetterAuthWithoutPasskey | IBetterAuthWithPasskey)\n\nWhen \`passkey\` is enabled, \`trustedOrigins\` is required (compile-time enforcement).\n\n${baseFields.join('\n')}`,
    );
  }

  // ServiceOptions
  const serviceOptionsSf = getSourceFile('src/core/common/interfaces/service-options.interface.ts');
  const serviceOptionsIface = serviceOptionsSf.getInterface('ServiceOptions');
  if (serviceOptionsIface) {
    const fields = extractInterfaceFields(serviceOptionsIface);
    interfaceSections.push(`### ServiceOptions\n\n${fields.join('\n')}`);
  }

  // CrudService methods
  const crudMethods = extractCrudServiceMethods();

  // CoreModule.forRoot signatures
  const forRootSigs = extractForRootSignatures();

  // Core modules overview
  const coreModules = extractCoreModules();

  // ─── Assemble document ─────────────────────────────────────────

  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;
  const now = new Date().toISOString().split('T')[0];

  const doc = `# @lenne.tech/nest-server — Framework API Reference

> Auto-generated from source code on ${now} (v${version})
> File: \`FRAMEWORK-API.md\` — compact, machine-readable API surface for Claude Code

## CoreModule.forRoot()

${forRootSigs.join('\n')}

## Configuration Interfaces

${interfaceSections.join('\n\n')}

## CrudService Methods

Base class for all services. Located at \`src/core/common/services/crud.service.ts\`.

Generic: \`CrudService<Model, CreateInput, UpdateInput>\`

${crudMethods.join('\n')}

**Variants:** Each method has three variants:
- \`method()\` — Standard: applies \`securityCheck()\`, respects permissions
- \`methodForce()\` — Bypasses \`securityCheck()\`, still applies input validation
- \`methodRaw()\` — Direct database access, no security or validation

## Core Modules

| Module | Docs | Path |
|--------|------|------|
${coreModules.join('\n')}

## Key Source Files

| File | Purpose |
|------|---------|
| \`src/core.module.ts\` | CoreModule.forRoot() — module registration |
| \`src/core/common/interfaces/server-options.interface.ts\` | All config interfaces |
| \`src/core/common/interfaces/service-options.interface.ts\` | ServiceOptions interface |
| \`src/core/common/services/crud.service.ts\` | CrudService base class |
| \`src/core/common/services/config.service.ts\` | ConfigService (global) |
| \`src/core/common/decorators/\` | @Restricted, @Roles, @CurrentUser, @UnifiedField |
| \`src/core/common/interceptors/\` | CheckResponse, CheckSecurity, ResponseModel |
| \`docs/REQUEST-LIFECYCLE.md\` | Complete request lifecycle |
| \`.claude/rules/\` | Detailed rules for architecture, security, testing |
`;

  writeFileSync(OUTPUT, doc, 'utf-8');
  console.log(`Generated ${OUTPUT} (${(doc.length / 1024).toFixed(1)} KB)`);
}

main();
