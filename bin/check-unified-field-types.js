#!/usr/bin/env node
/**
 * check-unified-field-types — every `@UnifiedField` gets a runtime type both compilers agree on.
 *
 * `@UnifiedField` reads a field's type from the `design:type` metadata when no `type` is given. tsc
 * (the build) writes that metadata with the type checker; the SWC loader of the dev start writes it
 * syntactically, file by file. Where the two disagree, the dev API validates, documents and
 * generates client types differently from the deployed one:
 *
 *   field                                   SWC (dev start)   tsc (build, strict: false)
 *   max?: null | number                     Object            Number
 *   kind?: Kind   (type alias)              Object            String
 *   status?: Status | null   (enum)         Object            String / Number
 *   flag?: boolean | null                   Object            Boolean
 *   meta?: Record<string, unknown>          Object            Object
 *   state?: 'ok' | 'error'   (in place)     String            String
 *
 * A plain enum (`status?: Status`) is no finding: SWC writes the enum object there, and @UnifiedField reads it as
 * String / Number like tsc since 12.8.7.
 *
 * `Object` makes `@UnifiedField` validate the field as a nested object, so the dev API refuses
 * `max: 5` while the build accepts it. This script finds every `@UnifiedField` without `type`,
 * `isAny` or `enum` whose declared type is not one both compilers emit the same way (`number`,
 * `string`, `boolean`, `Date`, a class imported as a value, an enum, a union of string literals
 * written in place), and resolves with the type checker the runtime type the tsc build uses.
 * `--fix` writes exactly that as `type: () => X`, so the deployed behaviour stays as it is and the
 * dev start matches it. Where the tsc build writes something else today — Object for a union with
 * null / undefined under strictNullChecks, for a generic alias, for a field without a type
 * annotation — the field is marked "[changes the deployed build]": the type written for it (the one
 * the field declares) changes its deployed validation. The comparison reads tsc's own emit. A field whose type has no
 * runtime class (an interface, a `Record`, a mixed union, `any`) is reported with what to declare
 * instead.
 *
 * Usage:
 *   node <nest-server>/bin/check-unified-field-types.js [--fix] [--project tsconfig.json] [--include src]
 *   (npm mode: the package bin `nest-check-unified-field-types`)
 *
 * Exit codes: 0 nothing to do, 1 findings left (without --fix: any; with --fix: the ones it cannot
 * fix), 2 usage or configuration error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const PREFIX = '[unified-field-types]';

function usage() {
  return [
    'Usage: check-unified-field-types [--fix] [--project <tsconfig>] [--include <dir>]...',
    '',
    '  --fix              write `type: () => X` into every field the checker can resolve',
    '  --project, -p      tsconfig to build the program from (default: tsconfig.json)',
    '  --include          directory to check, repeatable (default: src)',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { fix: false, help: false, include: [], project: 'tsconfig.json' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // `pnpm run <script> -- --fix` passes the separator through (npm and yarn drop it)
      continue;
    }
    if (arg === '--fix') {
      args.fix = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--project' || arg === '-p') {
      args.project = argv[++i];
    } else if (arg.startsWith('--project=')) {
      args.project = arg.slice('--project='.length);
    } else if (arg === '--include') {
      args.include.push(argv[++i]);
    } else if (arg.startsWith('--include=')) {
      args.include.push(arg.slice('--include='.length));
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!args.project) {
    throw new UsageError('--project needs a path');
  }
  if (args.include.length === 0) {
    args.include.push('src');
  }
  return args;
}

class UsageError extends Error {}

/** The project's own TypeScript, so the checker resolves types exactly as its build does. */
function loadTypeScript(cwd) {
  try {
    return createRequire(path.join(cwd, 'package.json'))('typescript');
  } catch {
    return require('typescript');
  }
}

function createProgram(ts, cwd, project) {
  const configPath = path.resolve(cwd, project);
  if (!fs.existsSync(configPath)) {
    throw new UsageError(`tsconfig not found: ${configPath}`);
  }
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new UsageError(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  // Emit is only ever called with a writeFile callback (see emittedDesignTypes), so nothing reaches the disk
  const options = {
    ...parsed.options,
    composite: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    incremental: false,
    inlineSourceMap: false,
    noEmit: false,
    noEmitOnError: false,
    sourceMap: false,
  };
  return ts.createProgram({ options, rootNames: parsed.fileNames });
}

/** `UnifiedField` as `@UnifiedField(...)` or `@ns.UnifiedField(...)`. */
function unifiedFieldCall(ts, decorator) {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) {
    return undefined;
  }
  const callee = expression.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name === 'UnifiedField' ? expression : undefined;
}

