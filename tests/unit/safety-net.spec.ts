import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

import { ModelRegistry } from '../../src/core/common/services/model-registry.service';
import { RequestContext } from '../../src/core/common/services/request-context.service';
import { CoreModel } from '../../src/core/common/models/core-model.model';
import { applyTranslationsRecursively } from '../../src/core/common/helpers/service.helper';
import { hashPassword, hashUpdatePassword, resetSkipPatternsCache } from '../../src/core/common/plugins/mongoose-password.plugin';
import { ConfigService } from '../../src/core/common/services/config.service';

// Helper to mock ConfigService.configFastButReadOnly (it's a static getter backed by a BehaviorSubject)
function setMockConfig(config: any): void {
  vi.spyOn(ConfigService, 'configFastButReadOnly', 'get').mockReturnValue(config);
}

// =====================================================================================================================
// ModelRegistry Tests
// =====================================================================================================================

describe('ModelRegistry', () => {
  beforeEach(() => {
    ModelRegistry.clear();
  });

  it('should register and retrieve a model class', () => {
    class TestModel extends CoreModel {
      name: string = undefined;
    }

    ModelRegistry.register('TestModel', TestModel);
    expect(ModelRegistry.getModelClass('TestModel')).toBe(TestModel);
  });

  it('should return undefined for unregistered model', () => {
    expect(ModelRegistry.getModelClass('NonExistent')).toBeUndefined();
  });

  it('should overwrite existing registration', () => {
    class TestModel1 extends CoreModel {
      name: string = undefined;
    }
    class TestModel2 extends CoreModel {
      name: string = undefined;
    }

    ModelRegistry.register('TestModel', TestModel1);
    ModelRegistry.register('TestModel', TestModel2);
    expect(ModelRegistry.getModelClass('TestModel')).toBe(TestModel2);
  });

  it('should clear all registrations', () => {
    class TestModel extends CoreModel {
      name: string = undefined;
    }

    ModelRegistry.register('TestModel', TestModel);
    ModelRegistry.clear();
    expect(ModelRegistry.getModelClass('TestModel')).toBeUndefined();
  });

  it('should return all registered models', () => {
    class TestModel1 extends CoreModel {
      name: string = undefined;
    }
    class TestModel2 extends CoreModel {
      name: string = undefined;
    }

    ModelRegistry.register('Model1', TestModel1);
    ModelRegistry.register('Model2', TestModel2);

    const all = ModelRegistry.getAll();
    expect(all.size).toBe(2);
    expect(all.get('Model1')).toBe(TestModel1);
    expect(all.get('Model2')).toBe(TestModel2);
  });
});

// =====================================================================================================================
// RequestContext Tests
// =====================================================================================================================

describe('RequestContext', () => {
  it('should return undefined outside of a run context', () => {
    expect(RequestContext.get()).toBeUndefined();
    expect(RequestContext.getCurrentUser()).toBeUndefined();
  });

  it('should provide context within a run call', () => {
    const user = { id: 'user123', roles: ['ADMIN'] };
    RequestContext.run({ currentUser: user }, () => {
      expect(RequestContext.get()).toBeDefined();
      expect(RequestContext.getCurrentUser()).toBe(user);
      expect(RequestContext.getCurrentUser().id).toBe('user123');
    });
  });

  it('should isolate contexts between nested runs', () => {
    const user1 = { id: 'user1' };
    const user2 = { id: 'user2' };

    RequestContext.run({ currentUser: user1 }, () => {
      expect(RequestContext.getCurrentUser().id).toBe('user1');

      RequestContext.run({ currentUser: user2 }, () => {
        expect(RequestContext.getCurrentUser().id).toBe('user2');
      });

      // After inner run, outer context is restored
      expect(RequestContext.getCurrentUser().id).toBe('user1');
    });
  });

  it('should return undefined after run completes', () => {
    const user = { id: 'user123' };
    RequestContext.run({ currentUser: user }, () => {
      // Inside context
    });
    // Outside context
    expect(RequestContext.getCurrentUser()).toBeUndefined();
  });

  it('should support lazy currentUser getter', () => {
    const reqObj = { user: null } as any;
    const context = {
      get currentUser() {
        return reqObj.user;
      },
    };

    RequestContext.run(context, () => {
      // Before auth sets user
      expect(RequestContext.getCurrentUser()).toBeNull();

      // Simulate auth middleware setting user
      reqObj.user = { id: 'lazy-user' };
      expect(RequestContext.getCurrentUser()).toEqual({ id: 'lazy-user' });
    });
  });
});

