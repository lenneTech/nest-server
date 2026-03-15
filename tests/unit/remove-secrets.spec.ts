import { describe, expect, it } from 'vitest';

/**
 * Tests for the removeSecrets / isPlainLike logic in CheckSecurityInterceptor.
 *
 * The isPlainLike function determines which objects the interceptor recurses into
 * when removing secret fields. It must be strict enough to avoid infinite recursion
 * on Mongoose Schema.Types.Mixed fields (whose internal objects have circular references)
 * while still processing plain data objects from API responses.
 */

// Extracted isPlainLike logic (mirrors check-security.interceptor.ts)
function isPlainLike(val: any): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  if (typeof val.pipe === 'function') return false;
  if (Buffer.isBuffer(val)) return false;
  if (val instanceof Date || val instanceof RegExp) return false;
  if (val instanceof Map || val instanceof Set) return false;
  if (val.$__ !== undefined || val._bsontype !== undefined) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

// Extracted removeSecrets logic (mirrors check-security.interceptor.ts)
function removeSecrets(
  data: any,
  secretFields: string[] = ['password', 'verificationToken', 'passwordResetToken', 'refreshTokens', 'tempTokens'],
): any {
  if (!data || typeof data !== 'object') {
    return data;
  }
  const visited = new WeakSet();
  const process = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      if (visited.has(obj)) return obj;
      visited.add(obj);
      obj.forEach(process);
      return obj;
    }
    if (!isPlainLike(obj)) return obj;
    if (visited.has(obj)) return obj;
    visited.add(obj);
    for (const field of secretFields) {
      if (field in obj && obj[field] !== undefined) {
        obj[field] = undefined;
      }
    }
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object' && !secretFields.includes(key)) {
        process(value);
      }
    }
    return obj;
  };
  return process(data);
}

// =============================================================================
// isPlainLike tests
// =============================================================================
describe('isPlainLike', () => {
  it('should return true for plain objects', () => {
    expect(isPlainLike({})).toBe(true);
    expect(isPlainLike({ a: 1, b: 'test' })).toBe(true);
  });

  it('should return true for Object.create(null) objects', () => {
    expect(isPlainLike(Object.create(null))).toBe(true);
  });

  it('should return false for class instances', () => {
    class MyClass {
      name = 'test';
    }
    expect(isPlainLike(new MyClass())).toBe(false);
  });

  it('should return false for arrays', () => {
    expect(isPlainLike([])).toBe(false);
    expect(isPlainLike([1, 2, 3])).toBe(false);
  });

  it('should return false for primitives and null', () => {
    expect(isPlainLike(null)).toBe(false);
    expect(isPlainLike(undefined)).toBe(false);
    expect(isPlainLike(42)).toBe(false);
    expect(isPlainLike('string')).toBe(false);
    expect(isPlainLike(true)).toBe(false);
  });

  it('should return false for Date and RegExp', () => {
    expect(isPlainLike(new Date())).toBe(false);
    expect(isPlainLike(/test/)).toBe(false);
  });

  it('should return false for Map and Set', () => {
    expect(isPlainLike(new Map())).toBe(false);
    expect(isPlainLike(new Set())).toBe(false);
  });

  it('should return false for Buffer', () => {
    expect(isPlainLike(Buffer.from('test'))).toBe(false);
  });

  it('should return false for stream-like objects', () => {
    expect(isPlainLike({ pipe: () => {} })).toBe(false);
  });

  it('should return false for Mongoose document-like objects ($__)', () => {
    // Simulate Mongoose document internal marker
    const mongooseDoc = { $__: { activePaths: {} }, name: 'test', password: 'secret' };
    expect(isPlainLike(mongooseDoc)).toBe(false);
  });

  it('should return false for BSON-type objects (_bsontype)', () => {
    // Simulate BSON ObjectId-like object
    const objectId = { _bsontype: 'ObjectId', id: Buffer.from('123456789012') };
    expect(isPlainLike(objectId)).toBe(false);
  });

  it('should return false for Mongoose SchemaType-like objects', () => {
    // SchemaType has a custom prototype chain
    class SchemaType {
      path = 'name';
      instance = 'String';
    }
    expect(isPlainLike(new SchemaType())).toBe(false);
  });
});

