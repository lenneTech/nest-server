import { Logger } from '@nestjs/common';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { IServerOptions } from '../../src/core/common/interfaces/server-options.interface';
import { ConfigService } from '../../src/core/common/services/config.service';
import { CoreS3Service } from '../../src/core/common/services/core-s3.service';
import { resolveFileStorage } from '../../src/core/modules/file/file-storage.helper';

/**
 * Pins ONE invariant: `CoreS3Service.enabled` and `resolveFileStorage()` must
 * agree on whether S3 is usable.
 *
 * They are consulted by different modules for different decisions — the file
 * module asks the resolver which driver to write through, `tus.s3Staging`
 * (default `true`) keys off `enabled` to decide where to stage chunks. When the
 * two disagree, a bucket-less `s3` block sends the file module to GridFS while
 * tus stages to S3 with `stagingBucket: undefined`, and the failure only appears
 * at the first upload — `verifyBuckets()` deliberately logs rather than throws,
 * so the boot stays green.
 *
 * The shared rule: a bucket is required. Everything else about S3 has a fallback
 * (region defaults, the AWS credential chain resolves an IAM role), but "which
 * bucket" cannot be derived.
 */
const service = (s3: unknown): CoreS3Service => {
  ConfigService.setConfig({ env: 'test', s3 } as unknown as IServerOptions, { reInit: true });
  return new CoreS3Service(new ConfigService(ConfigService.configFastButReadOnly as any, { warn: false }));
};

const storageDriver = (s3: unknown): string => {
  ConfigService.setConfig(
    { env: 'test', mongoose: { uri: 'mongodb://localhost/test' }, s3 } as unknown as IServerOptions,
    { reInit: true },
  );
  return resolveFileStorage(ConfigService.configFastButReadOnly).driver;
};

describe('CoreS3Service.enabled ↔ resolveFileStorage agreement', () => {
  afterAll(() => {
    ConfigService.setConfig({ env: 'test' } as unknown as IServerOptions, { reInit: true });
  });

  it('both consider a bucket-bearing config usable', () => {
    expect(service({ bucket: 'my-bucket' }).enabled).toBe(true);
    expect(storageDriver({ bucket: 'my-bucket' })).toBe('s3');
  });

  it('neither considers a bucket-less config usable', () => {
    // The divergence this test exists for: `enabled` used to be true here, which
    // switched tus staging on against a bucket that does not exist.
    expect(service({ region: 'eu-central-1' }).enabled).toBe(false);
    expect(storageDriver({ region: 'eu-central-1' })).toBe('gridfs');
  });

  it('warns when an s3 block is ignored, rather than failing silently', () => {
    // Spy inside the test, not in beforeAll: the runner restores mocks between
    // tests, so a spy installed once would be gone by the time this runs.
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service({ region: 'eu-central-1' });
    const hits = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('no `bucket` is set'));
    expect(hits).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('neither considers an explicitly disabled config usable', () => {
    expect(service({ bucket: 'my-bucket', enabled: false }).enabled).toBe(false);
    expect(storageDriver({ bucket: 'my-bucket', enabled: false })).toBe('gridfs');
  });

  it('neither considers a missing config usable', () => {
    expect(service(undefined).enabled).toBe(false);
    expect(storageDriver(undefined)).toBe('gridfs');
  });

  it('defaults stagingBucket to the main bucket, so tus staging has a target', () => {
    // tus.s3Staging defaults to true, so whenever `enabled` is true the staging
    // bucket has to resolve to something.
    expect(service({ bucket: 'my-bucket' }).getConfig()?.stagingBucket).toBe('my-bucket');
    expect(service({ bucket: 'my-bucket', stagingBucket: 'staging' }).getConfig()?.stagingBucket).toBe('staging');
  });
});
