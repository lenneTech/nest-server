import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Type-aware linting (12.0.0, as in NestJS 12's project template): `typescript/no-floating-promises` as an error.
 *
 * A type-aware rule needs both halves. Without `--type-aware` on the command line, or without `oxlint-tsgolint`
 * installed, oxlint skips the rule SILENTLY: the lint stays green and an un-awaited promise — whose rejection ends
 * the process — passes again. This spec pins the halves, because nothing else would notice one of them going.
 */
const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** `.oxlintrc.json` allows line comments; none of its strings contains `//` at the start of a line. */
function readOxlintConfig(): { rules: Record<string, unknown> } {
  const text = readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8');
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

describe('type-aware lint', () => {
  it('runs with --type-aware in both lint scripts', () => {
    expect(pkg.scripts.lint).toMatch(/\boxlint\b.*--type-aware/);
    expect(pkg.scripts['lint:fix']).toMatch(/\boxlint\b.*--type-aware/);
  });

  it('has the type-aware backend installed, with an exact pin', () => {
    expect(pkg.devDependencies['oxlint-tsgolint']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('treats a floating promise as an error', () => {
    expect(readOxlintConfig().rules['typescript/no-floating-promises']).toBe('error');
  });
});