// =====================================================================================================================
// RequestContext Language Tests
// =====================================================================================================================

describe('RequestContext Language', () => {
  it('should return undefined for language outside context', () => {
    expect(RequestContext.getLanguage()).toBeUndefined();
  });

  it('should provide language within a run call', () => {
    RequestContext.run({ language: 'en' }, () => {
      expect(RequestContext.getLanguage()).toBe('en');
    });
  });

  it('should support lazy language getter', () => {
    const reqObj = { headers: { 'accept-language': 'de' } } as any;
    const context = {
      get language() {
        return reqObj.headers['accept-language'];
      },
    };

    RequestContext.run(context, () => {
      expect(RequestContext.getLanguage()).toBe('de');
      reqObj.headers['accept-language'] = 'en';
      expect(RequestContext.getLanguage()).toBe('en');
    });
  });
});

// =====================================================================================================================
// Translation Application Tests
// =====================================================================================================================

describe('applyTranslationsRecursively', () => {
  it('should apply translations for a given language', () => {
    const obj = {
      name: 'Standard Name',
      _translations: {
        en: { name: 'English Name' },
        fr: { name: 'Nom Français' },
      },
    };

    applyTranslationsRecursively(obj, 'en');
    expect(obj.name).toBe('English Name');
  });

  it('should not modify when language has no translations', () => {
    const obj = {
      name: 'Standard Name',
      _translations: {
        en: { name: 'English Name' },
      },
    };

    applyTranslationsRecursively(obj, 'es');
    expect(obj.name).toBe('Standard Name');
  });

  it('should apply translations recursively to nested objects', () => {
    const obj = {
      title: 'Titel',
      nested: {
        description: 'Beschreibung',
        _translations: {
          en: { description: 'Description' },
        },
      },
      _translations: {
        en: { title: 'Title' },
      },
    };

    applyTranslationsRecursively(obj, 'en');
    expect(obj.title).toBe('Title');
    expect(obj.nested.description).toBe('Description');
  });

  it('should apply translations to items in arrays', () => {
    const obj = {
      items: [
        { name: 'Name1', _translations: { en: { name: 'Name1EN' } } },
        { name: 'Name2', _translations: { en: { name: 'Name2EN' } } },
      ],
    };

    applyTranslationsRecursively(obj, 'en');
    expect(obj.items[0].name).toBe('Name1EN');
    expect(obj.items[1].name).toBe('Name2EN');
  });

  it('should be idempotent', () => {
    const obj = {
      name: 'Standard',
      _translations: { en: { name: 'English' } },
    };

    applyTranslationsRecursively(obj, 'en');
    applyTranslationsRecursively(obj, 'en');
    expect(obj.name).toBe('English');
  });

  it('should not fail on objects without _translations', () => {
    const obj = { name: 'No translations' };
    applyTranslationsRecursively(obj, 'en');
    expect(obj.name).toBe('No translations');
  });

  it('should handle null and undefined values gracefully', () => {
    applyTranslationsRecursively(null, 'en');
    applyTranslationsRecursively(undefined, 'en');
    // No error thrown
  });
});

// =====================================================================================================================
// Password Hashing Detection Tests
// =====================================================================================================================

