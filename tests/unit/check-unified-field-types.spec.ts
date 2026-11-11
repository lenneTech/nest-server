/**
 * `bin/check-unified-field-types.js` — every `@UnifiedField` gets a runtime type both compilers agree on.
 *
 * Without `type`, `@UnifiedField` reads `design:type`. The SWC loader of the dev start writes it syntactically, so a
 * union with null (also with an enum), a type alias or `boolean | null` become `Object` there, where the tsc build writes
 * `Number` / `String` / `Boolean` (measured against nest-server's loader, `strict: false`). A plain enum is not a
 * finding: SWC writes the enum object, which `@UnifiedField` reads like tsc since 12.8.7. The script
 * must flag exactly those fields, leave the ones both compilers agree on alone, and write with `--fix` the type the tsc
 * build already uses — so the deployed behaviour stays and the dev start matches it.
 *
 * Runs the script in-process against a fixture project written to a temporary directory.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { main } = require('../../bin/check-unified-field-types.js') as {
  main: (argv: string[], cwd: string, out: { error: (m: string) => void; log: (m: string) => void }) => number;
};

const TSCONFIG = {
  compilerOptions: {
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    module: 'commonjs',
    skipLibCheck: true,
    strict: false,
    target: 'es2022',
    types: [],
  },
  include: ['src'],
};

const DECORATOR = `export const UnifiedField = (_options?: Record<string, unknown>): PropertyDecorator => () => undefined;\n`;

const KINDS = `export type Kind = 'a' | 'b';
export type Count = number;
export enum Status { A = 'a', B = 'b' }
export class Address { street?: string; }
`;

const MODEL = `import { UnifiedField } from './decorator';
import { Address, Count, Kind, Status } from './kinds';

export class Model {
  // Both compilers agree — never reported
  @UnifiedField() plain?: number;
  @UnifiedField() when?: Date;
  @UnifiedField() address?: Address;
  @UnifiedField() state?: 'ok' | 'error';
  @UnifiedField() list?: string[];
  @UnifiedField({ type: () => Number }) typed?: null | number;
  @UnifiedField({ isAny: true }) anything?: any;
  @UnifiedField({ enum: Status }) withEnum?: Status;
  @UnifiedField() plainStatus?: Status;

  // SWC writes Object (or the enum object) where tsc writes a primitive — fixable
  @UnifiedField() max?: null | number;
  @UnifiedField({ description: 'kind' }) kind?: Kind;
  @UnifiedField({ description: 'count', roles: 'admin' }) count?: Count;
  @UnifiedField({
    description: 'total',
    validator: undefined,
  })
  total?: Count;
  @UnifiedField({}) flag?: boolean | null;
  @UnifiedField() maybeStatus?: Status | null;

  // No runtime class to write — reported for the developer
  @UnifiedField() meta?: Record<string, unknown>;
  @UnifiedField() mixed?: string | number;
}
`;

const TYPE_ONLY = `import { UnifiedField } from './decorator';
import type { Address } from './kinds';

export class Holder {
  @UnifiedField() address?: Address;
}
`;

function captureOutput() {
  const lines: string[] = [];
  return { lines, out: { error: (m: string) => lines.push(m), log: (m: string) => lines.push(m) } };
}

describe('check-unified-field-types', () => {
  let dir: string;

  const write = (files: Record<string, string>) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, 'src', name), content);
    }
  };
  const read = (name: string) => readFileSync(join(dir, 'src', name), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'unified-field-types-'));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  /**
   * @regression   12.8.6 — the SWC dev start read `max?: null | number` (and type aliases, enums, `boolean | null`) as
   *   Object, so the dev API refused `max: 5` while the tsc build accepted it; nothing pointed at the field.
   * @seen-failing Treat every type reference as safe in emitsTheSameType() (bin/check-unified-field-types.js) —
   *   registered as mutation `unified-field-types-trusts-every-reference` in tests/regression-mutations.json.
   */
  it('reports exactly the fields the two compilers disagree on, without touching a file', () => {
    write({ 'decorator.ts': DECORATOR, 'kinds.ts': KINDS, 'model.ts': MODEL });
    const { lines, out } = captureOutput();

    expect(main([], dir, out)).toBe(1);

    const report = lines.join('\n');
    for (const [field, type] of [
      ['Model.max', 'Number'],
      ['Model.kind', 'String'],
      ['Model.count', 'Number'],
      ['Model.total', 'Number'],
      ['Model.flag', 'Boolean'],
      ['Model.maybeStatus', 'String'],
    ]) {
      expect(report).toContain(`${field} (`);
      expect(report).toMatch(new RegExp(`${field.replace('.', '\\.')} \\([^)]+\\) → type: \\(\\) => ${type}`));
    }
    expect(report).toContain('Model.meta (');
    expect(report).toContain('Model.mixed (');
    // `plainStatus`: SWC writes the enum object, which @UnifiedField reads as String like tsc
    for (const field of ['plain', 'when', 'address', 'state', 'list', 'typed', 'anything', 'withEnum', 'plainStatus']) {
      expect(report).not.toContain(`Model.${field} (`);
    }
    expect(read('model.ts')).toBe(MODEL);
  });

  it('writes the type the tsc build uses with --fix, and leaves the rest to the developer', () => {
    write({ 'decorator.ts': DECORATOR, 'kinds.ts': KINDS, 'model.ts': MODEL });

    // Fields without a runtime class remain, so the run still fails
    expect(main(['--fix'], dir, captureOutput().out)).toBe(1);

    const fixed = read('model.ts');
    expect(fixed).toContain('@UnifiedField({ type: () => Number }) max?: null | number;');
    expect(fixed).toContain("@UnifiedField({ description: 'kind', type: () => String }) kind?: Kind;");
    expect(fixed).toContain(
      "@UnifiedField({ description: 'count', roles: 'admin', type: () => Number }) count?: Count;",
    );
    // Multi-line options: inserted in alphabetical position, with the surrounding indentation
    expect(fixed).toContain("    description: 'total',\n    type: () => Number,\n    validator: undefined,\n");
    expect(fixed).toContain('@UnifiedField({ type: () => Boolean }) flag?: boolean | null;');
    expect(fixed).toContain('@UnifiedField({ type: () => String }) maybeStatus?: Status | null;');
    expect(fixed).toContain('@UnifiedField() plainStatus?: Status;');
    // Fields both compilers agree on are untouched
    expect(fixed).toContain('@UnifiedField() plain?: number;');
    expect(fixed).toContain("@UnifiedField() state?: 'ok' | 'error';");
    // Still valid TypeScript
    expect(ts.transpileModule(fixed, { reportDiagnostics: true }).diagnostics).toEqual([]);

    // A second run finds only what needs a developer's decision
    const { lines, out } = captureOutput();
    expect(main([], dir, out)).toBe(1);
    const report = lines.join('\n');
    expect(report).not.toContain('`--fix` writes it');
    expect(report).toContain('Model.meta (');
    expect(report).toContain('Model.mixed (');
  });

  /**
   * @regression   12.8.7 (found in review) — TypeScript strips a leading UTF-8 BOM from the text it parses, so the
   *   edit positions were one character early in a file that starts with one: `roles: 'admin'` became
   *   `roles: 'admin, type: () => Number'` — still valid TypeScript, a role nobody holds, and exit code 0.
   * @seen-failing Ignore the BOM offset in applyFixes() (bin/check-unified-field-types.js) — registered as mutation
   *   `unified-field-types-ignores-bom` in tests/regression-mutations.json.
   */
  it('writes into a file that starts with a UTF-8 BOM at the right positions, keeping the BOM', () => {
    write({ 'decorator.ts': DECORATOR, 'kinds.ts': KINDS, 'model.ts': `﻿${MODEL}` });

    main(['--fix'], dir, captureOutput().out);

    const fixed = read('model.ts');
    expect(fixed.charCodeAt(0)).toBe(0xfeff);
    expect(fixed).toContain('@UnifiedField({ type: () => Number }) max?: null | number;');
    expect(fixed).toContain(
      "@UnifiedField({ description: 'count', roles: 'admin', type: () => Number }) count?: Count;",
    );
    const { lines, out } = captureOutput();
    main([], dir, out);
    expect(lines.join('\n')).not.toContain('`--fix` writes it');
  });

  it('does not write a class the file only imports as a type', () => {
    write({ 'decorator.ts': DECORATOR, 'holder.ts': TYPE_ONLY, 'kinds.ts': KINDS });
    const { lines, out } = captureOutput();

    expect(main(['--fix'], dir, out)).toBe(1);
    expect(lines.join('\n')).toMatch(/Holder\.address \(a type-only import\)/);
    expect(read('holder.ts')).toBe(TYPE_ONLY);
  });

  /**
   * @regression   12.8.7 (found in review) — `--fix` picked the class by its name, so a class imported under another
   *   name (`import { Settings as TenantSettings }`, `import * as tenant`) next to a local class `Settings` got
   *   `type: () => Settings` — the local class. The deployed build would then validate and restrict the field with
   *   the wrong class.
   * @seen-failing Make classValueReference() return the class's own name (bin/check-unified-field-types.js) —
   *   registered as mutation `unified-field-types-fixes-class-by-name` in tests/regression-mutations.json.
   */
  it('writes the reference that means the class, never a same-named local class', () => {
    write({
      'decorator.ts': DECORATOR,
      'shadow.ts': `import { UnifiedField } from './decorator';
import { Settings as TenantSettings } from './tenant';
import * as tenant from './tenant';

export class Settings { local?: string; }
type MaybeTenant = TenantSettings | null;

export class Shadow {
  @UnifiedField() renamed?: TenantSettings | null;
  @UnifiedField() namespaced?: tenant.Settings | null;
  @UnifiedField() local?: Settings | null;
  @UnifiedField() viaAlias?: MaybeTenant;
}
`,
      'tenant.ts': 'export class Settings { theme?: string; }\n',
    });
    const { lines, out } = captureOutput();

    // `viaAlias` names no value that means the tenant class here, so it is left to the developer
    expect(main(['--fix'], dir, out)).toBe(1);

    const fixed = read('shadow.ts');
    expect(fixed).toContain('@UnifiedField({ type: () => TenantSettings }) renamed?: TenantSettings | null;');
    expect(fixed).toContain('@UnifiedField({ type: () => tenant.Settings }) namespaced?: tenant.Settings | null;');
    expect(fixed).toContain('@UnifiedField({ type: () => Settings }) local?: Settings | null;');
    expect(fixed).toContain('@UnifiedField() viaAlias?: MaybeTenant;');
    expect(lines.join('\n')).toMatch(
      /Shadow\.viaAlias \(a type alias\) — no value in this file refers to class Settings/,
    );
  });

  it('marks a fix that changes the deployed build: a union with null under strictNullChecks', () => {
    const model = `import { UnifiedField } from './decorator';
export class Limits {
  @UnifiedField() max?: null | number;
  @UnifiedField() total?: Total;
}
type Total = number;
`;
    write({ 'decorator.ts': DECORATOR, 'limits.ts': model });
    const loose = captureOutput();
    expect(main([], dir, loose.out)).toBe(1);
    expect(loose.lines.join('\n')).not.toContain('[changes the deployed build]');

    // Under strictNullChecks tsc writes Object for `null | number` too — writing Number changes the deployed API
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ ...TSCONFIG, compilerOptions: { ...TSCONFIG.compilerOptions, strict: true } }),
    );
    const strict = captureOutput();
    expect(main(['--fix'], dir, strict.out)).toBe(0);
    const report = strict.lines.join('\n');
    expect(report).toMatch(/Limits\.max \(a union\) → type: \(\) => Number {2}\[changes the deployed build\]/);
    // A plain alias is no union with null: tsc writes Number for it in either mode
    expect(report).toMatch(/Limits\.total \(a type alias\) → type: \(\) => Number$/m);
  });

  /**
   * @regression   12.8.7 (found in review) — the deployed-build marker was a guess from `strictNullChecks` alone:
   *   TypeScript 6 is strict without a `strict` key, and tsc writes Object for a generic alias or a field without
   *   annotation in any mode — `--fix` changed those deployed fields silently.
   * @seen-failing Never mark a fix as changing the deployed build in analyze() (bin/check-unified-field-types.js) —
   *   registered as mutation `unified-field-types-ignores-deployed-metadata` in tests/regression-mutations.json.
   */
  it('marks every fix whose type differs from what the tsc build writes, read from its emit', () => {
    const model = `import { UnifiedField } from './decorator';
type Nullable<T> = T | null;
type Total = number;
export class Probe {
  @UnifiedField() generic?: Nullable<number>;
  @UnifiedField() count = 0;
  @UnifiedField() total?: Total;
}
export class Strictish {
  @UnifiedField() max?: number | null;
}
`;
    write({ 'decorator.ts': DECORATOR, 'probe.ts': model });
    // TypeScript 6: no `strict` key means strict
    const { strict: _strict, ...noStrictKey } = TSCONFIG.compilerOptions;
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ ...TSCONFIG, compilerOptions: noStrictKey }));
    const { lines, out } = captureOutput();

    expect(main([], dir, out)).toBe(1);
    const report = lines.join('\n');
    for (const field of ['Probe.generic', 'Probe.count', 'Strictish.max']) {
      expect(report).toMatch(
        new RegExp(
          `${field.replace('.', '\\.')} \\([^)]+\\) → type: \\(\\) => Number {2}\\[changes the deployed build\\]`,
        ),
      );
    }
    expect(report).toMatch(/Probe\.total \(a type alias\) → type: \(\) => Number$/m);
  });

  /**
   * @regression   12.8.7 (found in review) — the inserted line copied everything before the next property on its line,
   *   so `@UnifiedField({ validator: …` turned into a second decorator, and `description: 'a', isOptional: true })`
   *   into a duplicated key.
   * @seen-failing Treat every property as starting its own line in typeOptionEdit() (bin/check-unified-field-types.js)
   *   — registered as mutation `unified-field-types-indents-with-code` in tests/regression-mutations.json.
   */
  it('inserts inline where a property shares its line with code', () => {
    const model = `import { UnifiedField } from './decorator';
import { Count } from './kinds';
export class Layout {
  @UnifiedField({ validator: undefined,
    description: 'shared' })
  shared?: Count;
  @UnifiedField({
    description: 'tail', isOptional: true })
  tail?: Count;
}
`;
    write({ 'decorator.ts': DECORATOR, 'kinds.ts': KINDS, 'layout.ts': model });
    const { lines, out } = captureOutput();

    expect(main(['--fix'], dir, out)).toBe(0);
    const fixed = read('layout.ts');
    expect(fixed).toContain('@UnifiedField({ type: () => Number, validator: undefined,');
    expect(fixed).toContain("description: 'tail', isOptional: true, type: () => Number })");
    expect(fixed.match(/@UnifiedField/g)).toHaveLength(2);
    expect(fixed.match(/description: 'tail'/g)).toHaveLength(1);
    expect(lines.join('\n')).toContain('Layout.shared');
    expect(ts.transpileModule(fixed, { reportDiagnostics: true }).diagnostics).toEqual([]);
  });

  /**
   * @regression   12.8.7 (found in review) — `isAny: false` ended the scan of the decorator options, so a `type` after
   *   it went unseen: the field was reported, and `--fix` wrote a second `type` key (TS1117).
   * @seen-failing Return as soon as the scan meets `isAny` in optionsDecideType() (bin/check-unified-field-types.js) —
   *   registered as mutation `unified-field-types-isany-false-stops-reading` in tests/regression-mutations.json.
   */
  it('reads the options past isAny: false, so a type after it decides the field', () => {
    const model = `import { UnifiedField } from './decorator';
export class Flags {
  @UnifiedField({ isAny: false, type: () => Number }) both?: null | number;
  @UnifiedField({ isAny: false }) open?: null | number;
}
`;
    write({ 'decorator.ts': DECORATOR, 'flags.ts': model });
    const { lines, out } = captureOutput();

    expect(main(['--fix'], dir, out)).toBe(0);
    const fixed = read('flags.ts');
    expect(fixed).toContain('@UnifiedField({ isAny: false, type: () => Number }) both?: null | number;');
    expect(fixed).toContain('@UnifiedField({ isAny: false, type: () => Number }) open?: null | number;');
    expect(lines.join('\n')).not.toContain('Flags.both');
    expect(ts.transpileModule(fixed, { reportDiagnostics: true }).diagnostics).toEqual([]);
  });

  /**
   * @regression   12.9.0 (DEV-4182) — a mixed enum (string and number members) counted as a plain enum, so `check`
   *   passed while @UnifiedField refuses the field at boot: SWC writes the enum object, tsc writes Object, and neither
   *   reads as String / Number.
   * @seen-failing Treat every enum as safe in emitsTheSameType() (bin/check-unified-field-types.js) — registered as
   *   mutation `unified-field-types-trusts-mixed-enum` in tests/regression-mutations.json.
   */
  it('reports a field typed with a mixed enum, and leaves an enum of strings or of numbers alone', () => {
    const model = `import { UnifiedField } from './decorator';
enum Mixed { Low = 0, High = 'high' }
enum Level { Low = 1, High = 2 }
enum Mode { On = 'on', Off = 'off' }
export class Settings {
  @UnifiedField() mixed?: Mixed;
  @UnifiedField() level?: Level;
  @UnifiedField() mode?: Mode;
}
`;
    write({ 'decorator.ts': DECORATOR, 'settings.ts': model });
    const { lines, out } = captureOutput();

    expect(main([], dir, out)).toBe(1);
    const report = lines.join('\n');
    expect(report).toMatch(/Settings\.mixed \(an enum\)/);
    expect(report).not.toContain('Settings.level');
    expect(report).not.toContain('Settings.mode');
  });

  it('checks spec and test files too, since the boot refuses such a field wherever it is declared', () => {
    const fixture = `import { UnifiedField } from './decorator';
export class Fixture {
  @UnifiedField() max?: null | number;
}
`;
    write({
      'decorator.ts': DECORATOR,
      'fixture.spec.ts': fixture,
      'story.test.ts': fixture.replace('Fixture', 'Story'),
    });
    const { lines, out } = captureOutput();

    expect(main([], dir, out)).toBe(1);
    expect(lines.join('\n')).toMatch(/Fixture\.max/);
    expect(lines.join('\n')).toMatch(/Story\.max/);
  });

  it('passes a project whose fields both compilers read alike', () => {
    write({
      'decorator.ts': DECORATOR,
      'kinds.ts': KINDS,
      'model.ts': `import { UnifiedField } from './decorator';
import { Address } from './kinds';
export class Clean {
  @UnifiedField() a?: number;
  @UnifiedField() b?: Address;
  @UnifiedField({ type: () => Object }) c?: Record<string, unknown>;
}
`,
    });
    const { lines, out } = captureOutput();

    expect(main([], dir, out)).toBe(0);
    expect(lines.join('\n')).toContain('OK');
  });

  /**
   * @regression   12.8.7 (found in review) — `pnpm run check:unified-field-types -- --fix` hands the script
   *   `['--', '--fix']` (npm drops the separator); the parser refused `--` with exit code 2, so `check:fix` and
   *   `check:naf` stopped before `format`.
   * @seen-failing Drop the `--` branch in parseArgs() (bin/check-unified-field-types.js) — registered as mutation
   *   `unified-field-types-refuses-double-dash` in tests/regression-mutations.json.
   */
  it('accepts the `--` separator pnpm passes through', () => {
    write({ 'decorator.ts': DECORATOR, 'kinds.ts': KINDS, 'model.ts': MODEL });

    expect(main(['--', '--fix'], dir, captureOutput().out)).toBe(1);
    expect(read('model.ts')).toContain('@UnifiedField({ type: () => Number }) max?: null | number;');
  });

  it('answers a usage error with exit code 2', () => {
    write({ 'decorator.ts': DECORATOR });

    expect(main(['--unknown'], dir, captureOutput().out)).toBe(2);
    expect(main(['--project', 'missing.json'], dir, captureOutput().out)).toBe(2);
  });
});
