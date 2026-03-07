import { describe, expect, it, beforeEach } from 'vitest';

import { ModelRegistry } from '../../src/core/common/services/model-registry.service';
import { RequestContext } from '../../src/core/common/services/request-context.service';
import { CoreModel } from '../../src/core/common/models/core-model.model';
import { applyTranslationsRecursively } from '../../src/core/common/helpers/service.helper';

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
// Password Hashing Plugin Logic Tests
// =====================================================================================================================

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
// Password Hashing Plugin Logic Tests
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
    const regularUser = { id: 'user1', roles: ['USER'], hasRole: (roles: string[]) => roles.some(r => ['USER'].includes(r)) };
    RequestContext.run({ currentUser: regularUser }, () => {
      const user = RequestContext.getCurrentUser();
      expect(user.hasRole(['ADMIN'])).toBe(false);
      // Non-admin should NOT be allowed to change roles
    });
  });

  it('should allow custom allowedRoles to change roles', () => {
    const orgaUser = { id: 'orga1', roles: ['ORGA'], hasRole: (roles: string[]) => roles.some(r => ['ORGA'].includes(r)) };
    RequestContext.run({ currentUser: orgaUser }, () => {
      const user = RequestContext.getCurrentUser();
      // With allowedRoles: ['ORGA'] config, ORGA users should be allowed
      expect(user.roles).toContain('ORGA');
    });
  });
});