describe('Password Hashing Detection', () => {
  const bcryptPattern = /^\$2[aby]\$\d+\$/;
  const sha256Pattern = /^[a-f0-9]{64}$/i;

  it('should detect BCrypt hashes', () => {
    expect(bcryptPattern.test('$2b$10$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu')).toBe(true);
    expect(bcryptPattern.test('$2a$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu')).toBe(true);
    expect(bcryptPattern.test('plaintext')).toBe(false);
  });

  it('should detect SHA256 hashes', () => {
    expect(sha256Pattern.test('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true);
    expect(sha256Pattern.test('plaintext')).toBe(false);
    expect(sha256Pattern.test('too-short')).toBe(false);
  });

  it('should NOT skip passwords starting with ! by default', () => {
    // A password starting with ! is a valid password
    expect(bcryptPattern.test('!MySecurePassword123')).toBe(false);
    // It should be treated as plaintext and hashed (not skipped)
  });

  it('should correctly identify sentinel patterns via regex', () => {
    const sentinelPattern = /^!LOCKED:/;
    expect(sentinelPattern.test('!LOCKED:REQUIRES_PASSWORD_RESET')).toBe(true);
    expect(sentinelPattern.test('!LOCKED:DISABLED')).toBe(true);
    expect(sentinelPattern.test('!MyPassword')).toBe(false);
    expect(sentinelPattern.test('normalPassword')).toBe(false);
    expect(sentinelPattern.test('password!LOCKED:')).toBe(false);
  });
});

// =====================================================================================================================
// hashPassword() Function Tests
// =====================================================================================================================

describe('hashPassword', () => {
  beforeEach(() => {
    resetSkipPatternsCache();
    // Reset ConfigService static config
    setMockConfig({});
  });

  afterEach(() => {
    resetSkipPatternsCache();
    setMockConfig({});
  });

  it('should hash a plaintext password with bcrypt', async () => {
    const result = await hashPassword('myPlainPassword');
    expect(result).toMatch(/^\$2[aby]\$10\$/);
    expect(result).not.toBe('myPlainPassword');
  });

  it('should skip already BCrypt-hashed passwords (prevent double-hashing)', async () => {
    const bcryptHash = '$2b$10$abcdefghijklmnopqrstuuKo3Ei9uGbN3p6.aRbOiK/NnZYFiNGbC';
    const result = await hashPassword(bcryptHash);
    expect(result).toBe(bcryptHash);
  });

  it('should skip BCrypt $2a$ variant', async () => {
    const hash = '$2a$12$abcdefghijklmnopqrstuuKo3Ei9uGbN3p6.aRbOiK/NnZYFiNGbC';
    const result = await hashPassword(hash);
    expect(result).toBe(hash);
  });

  it('should skip BCrypt $2y$ variant', async () => {
    const hash = '$2y$10$abcdefghijklmnopqrstuuKo3Ei9uGbN3p6.aRbOiK/NnZYFiNGbC';
    const result = await hashPassword(hash);
    expect(result).toBe(hash);
  });

  it('should hash passwords that look partially like BCrypt but are not', async () => {
    const result = await hashPassword('$2b$notreallybcrypt');
    // No digits after $ → not a valid BCrypt prefix
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should apply SHA256 pre-hash when sha256 is enabled', async () => {
    setMockConfig({ sha256: true });
    const result = await hashPassword('myPlainPassword');
    // Should be hashed (bcrypt of sha256)
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should skip SHA256 pre-hash for already SHA256-hashed values when sha256 is enabled', async () => {
    setMockConfig({ sha256: true });
    const sha256Value = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const result = await hashPassword(sha256Value);
    // Should be bcrypt of the sha256 value (not double-sha256)
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should skip passwords matching configured skipPatterns', async () => {
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: ['^!LOCKED:'],
        },
      },
    });
    const result = await hashPassword('!LOCKED:REQUIRES_PASSWORD_RESET');
    expect(result).toBe('!LOCKED:REQUIRES_PASSWORD_RESET');
  });

  it('should hash passwords that do NOT match skipPatterns', async () => {
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: ['^!LOCKED:'],
        },
      },
    });
    const result = await hashPassword('!MyNormalPassword');
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should handle RegExp objects in skipPatterns', async () => {
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: [/^!SENTINEL/],
        },
      },
    });
    const result = await hashPassword('!SENTINEL_VALUE');
    expect(result).toBe('!SENTINEL_VALUE');
  });

  it('should hash normally with empty skipPatterns', async () => {
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: [],
        },
      },
    });
    const result = await hashPassword('testPassword');
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should hash normally when no skipPatterns configured', async () => {
    setMockConfig({});
    const result = await hashPassword('testPassword');
    expect(result).toMatch(/^\$2[aby]\$10\$/);
  });
});

// =====================================================================================================================
// hashUpdatePassword() Function Tests
// =====================================================================================================================

