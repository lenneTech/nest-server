import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ErrorCode, LtnsErrors } from '../../src/core/modules/error-code/error-codes';

/**
 * Every 403 the CoreTenantGuard throws carries a translatable error code.
 *
 * The guard used to throw five of its refusals as plain English strings
 * ("Not a member of this tenant", "Insufficient role", …). A plain string has no
 * `#LTNS_XXXX:` prefix, so the frontend error translation cannot map it and the
 * user sees the raw English text in a toast — in lt-crm five of them at once after
 * signing in with another account in the same browser (lt-crm DEV-2905).
 *
 * Two contracts are pinned here:
 *
 *   1. The ORIGINAL WORDING stays the message behind the code. Consumers matched on
 *      it (`toContain('Insufficient role')` in their own tests, log filters), and the
 *      prefix keeps `toContain` working, while a reworded message would break them.
 *   2. Every code ships a German and an English translation — the whole point of the
 *      change. A code without a translation is a plain string with extra characters.
 *
 * The source scan closes the loop the other way: a new plain-string refusal in the
 * guard would bring the untranslated toast back, and nothing else would notice.
 */
const TENANT_GUARD_CODES = {
  INSUFFICIENT_ROLE: { code: 'LTNS_0105', message: 'Insufficient role' },
  INSUFFICIENT_TENANT_ROLE: { code: 'LTNS_0104', message: 'Insufficient tenant role' },
  NOT_TENANT_MEMBER: { code: 'LTNS_0103', message: 'Not a member of this tenant' },
  TENANT_INACTIVE: { code: 'LTNS_0106', message: 'Tenant is inactive' },
  VERIFICATION_REQUIRED: { code: 'LTNS_0107', message: 'Verification required' },
} as const;

describe('CoreTenantGuard error codes', () => {
  for (const [key, expected] of Object.entries(TENANT_GUARD_CODES)) {
    describe(key, () => {
      const definition = LtnsErrors[key as keyof typeof LtnsErrors];

      it('keeps the original wording behind its code', () => {
        expect(definition.code).toBe(expected.code);
        expect(definition.message).toBe(expected.message);
        expect(ErrorCode[key as keyof typeof ErrorCode]).toBe(`#${expected.code}: ${expected.message}`);
      });

      it('ships a German and an English translation', () => {
        expect(definition.translations.de).toMatch(/\S/);
        expect(definition.translations.en).toMatch(/\S/);
        expect(definition.translations.de).not.toBe(definition.translations.en);
      });
    });
  }

  it('assigns every code exactly once in the registry', () => {
    const codes = Object.values(LtnsErrors).map((definition) => definition.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('leaves no plain-string refusal in the guard', () => {
    const source = readFileSync(join(__dirname, '../../src/core/modules/tenant/core-tenant.guard.ts'), 'utf8');
    const plainStringThrows = source.match(/new (Forbidden|Unauthorized)Exception\(\s*['"`]/g) ?? [];
    expect(plainStringThrows).toEqual([]);
  });
});
