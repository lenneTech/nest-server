// Shared fixture for the where-parity prototypes (data + cases), extracted from 03.
import { MongoClient } from 'mongodb';
// ---------- data, identical in both stores ----------
export const d = (s) => new Date(s);
export const people = [
  { id: 'p1', name: 'Anna', age: 31, active: true, createdAt: d('2026-01-01'), score: 9.5, tags: ['a', 'b'], roles: ['admin'], address: { city: 'Berlin', zip: '10115', floor: 3 }, contacts: [{ kind: 'mail', value: 'a@test.com', primary: true }] },
  { id: 'p2', name: 'Bernd', age: 45, active: false, createdAt: d('2026-02-01'), score: null, tags: ['b'], roles: [], address: { city: 'Köln', zip: '50667' }, contacts: [] },
  { id: 'p3', name: 'carla', age: 22, active: true, createdAt: d('2026-03-01'), tags: [], roles: ['editor'], address: { city: 'berlin', floor: 0 }, contacts: [{ kind: 'phone', value: '123', primary: false }, { kind: 'mail', value: 'c@test.com', primary: false }] },
  { id: 'p4', name: 'Dora', age: null, active: true, createdAt: d('2026-04-01'), score: 3, tags: ['c', 'a'], roles: ['admin', 'editor'] },
  { id: 'p5', name: 'Emil', active: false, createdAt: d('2026-05-01'), score: 7, tags: ['a'], roles: ['viewer'], address: { city: 'Hamburg', zip: '20095', floor: 12 } },
  { id: 'p6', name: 'Frida', age: 60, active: true, createdAt: d('2026-06-01'), score: 1, tags: ['d'], roles: [], address: null },
];

export const connectMongo = () => MongoClient.connect('mongodb://127.0.0.1:27017');


export const cases = [
  { name: 'equality', where: { name: 'Anna' } },
  { name: '$ne includes missing/null like Mongo', where: { age: { $ne: 31 } } },
  { name: 'null matches null AND missing', where: { age: null } },
  { name: '$ne null', where: { age: { $ne: null } } },
  { name: '$gt / $lte range', where: { age: { $gt: 25, $lte: 45 } } },
  { name: '$in scalar', where: { name: { $in: ['Anna', 'Emil', 'X'] } } },
  { name: '$in with null', where: { score: { $in: [null, 7] } } },
  { name: '$nin includes missing', where: { age: { $nin: [31, 45] } } },
  { name: 'boolean', where: { active: false } },
  { name: 'date range', where: { createdAt: { $gte: d('2026-02-01'), $lt: d('2026-05-01') } } },
  { name: 'regex case-insensitive', where: { name: { $regex: '^[ab]', $options: 'i' } } },
  { name: 'RegExp object', where: { name: /a$/ } },
  { name: 'array contains element', where: { tags: 'a' } },
  { name: 'array $in', where: { tags: { $in: ['c', 'd'] } } },
  { name: 'array $all', where: { tags: { $all: ['a', 'b'] } } },
  { name: 'array $size', where: { roles: { $size: 0 } } },
  { name: 'array $nin', where: { roles: { $nin: ['admin'] } } },
  { name: 'array $ne element', where: { roles: { $ne: 'editor' } } },
  { name: 'nested dot path', where: { 'address.city': 'Berlin' } },
  { name: 'nested regex i', where: { 'address.city': { $regex: '^berlin$', $options: 'i' } } },
  { name: 'nested numeric range', where: { 'address.floor': { $gte: 3 } } },
  { name: 'nested $exists', where: { 'address.zip': { $exists: false } } },
  { name: '$elemMatch', where: { contacts: { $elemMatch: { kind: 'mail', primary: false } } } },
  { name: '$or', where: { $or: [{ age: { $lt: 25 } }, { tags: 'd' }] } },
  { name: '$and + $or', where: { active: true, $or: [{ roles: 'admin' }, { 'address.city': 'berlin' }] } },
  { name: '$nor', where: { $nor: [{ active: false }, { tags: 'a' }] } },
  { name: '$not', where: { age: { $not: { $gt: 30 } } } },
  { name: 'id $in', where: { _id: { $in: ['p2', 'p6'] } } },
  { name: '$exists on column (DIFFERENT-BY-DESIGN expected for explicit null)', where: { age: { $exists: true } }, differentByDesign: true },
];