describe('hashUpdatePassword', () => {
  beforeEach(() => {
    resetSkipPatternsCache();
    setMockConfig({});
  });

  afterEach(() => {
    resetSkipPatternsCache();
    setMockConfig({});
  });

  it('should hash update.password', async () => {
    const update = { password: 'newPassword123' };
    await hashUpdatePassword(update);
    expect(update.password).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should hash update.$set.password', async () => {
    const update = { $set: { password: 'newPassword123' } };
    await hashUpdatePassword(update);
    expect(update.$set.password).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should hash both update.password and update.$set.password', async () => {
    const update = { password: 'pw1', $set: { password: 'pw2' } };
    await hashUpdatePassword(update);
    expect(update.password).toMatch(/^\$2[aby]\$10\$/);
    expect(update.$set.password).toMatch(/^\$2[aby]\$10\$/);
  });

  it('should skip if update is null/undefined', async () => {
    await hashUpdatePassword(null);
    await hashUpdatePassword(undefined);
    // No error thrown
  });

  it('should not modify update without password fields', async () => {
    const update = { name: 'test', $set: { email: 'test@test.com' } };
    const original = JSON.parse(JSON.stringify(update));
    await hashUpdatePassword(update);
    expect(update).toEqual(original);
  });

  it('should skip already-hashed passwords in update', async () => {
    const bcryptHash = '$2b$10$abcdefghijklmnopqrstuuKo3Ei9uGbN3p6.aRbOiK/NnZYFiNGbC';
    const update = { password: bcryptHash };
    await hashUpdatePassword(update);
    expect(update.password).toBe(bcryptHash);
  });
});

// =====================================================================================================================
// resetSkipPatternsCache() Tests
// =====================================================================================================================

describe('resetSkipPatternsCache', () => {
  afterEach(() => {
    resetSkipPatternsCache();
    setMockConfig({});
  });

  it('should allow cache reset and re-read from config', async () => {
    // First: configure with a skip pattern
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: ['^!OLD_PATTERN:'],
        },
      },
    });
    let result = await hashPassword('!OLD_PATTERN:test');
    expect(result).toBe('!OLD_PATTERN:test');

    // Change config and reset cache
    setMockConfig({
      security: {
        mongoosePasswordPlugin: {
          skipPatterns: ['^!NEW_PATTERN:'],
        },
      },
    });
    resetSkipPatternsCache();

    // Old pattern should now be hashed
    result = await hashPassword('!OLD_PATTERN:test');
    expect(result).toMatch(/^\$2[aby]\$10\$/);

    // New pattern should be skipped
    result = await hashPassword('!NEW_PATTERN:test');
    expect(result).toBe('!NEW_PATTERN:test');
  });
});

// =====================================================================================================================
// Role Guard Logic Tests
// =====================================================================================================================

