import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getEnvironmentConfig, loadLocalConfigFile } from '../../src/core/common/helpers/config.helper';

/**
 * `loadLocalConfig` — a `config.json` (or a named file) merged over the environment configuration.
 *
 * @regression   12.0.0 (pre-existing) — the file was loaded with `import()` relative to the config helper's OWN
 *   directory, so `true` searched `dist/core/common/helpers` and `dist/core/common` (inside node_modules in npm mode)
 *   and never the project, and the merge ran asynchronously, after `getEnvironmentConfig()` had returned.
 * @seen-failing Search next to the helper again — registered as mutation `local-config-searched-in-helper-dir` — or
 *   merge after returning — registered as `local-config-merged-after-return`, both in tests/regression-mutations.json.
 */
const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe('loadLocalConfigFile', () => {
  it('true: reads config.json from the project directory, then src/config.json', () => {
    const dir = project();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.json'), '{"from":"src"}');
    expect(loadLocalConfigFile(true, dir)).toEqual({ from: 'src' });

    writeFileSync(join(dir, 'config.json'), '{"from":"root"}');
    expect(loadLocalConfigFile(true, dir)).toEqual({ from: 'root' });
  });

  it('a path: resolves against the project directory, JSON as JSON, anything else as a module', () => {
    const dir = project();
    writeFileSync(join(dir, 'local.json'), '{"port":4711}');
    writeFileSync(join(dir, 'local.cjs'), 'module.exports = { default: { port: 4712 } };');
    expect(loadLocalConfigFile('local.json', dir)).toEqual({ port: 4711 });
    expect(loadLocalConfigFile('./local.cjs', dir)).toEqual({ port: 4712 });
  });

  it('nothing configured or nothing there: no local configuration', () => {
    const dir = project();
    expect(loadLocalConfigFile(false, dir)).toBeUndefined();
    expect(loadLocalConfigFile(true, dir)).toBeUndefined();
    expect(loadLocalConfigFile('missing.json', dir)).toBeUndefined();
  });
});

describe('getEnvironmentConfig with loadLocalConfig', () => {
  it('returns the configuration with the local file already merged in', () => {
    const file = join(project(), 'local.json');
    writeFileSync(file, '{"port":4713,"nested":{"added":true}}');
    const base = { loadLocalConfig: file, nested: { kept: true }, port: 3000 };

    const config = getEnvironmentConfig({ config: { local: { ...base }, test: { ...base } } });

    expect(config.port).toBe(4713);
    expect(config.nested).toEqual({ added: true, kept: true });
  });
});