// =============================================================================
// removeSecrets tests
// =============================================================================
describe('removeSecrets', () => {
  it('should remove secret fields from plain objects', () => {
    const data = { name: 'test', password: 'secret123', email: 'test@test.com' };
    removeSecrets(data);
    expect(data.password).toBeUndefined();
    expect(data.name).toBe('test');
    expect(data.email).toBe('test@test.com');
  });

  it('should remove secrets from nested plain objects', () => {
    const data = {
      user: {
        name: 'test',
        password: 'secret123',
        profile: {
          verificationToken: 'abc',
          bio: 'hello',
        },
      },
    };
    removeSecrets(data);
    expect(data.user.password).toBeUndefined();
    expect(data.user.profile.verificationToken).toBeUndefined();
    expect(data.user.name).toBe('test');
    expect(data.user.profile.bio).toBe('hello');
  });

  it('should handle arrays of plain objects', () => {
    const data = [
      { name: 'a', password: 'secret' },
      { name: 'b', passwordResetToken: 'token' },
    ];
    removeSecrets(data);
    expect(data[0].password).toBeUndefined();
    expect(data[1].passwordResetToken).toBeUndefined();
    expect(data[0].name).toBe('a');
    expect(data[1].name).toBe('b');
  });

  it('should not infinite-recurse on circular plain object references', () => {
    const a: any = { name: 'a', password: 'secret' };
    const b: any = { name: 'b', password: 'secret' };
    a.ref = b;
    b.ref = a; // circular reference

    // Should complete without stack overflow
    removeSecrets(a);
    expect(a.password).toBeUndefined();
    expect(b.password).toBeUndefined();
  });

  it('should not infinite-recurse on self-referencing objects', () => {
    const obj: any = { name: 'self', password: 'secret' };
    obj.self = obj; // self-reference

    removeSecrets(obj);
    expect(obj.password).toBeUndefined();
    expect(obj.name).toBe('self');
  });

  it('should not infinite-recurse on Mongoose-like internal structures', () => {
    // Simulate Schema.Types.Mixed with Mongoose-like internal circular references
    class SchemaType {
      schema: any;
      path: string;
      constructor(path: string) {
        this.path = path;
      }
    }
    class Schema {
      paths: Record<string, SchemaType> = {};
    }

    const schema = new Schema();
    const st = new SchemaType('mixedField');
    st.schema = schema; // circular: schemaType → schema
    schema.paths.mixedField = st; // circular: schema → schemaType

    // Data with Mongoose-like internals embedded (as might happen with Schema.Types.Mixed)
    const data = {
      name: 'test',
      password: 'secret',
      internalRef: schema as any, // class instance, not plain
    };

    // Should complete without stack overflow — isPlainLike rejects class instances
    removeSecrets(data);
    expect(data.password).toBeUndefined();
    expect(data.name).toBe('test');
  });

  it('should not recurse into Mongoose document-like objects', () => {
    const doc = {
      $__: { activePaths: {}, fields: {} },
      name: 'test',
      password: 'should-not-be-removed', // doc is not plain-like
    };

    removeSecrets(doc);
    // Not a plain object (has $__), so removeSecrets skips it entirely
    expect(doc.password).toBe('should-not-be-removed');
  });

  it('should not recurse into BSON-type objects', () => {
    const data = {
      _id: { _bsontype: 'ObjectId', id: Buffer.from('123456789012') },
      password: 'secret',
    };

    removeSecrets(data);
    expect(data.password).toBeUndefined();
    // _id is not touched (BSON type)
    expect(data._id._bsontype).toBe('ObjectId');
  });

  it('should handle deeply nested circular structures without stack overflow', () => {
    // Create a chain: a → b → c → d → a (4-node cycle with plain objects)
    const a: any = { name: 'a', password: 'secret-a' };
    const b: any = { name: 'b', password: 'secret-b' };
    const c: any = { name: 'c', verificationToken: 'token-c' };
    const d: any = { name: 'd', passwordResetToken: 'token-d' };
    a.next = b;
    b.next = c;
    c.next = d;
    d.next = a; // circular

    removeSecrets(a);
    expect(a.password).toBeUndefined();
    expect(b.password).toBeUndefined();
    expect(c.verificationToken).toBeUndefined();
    expect(d.passwordResetToken).toBeUndefined();
    expect(a.name).toBe('a');
    expect(d.name).toBe('d');
  });

  it('should handle mixed arrays with circular references', () => {
    const obj: any = { name: 'root', password: 'secret' };
    const arr: any[] = [obj, { nested: obj }];
    obj.items = arr; // circular: obj → arr → obj

    removeSecrets(obj);
    expect(obj.password).toBeUndefined();
  });

  it('should handle Schema.Types.Mixed-like field with deeply nested plain data', () => {
    // Simulate a response with a Mixed field containing valid plain data
    const data = {
      name: 'document',
      mixedField: {
        key1: 'value1',
        nested: {
          key2: 'value2',
          password: 'should-be-removed',
          deep: {
            refreshTokens: ['token1', 'token2'],
          },
        },
      },
    };

    removeSecrets(data);
    expect(data.mixedField.nested.password).toBeUndefined();
    expect(data.mixedField.nested.deep.refreshTokens).toBeUndefined();
    expect(data.mixedField.key1).toBe('value1');
    expect(data.mixedField.nested.key2).toBe('value2');
  });
});