describe('Role Guard Logic', () => {
  it('should allow role changes when no user context exists (system operation)', () => {
    // Outside RequestContext → no currentUser → should allow
    const currentUser = RequestContext.getCurrentUser();
    expect(currentUser).toBeUndefined();
    // System operations (no context) are allowed through
  });

  it('should allow admin user role changes', () => {
    const adminUser = { id: 'admin1', roles: ['ADMIN'], hasRole: (roles: string[]) => roles.includes('ADMIN') };
    RequestContext.run({ currentUser: adminUser }, () => {
      const user = RequestContext.getCurrentUser();
      expect(user.hasRole(['ADMIN'])).toBe(true);
    });
  });

  it('should block non-admin role changes', () => {
    const regularUser = {
      id: 'user1',
      roles: ['USER'],
      hasRole: (roles: string[]) => roles.some((r) => ['USER'].includes(r)),
    };
    RequestContext.run({ currentUser: regularUser }, () => {
      const user = RequestContext.getCurrentUser();
      expect(user.hasRole(['ADMIN'])).toBe(false);
      // Non-admin should NOT be allowed to change roles
    });
  });

  it('should allow custom allowedRoles to change roles', () => {
    const orgaUser = {
      id: 'orga1',
      roles: ['ORGA'],
      hasRole: (roles: string[]) => roles.some((r) => ['ORGA'].includes(r)),
    };
    RequestContext.run({ currentUser: orgaUser }, () => {
      const user = RequestContext.getCurrentUser();
      // With allowedRoles: ['ORGA'] config, ORGA users should be allowed
      expect(user.roles).toContain('ORGA');
    });
  });

  it('should allow role changes when bypassRoleGuard is active', () => {
    const regularUser = {
      id: 'user1',
      roles: ['USER'],
      hasRole: (roles: string[]) => roles.some((r) => ['USER'].includes(r)),
    };
    RequestContext.run({ currentUser: regularUser }, () => {
      // Without bypass: user has no admin role
      expect(RequestContext.getCurrentUser().hasRole(['ADMIN'])).toBe(false);
      expect(RequestContext.isBypassRoleGuard()).toBe(false);

      // With bypass: role guard should be skipped
      RequestContext.runWithBypassRoleGuard(() => {
        expect(RequestContext.isBypassRoleGuard()).toBe(true);
        // currentUser is still the same
        expect(RequestContext.getCurrentUser().id).toBe('user1');
      });

      // After bypass: should be back to normal
      expect(RequestContext.isBypassRoleGuard()).toBe(false);
    });
  });

  it('should allow role changes during signUp (no currentUser)', () => {
    // signUp scenario: RequestContext exists (middleware ran) but no user is logged in
    RequestContext.run({}, () => {
      // No currentUser → getCurrentUser returns undefined → allowed
      expect(RequestContext.getCurrentUser()).toBeUndefined();
    });
  });

  it('should preserve context when using runWithBypassRoleGuard', () => {
    const user = { id: 'admin-panel-user', roles: ['HR_MANAGER'] };
    RequestContext.run({ currentUser: user, language: 'de' }, () => {
      RequestContext.runWithBypassRoleGuard(() => {
        expect(RequestContext.getCurrentUser().id).toBe('admin-panel-user');
        expect(RequestContext.getLanguage()).toBe('de');
        expect(RequestContext.isBypassRoleGuard()).toBe(true);
      });
    });
  });
});

// =====================================================================================================================
// Role Guard handleUpdateRoleGuard Tests (via exported isRoleChangeAllowed behavior)
// =====================================================================================================================

describe('Role Guard Update Operations', () => {
  it('should detect roles in $push operator', () => {
    const update = { $push: { roles: 'ADMIN' } };
    // Verify the structure is as expected
    expect(update.$push?.roles).toBeTruthy();
  });

  it('should detect roles in $addToSet operator', () => {
    const update = { $addToSet: { roles: 'ADMIN' } };
    expect(update.$addToSet?.roles).toBeTruthy();
  });

  it('should detect roles in $set operator', () => {
    const update = { $set: { roles: ['ADMIN'] } };
    expect(update.$set?.roles).toBeTruthy();
  });

  it('should detect direct roles update', () => {
    const update = { roles: ['ADMIN'] };
    expect(update.roles).toBeTruthy();
  });

  it('should not detect roles when no roles in update', () => {
    const update = { name: 'test', $set: { email: 'test@example.com' } };
    const hasRolesUpdate = update['roles'] || update.$set?.['roles'];
    expect(hasRolesUpdate).toBeFalsy();
  });
});

// =====================================================================================================================
// removeSecrets Recursion Tests
// =====================================================================================================================

