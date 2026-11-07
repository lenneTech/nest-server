/**
 * Unit Tests: a request value that is an object never reaches a parameter declared as string, number or boolean, and
 * never stays in the parsed cookies (DEV-4144).
 *
 * The class of DEV-4138 and DEV-4143. `@Body('token') token: string` has `metatype === String`, and the pipe returned a
 * basic-type value unchecked, so `{ "token": { "$ne": null } }` reached the service as a MongoDB operator. cookie-parser
 * turns `iam.session_token=j:{"$ne":null}` into an object in `req.cookies`. Both were fixed per query (`isQueryableString()`); these two layers close the class for every
 * route and every cookie, including ones nobody has written yet.
 *
 * @regression   DEV-4144 — MapAndValidatePipe returned a plain object unchecked for a parameter declared as String /
 *   Number / Boolean, so a MongoDB operator reached the service.
 * @seen-failing Drop the `receivesObjectForPrimitive(value, metadata)` check from MapAndValidatePipe.transform() in
 *   src/core/common/pipes/map-and-validate.pipe.ts — registered as mutation `primitive-param-object-accepted` in
 *   tests/regression-mutations.json; make dropNonStringCookies() keep every value in
 *   src/core/common/middlewares/string-cookies.middleware.ts — registered as mutation `object-cookie-kept`.
 */
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dropNonStringCookies,
  StringCookiesMiddleware,
} from '../../src/core/common/middlewares/string-cookies.middleware';
import { MapAndValidatePipe, receivesObjectForPrimitive } from '../../src/core/common/pipes/map-and-validate.pipe';
import { ConfigService } from '../../src/core/common/services/config.service';

/** The operator shapes from DEV-4138 / DEV-4143 and the empty object */
const OPERATORS: [string, unknown][] = [
  ['{"$ne":null}', { $ne: null }],
  ['{"$regex":"^a"}', { $regex: '^a' }],
  ['{"$in":["a"]}', { $in: ['a'] }],
  ['{}', {}],
];

const metadata = (type: ArgumentMetadata['type'], metatype: unknown, data = 'token'): ArgumentMetadata =>
  ({ data, metatype, type }) as ArgumentMetadata;

async function pipeWith(config: unknown): Promise<MapAndValidatePipe> {
  vi.spyOn(ConfigService, 'getFastButReadOnly').mockReturnValue(config as never);
  return new MapAndValidatePipe();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MapAndValidatePipe: an object where the route declares a primitive is refused', () => {
  for (const type of ['body', 'query', 'param'] as const) {
    for (const metatype of [String, Number, Boolean]) {
      it.each(OPERATORS)(`answers 400 for %s at @${type} typed ${metatype.name}`, async (_label, value) => {
        const pipe = await pipeWith(undefined);

        await expect(pipe.transform(value, metadata(type, metatype))).rejects.toThrow(BadRequestException);
        await expect(pipe.transform(value, metadata(type, metatype))).rejects.toThrow(/LTNS_0306.*\[token\]/);
      });
    }
  }

  it('names the parameter in the error, or the source for a whole-body parameter', async () => {
    const pipe = await pipeWith(undefined);

    await expect(pipe.transform({ $ne: null }, metadata('body', String, 'email'))).rejects.toThrow(/\[email\]/);
    await expect(pipe.transform({ $ne: null }, { metatype: String, type: 'body' } as ArgumentMetadata)).rejects.toThrow(
      /\[body\]/,
    );
  });

  it('paired control: strings, numbers, booleans, null, undefined and arrays still pass unchanged', async () => {
    const pipe = await pipeWith(undefined);

    for (const value of ['a-token', '', 7, true, null, undefined, ['a', 'b']]) {
      await expect(pipe.transform(value, metadata('query', String))).resolves.toEqual(value);
    }
  });

  it('paired control: an object for a class, any or union parameter is not this check’s business', async () => {
    const pipe = await pipeWith(undefined);

    // `any` and `string | undefined` are emitted as Object; a class goes through DTO validation instead
    await expect(pipe.transform({ $ne: null }, metadata('body', Object))).resolves.toEqual({ $ne: null });
    expect(receivesObjectForPrimitive({ $ne: null }, metadata('body', class Dto {}))).toBe(false);
  });

  it('paired control: custom decorator parameters (@CurrentUser()) are never touched', async () => {
    const pipe = await pipeWith(undefined);
    const user = { id: 'u1' };

    await expect(pipe.transform(user, metadata('custom', String))).resolves.toBe(user);
  });

  it('is switched off only by an explicit `rejectObjectsForPrimitiveTypes: false`', async () => {
    const off = await pipeWith({ rejectObjectsForPrimitiveTypes: false });
    await expect(off.transform({ $ne: null }, metadata('body', String))).resolves.toEqual({ $ne: null });

    for (const config of [undefined, true, {}, { rejectObjectsForPrimitiveTypes: 'false' }]) {
      vi.restoreAllMocks();
      const on = await pipeWith(config);
      await expect(on.transform({ $ne: null }, metadata('body', String)), JSON.stringify(config)).rejects.toThrow(
        /LTNS_0306/,
      );
    }
  });
});

describe('StringCookiesMiddleware: no non-string value stays in the parsed cookies', () => {
  const parsed = () => ({
    cookies: {
      'iam.session_token': { $ne: null },
      legacyNumber: 7,
      list: ['a'],
      nul: null,
      plain: 'session-token.signature',
      truthy: true,
    } as Record<string, unknown>,
    signedCookies: { forged: false, nested: { $ne: null }, signed: 'value' } as Record<string, unknown>,
  });

  it('removes objects, numbers, booleans, arrays and null — what cookie-parser makes of a `j:` cookie', () => {
    const req = parsed();

    const removed = dropNonStringCookies(req);

    expect(req.cookies).toEqual({ plain: 'session-token.signature' });
    expect(removed.sort()).toEqual(['iam.session_token', 'legacyNumber', 'list', 'nested', 'nul', 'truthy']);
  });

  it("keeps a signed cookie's `false` (cookie-parser's invalid-signature marker) and every string", () => {
    const req = parsed();

    dropNonStringCookies(req);

    expect(req.signedCookies).toEqual({ forged: false, signed: 'value' });
  });

  it('copes with requests that carry no parsed cookies at all', () => {
    expect(dropNonStringCookies({})).toEqual([]);
    expect(dropNonStringCookies({ cookies: undefined, signedCookies: null })).toEqual([]);
  });

  it('runs on every request unless `security.stringCookiesOnly` is exactly `false`', () => {
    const run = (setting: unknown) => {
      const req = parsed();
      const next = vi.fn();
      new StringCookiesMiddleware({ getFastButReadOnly: () => setting } as never).use(req as never, {} as never, next);
      expect(next).toHaveBeenCalledTimes(1);
      return req.cookies;
    };

    expect(run(false)).toHaveProperty('iam.session_token');
    for (const setting of [undefined, true, 'false', 0]) {
      expect(run(setting), String(setting)).toEqual({ plain: 'session-token.signature' });
    }
  });
});
