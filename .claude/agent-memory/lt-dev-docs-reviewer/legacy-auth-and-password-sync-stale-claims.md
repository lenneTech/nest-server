---
name: legacy-auth-and-password-sync-stale-claims
description: Two doc surfaces asserted the OPPOSITE of the code for auth.legacyEndpoints and the IAM->legacy password sync — both fixed in 11.38.0, but re-check them on every auth/password change
metadata:
  type: project
---

Two long-lived doc surfaces in this repo drifted into asserting the OPPOSITE of what the code did,
and nothing compiles or tests either of them. Both were corrected in 11.38.0. The reason to keep
this note is not the two fixes — it is that this pair goes stale silently and did so for a long
time before anyone looked.

**Check BOTH whenever `auth.legacyEndpoints` or the Legacy<->IAM password sync is touched:**

1. **`.env.example`, the `LEGACY_AUTH_ENABLED` block.** It stated `Default: true (legacy endpoints
   active)` while 11.38.0 inverted the default to `process.env.LEGACY_AUTH_ENABLED === 'true'` —
   telling a deployer the exact opposite of what production does. Corrected in 11.38.0.
2. **`src/core/modules/better-auth/README.md`, the "Bidirectional Password Synchronization"
   section.** The sync table and the "IAM Password Reset -> Legacy Sync" section said the framework
   **cannot** sync an IAM reset to legacy, and recommended a custom controller override. 11.38.0
   implements exactly that sync (`emailAndPassword.onPasswordReset` + the reset registry), so both
   the claim and its workaround became false. Corrected in 11.38.0; the workaround section now says
   "retired, do not build this".

**Why this pair specifically:** `.env.example` is the surface a deployer scans, and a README mention
is no substitute for it. The better-auth README ships in the npm tarball and into vendor-mode trees.
And a "we cannot do X" claim is the worst kind of stale doc — readers build workarounds around it,
which is precisely what happened.

**How to apply:** on any diff touching `auth.legacyEndpoints`, `syncPasswordChangeToIam`,
`syncPasswordToLegacy` or `onPasswordReset`, grep both files and grade Configuration Documentation
and Module Documentation against them explicitly. Do not assume they are still right because they
were fixed once — that assumption is what let them drift the first time.

Related: [[doc-surfaces-for-config-features]], [[number-drift-in-tooling-prose]]