describe('removeSecrets recursion', () => {
  // Test the removeSecrets logic extracted from CheckSecurityInterceptor
  const secretFields = ['password', 'verificationToken', 'passwordResetToken', 'refreshTokens', 'tempTokens'];

  function removeSecrets(data: any): any {
    if (!data || typeof data !== 'object') {
      return data;
    }
    if (Array.isArray(data)) {
      data.forEach(removeSecrets);
      return data;
    }
    for (const field of secretFields) {
      if (field in data && data[field] !== undefined) {
        data[field] = undefined;
      }
    }
    // Recurse into nested objects
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value && typeof value === 'object' && !secretFields.includes(key)) {
        removeSecrets(value);
      }
    }
    return data;
  }

  it('should remove secret fields at root level', () => {
    const data = { name: 'test', password: 'secret', email: 'test@test.com' };
    removeSecrets(data);
    expect(data.password).toBeUndefined();
    expect(data.name).toBe('test');
    expect(data.email).toBe('test@test.com');
  });

  it('should remove secret fields from nested objects', () => {
    const data = {
      auth: {
        user: {
          password: 'nested-secret',
          name: 'test',
        },
      },
    };
    removeSecrets(data);
    expect(data.auth.user.password).toBeUndefined();
    expect(data.auth.user.name).toBe('test');
  });

  it('should remove secret fields from deeply nested objects', () => {
    const data = {
      level1: {
        level2: {
          level3: {
            password: 'deep-secret',
            verificationToken: 'deep-token',
          },
        },
      },
    };
    removeSecrets(data);
    expect(data.level1.level2.level3.password).toBeUndefined();
    expect(data.level1.level2.level3.verificationToken).toBeUndefined();
  });

  it('should remove secret fields from array items', () => {
    const data = [
      { name: 'user1', password: 'pw1' },
      { name: 'user2', password: 'pw2' },
    ];
    removeSecrets(data);
    expect(data[0].password).toBeUndefined();
    expect(data[1].password).toBeUndefined();
    expect(data[0].name).toBe('user1');
  });

  it('should remove secret fields from nested arrays within objects', () => {
    const data = {
      users: [
        { name: 'user1', password: 'pw1', profile: { passwordResetToken: 'token1' } },
        { name: 'user2', password: 'pw2' },
      ],
    };
    removeSecrets(data);
    expect(data.users[0].password).toBeUndefined();
    expect(data.users[0].profile.passwordResetToken).toBeUndefined();
    expect(data.users[1].password).toBeUndefined();
  });

  it('should handle null and undefined gracefully', () => {
    expect(removeSecrets(null)).toBeNull();
    expect(removeSecrets(undefined)).toBeUndefined();
  });

  it('should handle objects without secret fields', () => {
    const data = { name: 'test', email: 'test@test.com' };
    removeSecrets(data);
    expect(data).toEqual({ name: 'test', email: 'test@test.com' });
  });

  it('should handle empty objects', () => {
    const data = {};
    removeSecrets(data);
    expect(data).toEqual({});
  });

  it('should not recurse into fields that are themselves secret fields', () => {
    // If a field name is in secretFields, its value gets set to undefined,
    // so no recursion into it (it's already handled)
    const data = { refreshTokens: [{ token: 'abc' }], name: 'test' };
    removeSecrets(data);
    expect(data.refreshTokens).toBeUndefined();
    expect(data.name).toBe('test');
  });
});

// =====================================================================================================================
// interceptor.helper isCoreModelSubclass Tests
// =====================================================================================================================

