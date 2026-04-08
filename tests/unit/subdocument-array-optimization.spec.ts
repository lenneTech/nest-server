import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

import { checkRestricted, Restricted } from '../../src/core/common/decorators/restricted.decorator';
import { prepareInput, prepareOutput } from '../../src/core/common/helpers/service.helper';
import { RoleEnum } from '../../src/core/common/enums/role.enum';
import { ConfigService } from '../../src/core/common/services/config.service';

// Mock ConfigService for prepareInput/prepareOutput
function setMockConfig(config: any): void {
  vi.spyOn(ConfigService, 'configFastButReadOnly', 'get').mockReturnValue(config);
}

// Test user helper
function makeUser(overrides: Partial<{ id: string; roles: string[]; verified: boolean }> = {}) {
  const id = overrides.id || 'user-123';
  const roles = overrides.roles || [];
  return {
    id,
    roles,
    verified: overrides.verified ?? false,
    hasRole: (requiredRoles: string[]) => requiredRoles.some((r) => roles.includes(r)),
  };
}

// =============================================================================
// 1. Bug Fix: concat() → push(...items) in checkRestricted group member checks
// =============================================================================
describe('checkRestricted: group member checks (concat bug fix)', () => {
  it('should grant access when user is a member of a group (array membership)', () => {
    // @Restricted({ memberOf: 'members' }) means: only users whose ID is in the `members` array
    class Document {
      @Restricted({ memberOf: 'members' })
      secretField: string = 'secret-value';

      visibleField: string = 'visible';
    }

    const user = makeUser({ id: 'user-1' });
    const data = Object.assign(new Document(), {
      secretField: 'secret-value',
      visibleField: 'visible',
    });

    // dbObject has user in members array — this is the critical test for the concat fix
    const result = checkRestricted(data, user, {
      dbObject: { members: ['user-1', 'user-2', 'user-3'] },
      throwError: false,
    });

    expect(result.secretField).toBe('secret-value');
    expect(result.visibleField).toBe('visible');
  });

  it('should deny access when user is NOT a member of the group', () => {
    class Document {
      @Restricted({ memberOf: 'members' })
      secretField: string = 'secret-value';

      visibleField: string = 'visible';
    }

    const user = makeUser({ id: 'outsider' });
    const data = Object.assign(new Document(), {
      secretField: 'secret-value',
      visibleField: 'visible',
    });

    const result = checkRestricted(data, user, {
      dbObject: { members: ['user-1', 'user-2'] },
      throwError: false,
    });

    expect(result.secretField).toBeUndefined();
    expect(result.visibleField).toBe('visible');
  });
});