function propertyName(ts, property) {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

/**
 * Whether the options already decide the type: `type`, `enum`, `isAny: true`. Options the script
 * cannot read (a variable, a spread, `isAny: someFlag`) count as deciding — it never guesses.
 */
function optionsDecideType(ts, options) {
  if (!options) {
    return false;
  }
  if (!ts.isObjectLiteralExpression(options)) {
    return true;
  }
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      return true;
    }
    const name = propertyName(ts, property);
    if (name === 'type' || name === 'enum') {
      return true;
    }
    if (
      name === 'isAny' &&
      !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      return true;
    }
  }
  return false;
}

function isArrayTypeNode(ts, node) {
  if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) {
    return true;
  }
  if (ts.isTypeOperatorNode(node)) {
    return isArrayTypeNode(ts, node.type);
  }
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    (node.typeName.text === 'Array' || node.typeName.text === 'ReadonlyArray')
  );
}

/** The import declaration that brings `symbol` into the file, or undefined for a local declaration. */
function importOf(ts, symbol) {
  const declaration = symbol.declarations?.[0];
  if (!declaration) {
    return undefined;
  }
  if (ts.isImportSpecifier(declaration)) {
    return { typeOnly: declaration.isTypeOnly || declaration.parent.parent.isTypeOnly };
  }
  if (ts.isImportClause(declaration)) {
    return { typeOnly: declaration.isTypeOnly };
  }
  if (ts.isNamespaceImport(declaration)) {
    return { typeOnly: declaration.parent.isTypeOnly };
  }
  return undefined;
}

function isLibDate(symbol) {
  return (
    symbol?.getName() === 'Date' &&
    (symbol.declarations ?? []).some((d) => /[\\/]typescript[\\/]lib[\\/]lib\./.test(d.getSourceFile().fileName))
  );
}

/**
 * Whether both compilers emit the same runtime type for this annotation: a primitive keyword,
 * `Date`, or a class the file has as a value (declared here, or imported without `type`).
 */
