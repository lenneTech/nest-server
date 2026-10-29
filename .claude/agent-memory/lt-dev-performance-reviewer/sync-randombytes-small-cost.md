---
name: sync-randombytes-small-cost
description: Measured: sync crypto.randomBytes(16).toString('hex') ~1.0 us/call, slightly FASTER than the old 32-digit Math.random loop (~1.15 us); sync randomBytes for small sizes is never a hot-path finding.
metadata:
  type: project
---

Measured 2026-10-29 (Node, this laptop, 200k calls x 5 runs, rotated min/median) while reviewing DEV-3897's
`multerRandomFileName()` switch (`src/core/common/helpers/file.helper.ts`):

- old `Array(32).fill().map(() => Math.round(Math.random()*16).toString(16)).join('')`: ~1145-1180 ns/call
- new `randomBytes(16).toString('hex').slice(0, 32)`: ~960-1010 ns/call

**Why:** the Phase 5 grep (`crypto\..*Sync`, sync crypto in async context) flags `randomBytes()` without a callback;
for small sizes it is an OpenSSL CSPRNG read, not a threadpool job and not a blocking call once the system pool is
seeded (only very early OS boot can block).

**How to apply:** do not report sync `randomBytes(n)` for token/name-sized n (tens of bytes) as sync-in-async. Only
large sizes (MBs) or a loop of thousands per request would be worth measuring. Contrast with scrypt/bcrypt, which DO
occupy the libuv threadpool — see the auth-endpoint note in `.claude/rules/testing.md` ("Known coverage gap").
