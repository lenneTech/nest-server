import { randomBytes } from 'node:crypto';

/**
 * An ObjectId where Mongoose is not installed: the same 12 bytes (4 bytes of seconds, 5 random bytes per process, a
 * 3-byte counter), the same hex form, and the members the framework reads from one — `toHexString()`, `toString()`,
 * `toJSON()`, `equals()`, `getTimestamp()` and the `_bsontype` tag `isObjectIdLike()` recognises. A project without
 * MongoDB stores ids as these hex strings (plan §3.5), so code written against `Types.ObjectId` keeps working there.
 *
 * Import-free leaf.
 */
export class HexObjectId {
  readonly _bsontype = 'ObjectId';
  private readonly hex: string;

  constructor(value?: { toHexString(): string } | string) {
    if (value === undefined || value === null) {
      this.hex = generateHex();
      return;
    }
    const hex = typeof value === 'string' ? value : value.toHexString();
    if (!HexObjectId.isValid(hex)) {
      // The message Mongoose's bson gives for the same input, so callers that match on it behave alike
      throw new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer');
    }
    this.hex = hex.toLowerCase();
  }

  /** A 24-character hex string or an ObjectId-like value */
  static isValid(value: unknown): boolean {
    if (typeof value === 'string') {
      return /^[0-9a-f]{24}$/i.test(value);
    }
    return (
      !!value &&
      typeof value === 'object' &&
      (value as { _bsontype?: unknown })._bsontype === 'ObjectId' &&
      typeof (value as { toHexString?: unknown }).toHexString === 'function'
    );
  }

  equals(other: unknown): boolean {
    if (typeof other === 'string') {
      return other.toLowerCase() === this.hex;
    }
    return HexObjectId.isValid(other) && (other as { toHexString(): string }).toHexString().toLowerCase() === this.hex;
  }

  getTimestamp(): Date {
    return new Date(Number.parseInt(this.hex.slice(0, 8), 16) * 1000);
  }

  toHexString(): string {
    return this.hex;
  }

  toJSON(): string {
    return this.hex;
  }

  toString(): string {
    return this.hex;
  }
}

const PROCESS_UNIQUE = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

function generateHex(): string {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0);
  PROCESS_UNIQUE.copy(bytes, 4);
  counter = (counter + 1) % 0x1000000;
  bytes.writeUIntBE(counter, 9, 3);
  return bytes.toString('hex');
}