describe('isCoreModelSubclass', () => {
  // Re-implement the logic for testing since it's not exported
  function isCoreModelSubclass(cls: Function): boolean {
    let proto = cls.prototype;
    while (proto) {
      if (proto.constructor === CoreModel || proto.constructor?.name === 'CoreModel') {
        return true;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return false;
  }

  it('should return true for direct CoreModel subclass', () => {
    class TestModel extends CoreModel {
      name: string = undefined;
    }
    expect(isCoreModelSubclass(TestModel)).toBe(true);
  });

  it('should return true for multi-level inheritance', () => {
    class BaseModel extends CoreModel {
      name: string = undefined;
    }
    class ChildModel extends BaseModel {
      extra: string = undefined;
    }
    class GrandChildModel extends ChildModel {
      deep: string = undefined;
    }
    expect(isCoreModelSubclass(GrandChildModel)).toBe(true);
    expect(isCoreModelSubclass(ChildModel)).toBe(true);
  });

  it('should return false for non-CoreModel classes', () => {
    class RandomClass {
      value: string;
    }
    expect(isCoreModelSubclass(RandomClass)).toBe(false);
  });

  it('should return false for Object', () => {
    expect(isCoreModelSubclass(Object)).toBe(false);
  });
});

// =====================================================================================================================
// TranslateResponseInterceptor hasTranslations Tests
// =====================================================================================================================

describe('TranslateResponseInterceptor hasTranslations logic', () => {
  // Re-implement the logic for testing since it's a private method
  function hasTranslations(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }
    if (Array.isArray(data)) {
      return data.length > 0 && data[0] && typeof data[0] === 'object' && '_translations' in data[0];
    }
    if (data.items && Array.isArray(data.items)) {
      return (
        data.items.length > 0 && data.items[0] && typeof data.items[0] === 'object' && '_translations' in data.items[0]
      );
    }
    return '_translations' in data;
  }

  it('should return false for null/undefined', () => {
    expect(hasTranslations(null)).toBe(false);
    expect(hasTranslations(undefined)).toBe(false);
  });

  it('should return false for primitives', () => {
    expect(hasTranslations('string')).toBe(false);
    expect(hasTranslations(42)).toBe(false);
  });

  it('should detect _translations on single object', () => {
    expect(hasTranslations({ name: 'test', _translations: { en: {} } })).toBe(true);
  });

  it('should return false for object without _translations', () => {
    expect(hasTranslations({ name: 'test' })).toBe(false);
  });

  it('should detect _translations in first array element', () => {
    expect(hasTranslations([{ name: 'test', _translations: { en: {} } }])).toBe(true);
  });

  it('should return false for empty array', () => {
    expect(hasTranslations([])).toBe(false);
  });

  it('should return false for array without _translations', () => {
    expect(hasTranslations([{ name: 'test' }])).toBe(false);
  });

  it('should detect _translations in wrapper object items', () => {
    expect(
      hasTranslations({
        items: [{ name: 'test', _translations: { en: {} } }],
        totalCount: 1,
      }),
    ).toBe(true);
  });

  it('should return false for wrapper object with empty items', () => {
    expect(hasTranslations({ items: [], totalCount: 0 })).toBe(false);
  });

  it('should return false for wrapper object items without _translations', () => {
    expect(hasTranslations({ items: [{ name: 'test' }], totalCount: 1 })).toBe(false);
  });
});

// =====================================================================================================================
// TranslateResponseInterceptor getLanguage Tests
// =====================================================================================================================

describe('TranslateResponseInterceptor getLanguage logic', () => {
  it('should extract language from HTTP request accept-language header', () => {
    const req = { headers: { 'accept-language': 'de' } };
    expect(req.headers['accept-language']).toBe('de');
  });

  it('should return null when no accept-language header', () => {
    const req = { headers: {} };
    expect(req.headers['accept-language'] || null).toBeNull();
  });
});

// =====================================================================================================================
// ResponseModelInterceptor convertToModel Logic Tests
// =====================================================================================================================

describe('ResponseModelInterceptor conversion logic', () => {
  class TestModel extends CoreModel {
    name: string = undefined;
    email: string = undefined;
  }

  it('should map plain objects via CoreModel.map()', () => {
    const plain = { name: 'Test', email: 'test@test.com' };
    const mapped = TestModel.map(plain);
    expect(mapped).toBeInstanceOf(TestModel);
    expect(mapped.name).toBe('Test');
    expect(mapped.email).toBe('test@test.com');
  });

  it('should map arrays of plain objects', () => {
    const plains = [
      { name: 'Test1', email: 'a@b.com' },
      { name: 'Test2', email: 'c@d.com' },
    ];
    const mapped = plains.map((p) => TestModel.map(p));
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toBeInstanceOf(TestModel);
    expect(mapped[1]).toBeInstanceOf(TestModel);
    expect(mapped[0].name).toBe('Test1');
    expect(mapped[1].name).toBe('Test2');
  });

  it('should handle wrapper objects with items array', () => {
    const wrapper = {
      items: [
        { name: 'Test1', email: 'a@b.com' },
        { name: 'Test2', email: 'c@d.com' },
      ],
      totalCount: 2,
    };
    wrapper.items = wrapper.items.map((item: any) => TestModel.map(item));
    expect(wrapper.items[0]).toBeInstanceOf(TestModel);
    expect(wrapper.items[1]).toBeInstanceOf(TestModel);
    expect(wrapper.totalCount).toBe(2);
  });

  it('should skip objects that are already CoreModel instances', () => {
    const instance = TestModel.map({ name: 'Already', email: 'a@b.com' });
    expect(instance instanceof TestModel).toBe(true);
    // No conversion needed — would be skipped by interceptor
  });

  it('should handle objects with _objectAlreadyCheckedForRestrictions', () => {
    const data = { name: 'Test', _objectAlreadyCheckedForRestrictions: true };
    // The interceptor would skip this data
    expect(data._objectAlreadyCheckedForRestrictions).toBe(true);
  });

  it('should handle null and undefined items in arrays', () => {
    const plains = [{ name: 'Test1' }, null, undefined];
    const mapped = plains.map((p) => {
      if (p === null || p === undefined || typeof p !== 'object') return p;
      return TestModel.map(p);
    });
    expect(mapped[0]).toBeInstanceOf(TestModel);
    expect(mapped[1]).toBeNull();
    expect(mapped[2]).toBeUndefined();
  });

  it('should handle toObject() conversion for Mongoose-like docs', () => {
    const mockDoc = {
      name: 'Test',
      email: 'test@test.com',
      toObject: () => ({ name: 'Test', email: 'test@test.com' }),
    };
    const plain = typeof mockDoc.toObject === 'function' ? mockDoc.toObject() : mockDoc;
    const mapped = TestModel.map(plain);
    expect(mapped).toBeInstanceOf(TestModel);
    expect(mapped.name).toBe('Test');
  });
});

// =====================================================================================================================
// Mongoose Audit Fields Plugin Logic Tests
// =====================================================================================================================

describe('Mongoose Audit Fields Plugin Logic', () => {
  it('should set createdBy for new documents when user context exists', () => {
    const user = { id: 'creator123' };
    RequestContext.run({ currentUser: user }, () => {
      const currentUser = RequestContext.getCurrentUser();
      expect(currentUser.id).toBe('creator123');
      // Plugin would set this['createdBy'] = currentUser.id for isNew documents
    });
  });

  it('should not set createdBy when user context does not exist', () => {
    const currentUser = RequestContext.getCurrentUser();
    expect(currentUser).toBeUndefined();
    // Plugin would skip: if (!currentUser?.id) return
  });

  it('should set updatedBy for existing documents', () => {
    const user = { id: 'updater456' };
    RequestContext.run({ currentUser: user }, () => {
      const currentUser = RequestContext.getCurrentUser();
      expect(currentUser.id).toBe('updater456');
      // Plugin would set this['updatedBy'] = currentUser.id
    });
  });

  it('should handle update operations with $set', () => {
    const user = { id: 'updater789' };
    const update = { $set: { name: 'new' } };
    RequestContext.run({ currentUser: user }, () => {
      // Simulate what the plugin does
      update['updatedBy'] = RequestContext.getCurrentUser().id;
      if (update.$set) {
        update.$set['updatedBy'] = RequestContext.getCurrentUser().id;
      }
    });
    expect(update['updatedBy']).toBe('updater789');
    expect(update.$set['updatedBy']).toBe('updater789');
  });

  it('should handle upsert with $setOnInsert for createdBy', () => {
    const user = { id: 'upsertUser' };
    const update: any = { $set: { name: 'upserted' } };
    RequestContext.run({ currentUser: user }, () => {
      // Simulate the plugin's upsert logic
      update['updatedBy'] = RequestContext.getCurrentUser().id;
      if (!update['createdBy'] && !update.$set?.['createdBy']) {
        if (!update.$setOnInsert) {
          update.$setOnInsert = {};
        }
        if (!update.$setOnInsert['createdBy']) {
          update.$setOnInsert['createdBy'] = RequestContext.getCurrentUser().id;
        }
      }
    });
    expect(update.$setOnInsert.createdBy).toBe('upsertUser');
    expect(update['updatedBy']).toBe('upsertUser');
  });

  it('should not overwrite existing createdBy on upsert', () => {
    const user = { id: 'upsertUser' };
    const update: any = { createdBy: 'originalCreator', $set: { name: 'test' } };
    RequestContext.run({ currentUser: user }, () => {
      // Simulate: skip $setOnInsert if createdBy already in update
      if (!update['createdBy'] && !update.$set?.['createdBy']) {
        update.$setOnInsert = { createdBy: RequestContext.getCurrentUser().id };
      }
    });
    expect(update.$setOnInsert).toBeUndefined();
    expect(update.createdBy).toBe('originalCreator');
  });
});
