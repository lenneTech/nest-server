/**
 * The HTTP safety net strips secret fields under their SQL column names too.
 *
 * A row read through `store.native(reason)` / `store.raw(reason)` on a SQL source carries snake_case columns
 * (`passwordResetToken` → `password_reset_token`, `columnName()` in `common/persistence/sql/sql-naming.ts`). The
 * fallback in `CheckSecurityInterceptor` compared the camelCase names only, so a project route returning such a row
 * unchanged — `SELECT *`, `RETURNING *` — dropped `password` (spelled alike in both) and handed every other secret
 * to the client. The suite drives the REAL interceptor, as a request would reach it.
 */
import type { CallHandler } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { CheckSecurityInterceptor } from '../../src/core/common/interceptors/check-security.interceptor';

class NativeRowController {
  handler() {
    return undefined;
  }
}

/** The interceptor with the framework defaults plus a project's `security.secretFields`. */
function interceptor(projectSecretFields?: string[]): CheckSecurityInterceptor {
  const configService: any = {
    getFastButReadOnly: (key: string) => (key === 'security.secretFields' ? projectSecretFields : undefined),
  };
  return new CheckSecurityInterceptor(configService);
}

/** What a client receives when a REST handler returns `body`. */
async function respond(body: unknown, projectSecretFields?: string[]): Promise<any> {
  const request = { headers: {}, user: { id: 'u1' } };
  const context = new ExecutionContextHost(
    [request, {}, () => undefined],
    NativeRowController,
    NativeRowController.prototype.handler,
  );
  context.setType('http');
  const next: CallHandler = { handle: () => of(body) };
  return lastValueFrom(interceptor(projectSecretFields).intercept(context, next));
}

/** A users row as a native SQL query returns it. */
function nativeUserRow() {
  return {
    api_key_encrypted: 'enc:secret',
    created_at: '2026-11-04T00:00:00.000Z',
    email: 'user@example.com',
    id: '0123456789abcdef01234567',
    password: 'hash',
    password_reset_token: 'reset-token',
    password_reset_token_expires_at: '2026-11-04T01:00:00.000Z',
    refresh_tokens: { device: 'refresh-token' },
    temp_tokens: { device: 'temp-token' },
    verification_token: 'verify-token',
  };
}

const SECRET_COLUMNS = [
  'api_key_encrypted',
  'password',
  'password_reset_token',
  'password_reset_token_expires_at',
  'refresh_tokens',
  'temp_tokens',
  'verification_token',
];

describe('CheckSecurityInterceptor — secret fields under their SQL column names', () => {
  /**
   * @regression   12.3.1 — removeSecrets() checked the camelCase secret names only, so a native SQL row returned by a
   *   route kept `password_reset_token`, `verification_token`, `refresh_tokens`, `temp_tokens` and `api_key_encrypted`.
   * @seen-failing Drop the column names from secretFieldKeys() in src/core/common/interceptors/check-security.interceptor.ts
   *   — registered as mutation `secret-columns-not-stripped` in tests/regression-mutations.json.
   */
  it('strips every default secret from a native row', async () => {
    const response = await respond(nativeUserRow());

    for (const column of SECRET_COLUMNS) {
      expect(response[column], column).toBeUndefined();
    }
  });

  it('strips them in a list of rows and in a nested row', async () => {
    const response = await respond({ items: [nativeUserRow(), nativeUserRow()], owner: nativeUserRow() });

    for (const row of [...response.items, response.owner]) {
      expect(row.password_reset_token).toBeUndefined();
      expect(row.verification_token).toBeUndefined();
    }
  });

  it("strips a project's own secret field under its column name too", async () => {
    const response = await respond({ id: 'x', webhook_secret: 's', webhookSecret: 's' }, ['webhookSecret']);

    expect(response.webhook_secret).toBeUndefined();
    expect(response.webhookSecret).toBeUndefined();
  });

  it('accepts a project secret field that is no identifier, without a column', async () => {
    const response = await respond({ 'x-secret': 's', x_secret: 'kept' }, ['x-secret']);

    expect(response['x-secret']).toBeUndefined();
    expect(response.x_secret).toBe('kept');
  });

  it('paired control: keeps the ordinary columns of the row', async () => {
    const response = await respond(nativeUserRow());

    expect(response).toMatchObject({
      created_at: '2026-11-04T00:00:00.000Z',
      email: 'user@example.com',
      id: '0123456789abcdef01234567',
    });
  });
});
