import { afterAll, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/core/common/services/config.service';

/**
 * Guards the config path that selects the file storage driver.
 *
 * `CoreFileService.s3Storage` and `CoreTusService.s3Storage` both resolve it with
 * `getFastButReadOnly<string>('file.storage')`. That is a STRING path, so nothing
 * in the compiler notices if it drifts from the interface — and the failure is
 * silent in the worst possible direction: an unreadable path returns `undefined`,
 * `undefined === 's3'` is false, and the service quietly keeps writing to GridFS
 * while the project believes its files are in S3.
 *
 * The setting moved from a top-level `fileStorage` to `file.storage` while the PR
 * that introduced it was still unreleased, which is exactly the kind of rename
 * that leaves a stale reader behind.
 */
const readStorage = (): string | undefined => ConfigService.getFastButReadOnly<string>('file.storage');

describe('file storage config path', () => {
  afterAll(() => {
    ConfigService.setConfig({ env: 'test' } as any, { reInit: true });
  });

  it('resolves file.storage when S3 is selected', () => {
    ConfigService.setConfig({ env: 'test', file: { storage: 's3' } } as any, { reInit: true });
    expect(readStorage()).toBe('s3');
  });

  it('resolves file.storage alongside the role knobs — one object, both concerns', () => {
    ConfigService.setConfig(
      { env: 'test', file: { downloadRoles: ['admin'], storage: 's3' } } as any,
      { reInit: true },
    );
    expect(readStorage()).toBe('s3');
    expect(ConfigService.getFastButReadOnly<string[]>('file.downloadRoles')).toEqual(['admin']);
  });

  it('answers undefined — i.e. GridFS — when file is absent', () => {
    ConfigService.setConfig({ env: 'test' } as any, { reInit: true });
    expect(readStorage()).toBeUndefined();
  });

  it('answers undefined when only the role knobs are set', () => {
    ConfigService.setConfig({ env: 'test', file: { downloadRoles: ['admin'] } } as any, { reInit: true });
    expect(readStorage()).toBeUndefined();
  });

  it('ignores the pre-release top-level `fileStorage` spelling', () => {
    // If someone reintroduces the old key, it must NOT quietly work — otherwise
    // two spellings drift apart and only one of them is documented.
    ConfigService.setConfig({ env: 'test', fileStorage: 's3' } as any, { reInit: true });
    expect(readStorage()).toBeUndefined();
  });
});
