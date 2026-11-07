/**
 * `npm pack --json` changed shape between npm 11 (an array) and npm 12 (an object keyed by the package name). The
 * publish workflow runs npm 12 for Trusted Publishing (DEV-3143) while the runner's Node 24 ships npm 11, so the
 * manifest guard must read both — `JSON.parse(raw)[0].files` threw under npm 12.
 */
import { describe, expect, it } from 'vitest';

import { packedFilesFromNpmPackJson } from '../../scripts/npm-pack-json.mjs';

const files = [{ path: 'dist/index.js' }, { path: 'package.json' }];

describe('packedFilesFromNpmPackJson', () => {
  it('reads npm 11 output (an array with one entry)', () => {
    expect(
      packedFilesFromNpmPackJson(
        JSON.stringify([{ files, name: '@lenne.tech/nest-server' }]),
        '@lenne.tech/nest-server',
      ),
    ).toEqual(['dist/index.js', 'package.json']);
  });

  it('reads npm 12 output (an object keyed by the package name)', () => {
    expect(
      packedFilesFromNpmPackJson(JSON.stringify({ '@lenne.tech/nest-server': { files } }), '@lenne.tech/nest-server'),
    ).toEqual(['dist/index.js', 'package.json']);
  });

  it('fails loudly instead of reporting an empty tarball when the shape is unknown', () => {
    expect(() => packedFilesFromNpmPackJson(JSON.stringify({}), '@lenne.tech/nest-server')).toThrow(/no file list/);
    expect(() => packedFilesFromNpmPackJson(JSON.stringify([{}]), '@lenne.tech/nest-server')).toThrow(/no file list/);
  });
});
