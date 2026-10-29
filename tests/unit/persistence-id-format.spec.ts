import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { checkStringIds } from '../../src/core/common/helpers/db.helper';
import { equalIds, getStringIds } from '../../src/core/common/helpers/id.helper';
import { isObjectIdLike, isWellFormedId } from '../../src/core/common/persistence/id-format';

/** The shape of a bson ObjectId whose `id` is a plain Uint8Array (a bson build without Node's Buffer). */
class PortableObjectId {
  readonly #bytes = Uint8Array.from([0x65, 0x1f, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  get _bsontype(): string {
    return 'ObjectId';
  }
  get id(): Uint8Array {
    return this.#bytes;
  }
  toHexString(): string {
    return Array.from(this.#bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
}

describe('opaque ids', () => {
  describe('isWellFormedId', () => {
    it.each([
      ['24 lowercase hex characters', '651f00010203040506070809', true],
      ['24 uppercase hex characters', '651F00010203040506070809', true],
      ['23 characters', '651f0001020304050607080', false],
      ['25 characters', '651f000102030405060708090', false],
      ['a non-hex character', '651f0001020304050607080g', false],
      ['a 12-character string (an ObjectId seed for Mongo, never a stored id)', 'abcdefghijkl', false],
      ['an empty string', '', false],
    ])('%s → %s', (_label, value, expected) => {
      expect(isWellFormedId(value)).toBe(expected);
    });

    it('accepts ObjectIds, also from another bson copy', () => {
      expect(isWellFormedId(new Types.ObjectId())).toBe(true);
      expect(isWellFormedId(new PortableObjectId())).toBe(true);
    });

    it.each([null, undefined, 42, {}, [], { toHexString: 'no' }])('refuses %j', (value) => {
      expect(isWellFormedId(value)).toBe(false);
    });

    /**
     * `checkStringIds()` and `CoreFileService.isMalformedFileId()` now delegate to `isWellFormedId()`.
     * For strings this must be exactly the rule they had: 24 characters AND `Types.ObjectId.isValid()`.
     */
    it('is, for strings, exactly the previous rule (length 24 and Types.ObjectId.isValid)', () => {
      const corpus = [
        '651f00010203040506070809',
        'ffffffffffffffffffffffff',
        'FFFFFFFFFFFFFFFFFFFFFFFF',
        '000000000000000000000000',
        'abcdefghijkl',
        'zzzzzzzzzzzzzzzzzzzzzzzz',
        '651f0001020304050607080 ',
        ' 651f0001020304050607080',
        '651f000102030405060708ä9',
        '',
        new Types.ObjectId().toHexString(),
      ];
      for (const value of corpus) {
        expect(isWellFormedId(value), value).toBe(value.length === 24 && Types.ObjectId.isValid(value));
      }
    });

    it('keeps checkStringIds() unchanged', () => {
      expect(checkStringIds('651f00010203040506070809')).toBe(true);
      expect(checkStringIds(['651f00010203040506070809', 'abcdefghijkl'])).toBe(false);
      expect(checkStringIds([42 as any])).toBe(false);
    });
  });

  describe('isObjectIdLike', () => {
    it('recognises ObjectIds by their bson type tag, not by class identity', () => {
      expect(isObjectIdLike(new Types.ObjectId())).toBe(true);
      expect(isObjectIdLike(new PortableObjectId())).toBe(true);
      expect(isObjectIdLike({ toHexString: () => 'x' })).toBe(false);
      expect(isObjectIdLike('651f00010203040506070809')).toBe(false);
    });
  });

  describe('id normalisation', () => {
    it('turns any ObjectId into its hex string, also one whose id bytes are a plain Uint8Array', () => {
      const portable = new PortableObjectId();
      expect(getStringIds(portable)).toBe('651f00010203040506070809');
      expect(getStringIds({ _id: portable })).toBe('651f00010203040506070809');
      expect(equalIds(portable, '651f00010203040506070809')).toBe(true);
    });

    it('keeps normalising mongoose ObjectIds, documents and strings as before', () => {
      const id = new Types.ObjectId();
      expect(getStringIds(id)).toBe(id.toHexString());
      expect(getStringIds({ id: id.toHexString() })).toBe(id.toHexString());
      expect(getStringIds({ _id: id })).toBe(id.toHexString());
      expect(getStringIds([id, id.toHexString()])).toEqual([id.toHexString(), id.toHexString()]);
    });
  });

  describe('the id types are driver-neutral', () => {
    it.each(['id.type.ts', 'string-or-object-id.type.ts', 'ids.type.ts', 'object-id-like.type.ts'])(
      '%s imports nothing from mongoose',
      (file) => {
        const source = readFileSync(join(__dirname, '../../src/core/common/types', file), 'utf8');
        expect(source).not.toMatch(/from ['"](mongoose|mongodb|bson)['"]/);
      },
    );
  });
});