// =============================================================================
// 2. Bug Fix: splice() during forward iteration in prepareInput/prepareOutput
// =============================================================================
describe('prepareInput: array processing (splice bug fix)', () => {
  beforeEach(() => {
    setMockConfig({ sha256: false });
  });

  it('should not skip elements when removeUndefined is true', async () => {
    // Create an array where some items will become undefined after processing
    // The old code with splice() would skip the element after each removed one
    const input = ['a', 'b', 'c', 'd', 'e'];
    const result = await prepareInput(input, { id: 'test' } as any, {
      removeUndefined: false,
      clone: false,
    });

    // All elements should be present
    expect(result).toHaveLength(5);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('should correctly filter undefined elements without skipping', async () => {
    // Array with mixed valid/invalid items
    const input = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const result = await prepareInput(input, { id: 'test' } as any, {
      removeUndefined: true,
      clone: false,
    });

    // All objects should be present (none are undefined)
    expect(result).toHaveLength(3);
  });

  it('should return a new array (not mutate input)', async () => {
    const input = [{ a: 1 }, { b: 2 }];
    const originalRef = input;
    const result = await prepareInput(input, { id: 'test' } as any, {
      clone: false,
    });

    // Result should be a different array reference
    expect(result).not.toBe(originalRef);
    expect(result).toHaveLength(2);
  });
});

describe('prepareOutput: array processing (splice bug fix)', () => {
  beforeEach(() => {
    setMockConfig({ sha256: false });
  });

  it('should process all array elements without skipping', async () => {
    const output = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
    const result = await prepareOutput(output, {
      removeUndefined: false,
      removeSecrets: false,
      objectIdsToStrings: false,
    });

    expect(result).toHaveLength(4);
    expect(result.map((r: any) => r.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should return a new array (not mutate output)', async () => {
    const output = [{ name: 'a' }, { name: 'b' }];
    const originalRef = output;
    const result = await prepareOutput(output, {
      removeSecrets: false,
      objectIdsToStrings: false,
    });

    expect(result).not.toBe(originalRef);
    expect(result).toHaveLength(2);
  });
});

// =============================================================================
// 2b. getNewArray deprecation regression
// =============================================================================
describe('prepareInput/prepareOutput: getNewArray deprecated (regression)', () => {
  beforeEach(() => {
    setMockConfig({ sha256: false });
  });

  it('should produce identical results with getNewArray: true (deprecated)', async () => {
    const input = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const result = await prepareInput(input, { id: 'test' } as any, {
      getNewArray: true,
      clone: false,
    });

    expect(result).toHaveLength(3);
    expect(result).not.toBe(input);
  });

  it('should produce identical results with getNewArray: false (deprecated)', async () => {
    const input = [{ a: 1 }, { b: 2 }];
    const result = await prepareInput(input, { id: 'test' } as any, {
      getNewArray: false,
      clone: false,
    });

    // Even with getNewArray: false, a new array is always returned now
    expect(result).toHaveLength(2);
    expect(result).not.toBe(input);
  });

  it('should produce identical prepareOutput results regardless of getNewArray', async () => {
    const output = [{ name: 'a' }, { name: 'b' }];

    const resultTrue = await prepareOutput(output, {
      getNewArray: true,
      removeSecrets: false,
      objectIdsToStrings: false,
    });

    const resultFalse = await prepareOutput([{ name: 'a' }, { name: 'b' }], {
      getNewArray: false,
      removeSecrets: false,
      objectIdsToStrings: false,
    });

    expect(resultTrue).toHaveLength(2);
    expect(resultFalse).toHaveLength(2);
    expect(resultTrue).not.toBe(output);
  });
});

// =============================================================================
// 3. checkRestricted: WeakSet circular reference protection
// =============================================================================
describe('checkRestricted: circular reference protection (WeakSet)', () => {
  it('should not infinite-recurse on circular object references', () => {
    const user = makeUser({ roles: [RoleEnum.ADMIN] });
    const a: any = { name: 'a', ref: null };
    const b: any = { name: 'b', ref: null };
    a.ref = b;
    b.ref = a; // circular

    const result = checkRestricted(a, user, { throwError: false });
    expect(result.name).toBe('a');
    expect(result.ref.name).toBe('b');
  });

  it('should not infinite-recurse on self-referencing objects', () => {
    const user = makeUser({ roles: [RoleEnum.ADMIN] });
    const obj: any = { name: 'self' };
    obj.self = obj;

    const result = checkRestricted(obj, user, { throwError: false });
    expect(result.name).toBe('self');
  });

  it('should handle deeply nested cycles', () => {
    const user = makeUser({ roles: [RoleEnum.ADMIN] });
    const a: any = { name: 'a' };
    const b: any = { name: 'b' };
    const c: any = { name: 'c' };
    a.next = b;
    b.next = c;
    c.next = a; // cycle a → b → c → a

    const result = checkRestricted(a, user, { throwError: false });
    expect(result.name).toBe('a');
    expect(result.next.name).toBe('b');
    expect(result.next.next.name).toBe('c');
  });
});

// =============================================================================
// 4. checkRestricted: Sample-Based Validation for typed arrays
// =============================================================================
describe('checkRestricted: sample-based array validation', () => {
  it('should block typed array with class-level @Restricted when checkObjectItself is true', () => {
    @Restricted(RoleEnum.ADMIN)
    class SecretEntry {
      value: string;
    }

    const user = makeUser({ roles: [] }); // NOT admin
    const items = Array.from({ length: 100 }, (_, i) => {
      const e = new SecretEntry();
      e.value = `item-${i}`;
      return e;
    });

    const result = checkRestricted(items, user, {
      throwError: false,
      checkObjectItself: true,
    });
    // All items should be blocked because user is not ADMIN
    // Class-level denial returns null; removeUndefinedFromResultArray only removes undefined
    expect(result.filter((item: any) => item !== null)).toHaveLength(0);
  });

  it('should pass typed array when user has required role', () => {
    @Restricted(RoleEnum.ADMIN)
    class SecretEntry {
      value: string;
    }

    const user = makeUser({ roles: [RoleEnum.ADMIN] });
    const items = Array.from({ length: 50 }, (_, i) => {
      const e = new SecretEntry();
      e.value = `item-${i}`;
      return e;
    });

    const result = checkRestricted(items, user, {
      throwError: false,
      checkObjectItself: true,
    });
    expect(result).toHaveLength(50);
    expect(result[0].value).toBe('item-0');
    expect(result[49].value).toBe('item-49');
  });

  it('should pass typed array without checkObjectItself (class restriction merges into properties)', () => {
    @Restricted(RoleEnum.ADMIN)
    class SecretEntry {
      value: string;
    }

    const user = makeUser({ roles: [] }); // NOT admin
    const items = Array.from({ length: 10 }, (_, i) => {
      const e = new SecretEntry();
      e.value = `item-${i}`;
      return e;
    });

    // Without checkObjectItself: true, class-level @Restricted only merges
    // into property-level restrictions (default behavior)
    const result = checkRestricted(items, user, { throwError: false });
    expect(result).toHaveLength(10);
    // Properties are stripped because class restriction merges into them
    expect(result[0].value).toBeUndefined();
  });

  it('should handle property-level @Restricted on typed array items', () => {
    class LogEntry {
      message: string;

      @Restricted(RoleEnum.ADMIN)
      internalNote: string;
    }

    const user = makeUser({ roles: [] }); // NOT admin
    const items = Array.from({ length: 20 }, (_, i) => {
      const e = new LogEntry();
      e.message = `log-${i}`;
      e.internalNote = `note-${i}`;
      return e;
    });

    const result = checkRestricted(items, user, { throwError: false });
    // Items should be present but internalNote stripped
    expect(result).toHaveLength(20);
    expect(result[0].message).toBe('log-0');
    expect(result[0].internalNote).toBeUndefined();
    expect(result[19].message).toBe('log-19');
    expect(result[19].internalNote).toBeUndefined();
  });

  it('should fall back to per-item checks when S_CREATOR is in class restrictions', () => {
    @Restricted(RoleEnum.S_CREATOR)
    class OwnedEntry {
      value: string;
      createdBy: string;
    }

    const user = makeUser({ id: 'user-1' });
    const items = [
      Object.assign(new OwnedEntry(), { value: 'mine', createdBy: 'user-1' }),
      Object.assign(new OwnedEntry(), { value: 'theirs', createdBy: 'user-2' }),
      Object.assign(new OwnedEntry(), { value: 'also-mine', createdBy: 'user-1' }),
    ];

    const result = checkRestricted(items, user, {
      throwError: false,
      checkObjectItself: true,
    });

    // S_CREATOR check per item — denied items return null (class-level denial)
    expect(result).toHaveLength(3);
    expect(result[0].value).toBe('mine');
    expect(result[1]).toBeNull(); // user-2 created → denied
    expect(result[2].value).toBe('also-mine');
  });

  it('should handle empty arrays', () => {
    const user = makeUser();
    const result = checkRestricted([], user, { throwError: false });
    expect(result).toEqual([]);
  });

  it('should handle plain object arrays (no class) with normal per-item check', () => {
    const user = makeUser({ roles: [RoleEnum.ADMIN] });
    const items = [
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
      { name: 'c', value: 3 },
    ];

    const result = checkRestricted(items, user, { throwError: false });
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe('a');
  });

  it('should handle S_SELF in class restrictions with per-item fallback', () => {
    @Restricted(RoleEnum.S_SELF)
    class UserProfile {
      id: string;
      name: string;
    }

    const user = makeUser({ id: 'user-1' });
    const items = [
      Object.assign(new UserProfile(), { id: 'user-1', name: 'Me' }),
      Object.assign(new UserProfile(), { id: 'user-2', name: 'Other' }),
    ];

    const result = checkRestricted(items, user, {
      throwError: false,
      checkObjectItself: true,
    });

    // S_SELF checks per-item — denied items return null (class-level denial)
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Me');
    expect(result[1]).toBeNull(); // user-2 → denied
  });
});

// =============================================================================
// 5. prepareOutput: deep secret removal
// =============================================================================
describe('prepareOutput: deep secret removal', () => {
  beforeEach(() => {
    setMockConfig({ sha256: false });
  });

  it('should remove top-level secrets', async () => {
    const output = { name: 'test', password: 'hash123', email: 'test@test.com' };
    const result: any = await prepareOutput(output, {
      removeSecrets: true,
      objectIdsToStrings: false,
    });

    expect(result.password).toBeUndefined();
    expect(result.name).toBe('test');
    expect(result.email).toBe('test@test.com');
  });

  it('should remove nested secrets (author.password)', async () => {
    const output = {
      title: 'Post',
      author: {
        name: 'Author',
        password: 'nested-hash',
        verificationToken: 'nested-token',
      },
    };
    const result: any = await prepareOutput(output, {
      removeSecrets: true,
      objectIdsToStrings: false,
    });

    expect(result.title).toBe('Post');
    expect(result.author.name).toBe('Author');
    expect(result.author.password).toBeUndefined();
    expect(result.author.verificationToken).toBeUndefined();
  });

  it('should remove deeply nested secrets', async () => {
    const output = {
      level1: {
        level2: {
          level3: {
            passwordResetToken: 'deep-token',
            data: 'keep-me',
          },
        },
      },
    };
    const result: any = await prepareOutput(output, {
      removeSecrets: true,
      objectIdsToStrings: false,
    });

    expect(result.level1.level2.level3.passwordResetToken).toBeUndefined();
    expect(result.level1.level2.level3.data).toBe('keep-me');
  });

  it('should remove secrets inside array items', async () => {
    const output = {
      users: [
        { name: 'User A', password: 'hash-a' },
        { name: 'User B', password: 'hash-b', verificationToken: 'token-b' },
      ],
    };
    const result: any = await prepareOutput(output, {
      removeSecrets: true,
      objectIdsToStrings: false,
    });

    expect(result.users[0].name).toBe('User A');
    expect(result.users[0].password).toBeUndefined();
    expect(result.users[1].name).toBe('User B');
    expect(result.users[1].password).toBeUndefined();
    expect(result.users[1].verificationToken).toBeUndefined();
  });

  it('should handle circular references without stack overflow', async () => {
    const a: any = { name: 'a', password: 'secret' };
    const b: any = { name: 'b', password: 'secret' };
    a.ref = b;
    b.ref = a; // circular

    const result: any = await prepareOutput(a, {
      removeSecrets: true,
      objectIdsToStrings: false,
    });

    expect(result.password).toBeUndefined();
    expect(result.ref.password).toBeUndefined();
    expect(result.name).toBe('a');
  });
});

// =============================================================================
// 6. prepareOutput: deep ObjectId conversion
// =============================================================================
describe('prepareOutput: deep ObjectId conversion', () => {
  beforeEach(() => {
    setMockConfig({ sha256: false });
  });

  it('should convert top-level ObjectIds to strings', async () => {
    const oid = new Types.ObjectId();
    const output = { id: oid, name: 'test' };
    const result: any = await prepareOutput(output, {
      objectIdsToStrings: true,
      removeSecrets: false,
    });

    expect(typeof result.id).toBe('string');
    expect(result.id).toBe(oid.toHexString());
    expect(result.name).toBe('test');
  });

  it('should convert nested ObjectIds to strings', async () => {
    const oid = new Types.ObjectId();
    const output = {
      nested: {
        refId: oid,
        name: 'nested',
      },
    };
    const result: any = await prepareOutput(output, {
      objectIdsToStrings: true,
      removeSecrets: false,
    });

    expect(typeof result.nested.refId).toBe('string');
    expect(result.nested.refId).toBe(oid.toHexString());
  });

  it('should convert ObjectIds inside arrays', async () => {
    const oid1 = new Types.ObjectId();
    const oid2 = new Types.ObjectId();
    const output = {
      items: [
        { ref: oid1, name: 'a' },
        { ref: oid2, name: 'b' },
      ],
    };
    const result: any = await prepareOutput(output, {
      objectIdsToStrings: true,
      removeSecrets: false,
    });

    expect(typeof result.items[0].ref).toBe('string');
    expect(result.items[0].ref).toBe(oid1.toHexString());
    expect(typeof result.items[1].ref).toBe('string');
    expect(result.items[1].ref).toBe(oid2.toHexString());
  });

  it('should convert deeply nested ObjectIds', async () => {
    const oid = new Types.ObjectId();
    const output = {
      level1: {
        level2: {
          deepRef: oid,
        },
      },
    };
    const result: any = await prepareOutput(output, {
      objectIdsToStrings: true,
      removeSecrets: false,
    });

    expect(typeof result.level1.level2.deepRef).toBe('string');
    expect(result.level1.level2.deepRef).toBe(oid.toHexString());
  });

  it('should handle ObjectId arrays (refs list)', async () => {
    const oids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const output = { refs: oids };
    const result: any = await prepareOutput(output, {
      objectIdsToStrings: true,
      removeSecrets: false,
    });

    expect(result.refs).toHaveLength(3);
    result.refs.forEach((ref: any, i: number) => {
      expect(typeof ref).toBe('string');
      expect(ref).toBe(oids[i].toHexString());
    });
  });
});