function emitsTheSameType(ts, checker, node) {
  if (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword
  ) {
    return true;
  }
  // `'a' | 'b'` written out in place: SWC emits String like tsc (measured). Not so with null/undefined in the union
  if (
    ts.isUnionTypeNode(node) &&
    node.types.every((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
  ) {
    return true;
  }
  if (!ts.isTypeReferenceNode(node) || node.typeArguments || !ts.isIdentifier(node.typeName)) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node.typeName);
  if (!symbol) {
    return false;
  }
  const imported = importOf(ts, symbol);
  if (imported?.typeOnly) {
    return false;
  }
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // An enum: SWC writes the enum object, which @UnifiedField reads as String / Number like tsc does (12.8.7)
  if (target.flags & ts.SymbolFlags.Enum) {
    return true;
  }
  return isLibDate(target) || (target.flags & ts.SymbolFlags.Class) !== 0;
}

function everyMember(type, predicate) {
  return type.isUnion() ? type.types.every(predicate) : predicate(type);
}

/**
 * The runtime type the tsc build emits for this field (null and undefined dropped), as the name to
 * put into `type: () => X` — or a reason why there is no such class.
 */
function resolveRuntimeType(ts, checker, property) {
  const declared = checker.getTypeAtLocation(property);
  const type = checker.getNonNullableType(declared);
  const flags = ts.TypeFlags;
  if (type.flags & (flags.Any | flags.Unknown)) {
    return { reason: 'any / unknown' };
  }
  if (everyMember(type, (t) => (t.flags & flags.NumberLike) !== 0)) {
    return { name: 'Number' };
  }
  if (everyMember(type, (t) => (t.flags & flags.StringLike) !== 0)) {
    return { name: 'String' };
  }
  if (everyMember(type, (t) => (t.flags & flags.BooleanLike) !== 0)) {
    return { name: 'Boolean' };
  }
  if (type.isUnion()) {
    return { reason: 'a union of different types' };
  }
  const symbol = type.getSymbol();
  if (isLibDate(symbol)) {
    return { name: 'Date' };
  }
  if (symbol && symbol.flags & ts.SymbolFlags.Class) {
    const reference = classValueReference(ts, checker, property, symbol);
    return reference
      ? { name: reference }
      : {
          reason:
            `no value in this file refers to class ${symbol.getName()} (imported only as a type, or its name means ` +
            'something else here): import it as a value, then write type: () => <that name> yourself',
        };
  }
  if (symbol && symbol.flags & ts.SymbolFlags.Interface) {
    return { reason: `interface ${symbol.getName()}` };
  }
  return { reason: 'an object type without a runtime class (Record, object literal type, …)' };
}

/**
 * The text that refers to `classSymbol` as a value at this field — what `--fix` may write into `type: () => …` — or
 * undefined. Matched by symbol, never by name: a class imported under another name (`import { Settings as Tenant }`,
 * `import * as tenant`) next to a local class of the original name must get `Tenant` / `tenant.Settings`, not the local
 * class — writing that would change which class the deployed build validates and restricts the field with.
 *
 * 1. The reference the annotation itself writes (`Foo`, `Alias`, `ns.Foo`), when it resolves to the class and is not
 *    a type-only import.
 * 2. Otherwise the class's own name, when it resolves to that very class as a value here (`resolveName`).
 */
function classValueReference(ts, checker, property, classSymbol) {
  const target = (symbol) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const typeOnly = (symbol) => importOf(ts, symbol)?.typeOnly === true;
  const names = [];
  const collect = (node) => {
    if (ts.isTypeReferenceNode(node)) {
      names.push(node.typeName);
    }
    ts.forEachChild(node, collect);
  };
  if (property.type) {
    collect(property.type);
  }
  for (const name of names) {
    if (target(checker.getSymbolAtLocation(name)) !== classSymbol) {
      continue;
    }
    let head = name;
    while (ts.isQualifiedName(head)) {
      head = head.left;
    }
    const headSymbol = checker.getSymbolAtLocation(head);
    if (headSymbol && typeOnly(headSymbol)) {
      continue;
    }
    return name.getText();
  }
  if (typeof checker.resolveName === 'function') {
    const own = checker.resolveName(classSymbol.getName(), property, ts.SymbolFlags.Value, false);
    if (own && !typeOnly(own) && target(own) === classSymbol) {
      return classSymbol.getName();
    }
  }
  return undefined;
}

/** Why the SWC dev start cannot read this annotation like tsc does — for the report. */
function describeAnnotation(ts, checker, node) {
  if (!node) {
    return 'no type annotation';
  }
  if (ts.isUnionTypeNode(node)) {
    return 'a union';
  }
  if (ts.isLiteralTypeNode(node)) {
    return 'a literal type';
  }
  if (ts.isTypeReferenceNode(node)) {
    const symbol = ts.isIdentifier(node.typeName) ? checker.getSymbolAtLocation(node.typeName) : undefined;
    if (symbol && importOf(ts, symbol)?.typeOnly) {
      return 'a type-only import';
    }
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (target && target.flags & ts.SymbolFlags.Enum) {
      return 'an enum';
    }
    if (target && target.flags & ts.SymbolFlags.TypeAlias) {
      return 'a type alias';
    }
    if (target && target.flags & ts.SymbolFlags.Interface) {
      return 'an interface';
    }
    return node.typeArguments ? 'a generic type' : 'a type reference';
  }
  return 'a type expression';
}

/** The edit that adds `type: () => <name>` to the decorator call's options. */
function typeOptionEdit(ts, sourceFile, call, name) {
  const insertion = `type: () => ${name}`;
  const text = sourceFile.text;
  const options = call.arguments[0];
  if (!options) {
    return { end: call.arguments.pos, start: call.arguments.pos, text: `{ ${insertion} }` };
  }
  const properties = options.properties;
  if (properties.length === 0) {
    return { end: options.end, start: options.getStart(sourceFile), text: `{ ${insertion} }` };
  }
  // What precedes a property on its line: only its indentation when it starts the line, code otherwise
  const linePrefix = (node) => {
    const start = node.getStart(sourceFile);
    return text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  };
  const ownLine = (node) => /^[ \t]*$/.test(linePrefix(node));
  // Keys are kept in alphabetical order in the stack's code; insert before the first one after `type`
  const next = properties.find((property) => (propertyName(ts, property) ?? '') > 'type');
  if (next) {
    const start = next.getStart(sourceFile);
    return { end: start, start, text: ownLine(next) ? `${insertion},\n${linePrefix(next)}` : `${insertion}, ` };
  }
  const last = properties[properties.length - 1];
  const between = text.slice(last.end, options.end - 1);
  const comma = between.trimStart().startsWith(',') ? last.end + between.indexOf(',') + 1 : undefined;
  if (ownLine(last)) {
    const indentOf = linePrefix;
    return comma === undefined
      ? { end: last.end, start: last.end, text: `,\n${indentOf(last)}${insertion}` }
      : { end: comma, start: comma, text: `\n${indentOf(last)}${insertion},` };
  }
  return comma === undefined
    ? { end: last.end, start: last.end, text: `, ${insertion}` }
    : { end: comma, start: comma, text: ` ${insertion}` };
}

/**
 * The `design:type` expression tsc writes for each decorated property of these files, read from an in-memory emit
 * (the writeFile callback keeps it off the disk): Map<sourceFile, Map<"Class.property", expression>>.
 */
function emittedDesignTypes(program, sourceFiles) {
  const result = new Map();
  for (const sourceFile of sourceFiles) {
    let js = '';
    program.emit(sourceFile, (name, text) => {
      if (/\.[cm]?js$/.test(name)) {
        js = text;
      }
    });
    const types = new Map();
    // `__decorate([` / `(0, tslib_1.__decorate)([` (importHelpers), the same for `__metadata`
    for (const match of js.matchAll(/__decorate\)?\(\[([\s\S]*?)\],\s*([\w$]+)\.prototype,\s*"([^"]+)"/g)) {
      const metadata = /__metadata\)?\("design:type",\s*([\s\S]*?)\)\s*(?:,|$)/.exec(match[1]);
      if (metadata) {
        types.set(`${match[2]}.${match[3]}`, metadata[1].trim());
      }
    }
    result.set(sourceFile, types);
  }
  return result;
}

