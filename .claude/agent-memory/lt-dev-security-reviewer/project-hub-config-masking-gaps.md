---
name: project-hub-config-masking-gaps
description: Empirically verified gaps in the Hub config masker (maskConfigDeep) — a password-only connection URI (redis://:pw@host) is NOT masked, and s3.accessKeyId is NOT matched by the key heuristic. Re-test with the one-liner here rather than reading the regex.
metadata:
  type: project
---

# `maskConfigDeep()` — the shapes that slip through

Verified empirically 2026-08-10 (nest-server 11.33.0, `src/core/modules/hub/helpers/hub-mask.helper.ts`).
`CoreHubService.getConfigMasked()` runs the WHOLE server config through it and serves the result at the
ADMIN-gated Hub config panel, so anything the masker misses is printed verbatim there.

Do not eyeball the regexes — they are subtle (the `i` flag makes `[^a-z]` reject uppercase too, so
`(^|[^a-z])key([^a-z]|$)` does not match `accessKeyId`). Run this instead:

```bash
node -e "
const K=/secret|passwd|password|passphrase|credential|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|encryption|\btoken\b|\bpass\b|(^|[^a-z])key([^a-z]|\$)/i;
const U=/^([a-z][a-z0-9+.-]*:\/\/[^\/@:\s]+:)([^@\/\s]+)(@)/i;
['accessKeyId','username','url'].forEach(k=>console.log(k, K.test(k)?'MASKED':'LEAKED'));
['redis://:pw@h:6379','redis://user:pw@h:6379'].forEach(u=>console.log(u, U.test(u)?'MASKED':'LEAKED'));
"
```

## The two confirmed gaps

1. **Password-only URI is LEAKED.** `URI_CREDENTIAL_PATTERN` requires `[^/@:\s]+` — at least one
   character — for the userinfo USER part. `redis://:s3cr3t@host:6379` has an empty user, so it does
   not match and the password is printed in full. That is the canonical Redis URL shape (Redis < 6
   has no username; managed providers, `redis-cli -u` and Heroku all emit it). Same for `amqp://:pw@h`.
   The repo's own docs only ever show `redis://user:pass@…`, which IS masked — so the examples hide it.
   Fix: `+` → `*` in the user-part class. Verified safe: `http://host:8080/x@y` still does not match,
   because the password group cannot contain `/`.

2. **`s3.accessKeyId` is LEAKED** (`secretAccessKey` is masked). Low value on its own, but it names
   the AWS account.

## How to apply

- When a release adds a new config block, run the one-liner over its key names BEFORE assuming the
  masker covers them. Key-name heuristics are the whole mechanism — there is no allow-list.
- `security.secretFields` entries are passed in as `extraSecretKeys` and matched EXACTLY
  (lower-cased), so a project can close a gap without touching the framework.
- The masker deep-clones first, deliberately: `CheckSecurityInterceptor` deletes secret-named keys
  IN PLACE, so handing it the live config object would corrupt the running server.

Related: [[project-hub-module-security-model]], [[project-ai-module-secret-stripping]]