/** A design:type as a comparable kind: the primitive constructor's name, `class` for a class reference, or undefined. */
function designTypeKind(expression) {
  if (!expression) {
    return undefined;
  }
  const primitive = /^(Number|String|Boolean|Date|Object|Array|Function)$/.exec(expression);
  return primitive ? primitive[1] : 'class';
}

function analyze(ts, program, cwd, include) {
  const checker = program.getTypeChecker();
  const roots = include.map((dir) => path.resolve(cwd, dir) + path.sep);
  const findings = [];
  for (const sourceFile of program.getSourceFiles()) {
    const fileName = path.resolve(sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile ||
      fileName.includes(`${path.sep}node_modules${path.sep}`) ||
      /\.(spec|test)\.[cm]?tsx?$/.test(fileName) ||
      !roots.some((root) => fileName.startsWith(root))
    ) {
      continue;
    }
    const visit = (node) => {
      if (ts.isPropertyDeclaration(node) && ts.canHaveDecorators(node)) {
        for (const decorator of ts.getDecorators(node) ?? []) {
          const call = unifiedFieldCall(ts, decorator);
          if (!call || optionsDecideType(ts, call.arguments[0])) {
            continue;
          }
          if (node.type && (isArrayTypeNode(ts, node.type) || emitsTheSameType(ts, checker, node.type))) {
            continue;
          }
          const owner = node.parent && ts.isClassLike(node.parent) && node.parent.name ? node.parent.name.text : '?';
          const resolved = resolveRuntimeType(ts, checker, node);
          findings.push({
            call,
            field: `${owner}.${propertyName(ts, node) ?? '?'}`,
            owner,
            property: propertyName(ts, node),
            fileName,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            hint: resolved.reason,
            name: resolved.name,
            reason: describeAnnotation(ts, checker, node.type),
            sourceFile,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Whether a written type changes the deployed build: compare it with what tsc's own emit writes for the field
  const files = [...new Set(findings.filter((f) => f.name).map((f) => f.sourceFile))];
  const emitted = emittedDesignTypes(program, files);
  for (const finding of findings.filter((f) => f.name)) {
    const deployed = emitted.get(finding.sourceFile)?.get(`${finding.owner}.${finding.property}`);
    finding.changesDeployed = designTypeKind(deployed) !== designTypeKind(finding.name);
  }
  return findings;
}

/**
 * Writes the edits. Their positions refer to the text TypeScript parsed, which has a leading UTF-8 BOM stripped — so
 * they are shifted by the BOM, which stays in the file. A file whose text no longer matches what was parsed (changed
 * since) is left untouched and returned in `skipped`.
 */
function applyFixes(ts, findings) {
  const byFile = new Map();
  for (const finding of findings.filter((f) => f.name)) {
    const entry = byFile.get(finding.fileName) ?? { edits: [], sourceFile: finding.sourceFile };
    entry.edits.push(typeOptionEdit(ts, finding.sourceFile, finding.call, finding.name));
    byFile.set(finding.fileName, entry);
  }
  const written = [];
  const skipped = [];
  for (const [fileName, { edits, sourceFile }] of byFile) {
    let text = fs.readFileSync(fileName, 'utf8');
    const offset = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (text.slice(offset) !== sourceFile.text) {
      skipped.push(fileName);
      continue;
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, edit.start + offset) + edit.text + text.slice(edit.end + offset);
    }
    fs.writeFileSync(fileName, text);
    written.push(fileName);
  }
  return { skipped, written };
}

function main(argv, cwd = process.cwd(), out = console) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    out.error(`${PREFIX} ${error.message}\n${usage()}`);
    return 2;
  }
  if (args.help) {
    out.log(usage());
    return 0;
  }
  let findings;
  const ts = loadTypeScript(cwd);
  try {
    findings = analyze(ts, createProgram(ts, cwd, args.project), cwd, args.include);
  } catch (error) {
    if (error instanceof UsageError) {
      out.error(`${PREFIX} ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (findings.length === 0) {
    out.log(`${PREFIX} OK — every @UnifiedField has a runtime type both compilers agree on.`);
    return 0;
  }
  const fixable = findings.filter((f) => f.name);
  const manual = findings.filter((f) => !f.name);
  if (args.fix && fixable.length > 0) {
    const { skipped, written } = applyFixes(ts, fixable);
    if (skipped.length > 0) {
      for (const fileName of skipped) {
        out.error(`${PREFIX} ${path.relative(cwd, fileName)} changed while the check ran — left untouched, run again`);
      }
      return 1;
    }
    out.log(`${PREFIX} fixed ${fixable.length} field(s) in ${written.length} file(s):`);
  } else if (fixable.length > 0) {
    out.log(`${PREFIX} ${fixable.length} field(s) need an explicit type (\`--fix\` writes it):`);
  }
  for (const f of fixable) {
    const marker = f.changesDeployed ? '  [changes the deployed build]' : '';
    out.log(`  ${path.relative(cwd, f.fileName)}:${f.line}  ${f.field} (${f.reason}) → type: () => ${f.name}${marker}`);
  }
  if (fixable.some((f) => f.changesDeployed)) {
    out.log(
      '  [changes the deployed build]: the tsc build writes a different type for this field today — Object for a ' +
        'union with null / undefined under strictNullChecks (the default without a `strict` key since TypeScript 6), ' +
        'for a generic alias, for a field without a type annotation. The written type is the one the field declares, ' +
        'so the deployed API validates it differently from now on. Review those fields.',
    );
  }
  if (manual.length > 0) {
    out.log(`${PREFIX} ${manual.length} field(s) to declare by hand — no runtime class to write automatically:`);
    for (const f of manual) {
      out.log(`  ${path.relative(cwd, f.fileName)}:${f.line}  ${f.field} (${f.reason}) — ${f.hint}`);
    }
    out.log(
      '  Declare `type: () => Object` for a free-form object, `isAny: true` for any value, or a class for a nested ' +
        'structure (its @UnifiedField fields are then validated and @Restricted is enforced on them).',
    );
  }
  out.log(
    `${PREFIX} Why: without \`type\`, @UnifiedField reads the compiler's design:type, which the SWC dev start writes ` +
      'as Object for a union with null / undefined, a type alias or an interface — the dev API then validates such a ' +
      'field as a nested object. For every field not marked, --fix writes exactly the type the tsc build writes ' +
      '(read from its emit), so the deployed API keeps its behaviour.',
  );
  return args.fix ? (manual.length > 0 ? 1 : 0) : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
