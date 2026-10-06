---
name: pnpm11-registry-env-and-old-script-replay
description: pnpm 11.13.1 ignores npm_config_registry (audit AND config get), honours pnpm_config_registry, and answers an unreachable registry with error JSON + exit 0; plus a recipe to replay an OLD ROOT-relative script without touching the repo
metadata:
  type: reference
---

Measured 2026-10-06 in nest-server with pnpm 11.13.1 (wave 2c review of 11.42.6 / commit 926b691):

| Command | Result |
|---|---|
| `pnpm_config_registry=http://127.0.0.1:9/ pnpm audit --json` | `{"error":{"code":"pnpm","message":"fetch failed"}}`, **exit 0** |
| `npm_config_registry=http://127.0.0.1:9/ pnpm audit --json` | normal report from npmjs.org (variable ignored) |
| `npm_config_registry=… pnpm config get registry` | `https://registry.npmjs.org/` (ignored) |
| `pnpm_config_registry=… pnpm config get registry` | `http://127.0.0.1:9/` |

**Why it matters:** an earlier (2026-09-04) comment in the shared registry block claimed the
opposite for `npm_config_registry`, measured on an older pnpm. Registry-env claims are
pnpm-version-specific; re-measure after any `packageManager` bump rather than trusting a comment.

**Replaying a pre-fix script** to verify a guide's "it used to print X" claim, without writing into
the repo: `scripts/check-overrides.mjs` resolves `ROOT` from its own location, so build a scratch
root with symlinks to `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and drop
`git show <sha>^:scripts/check-overrides.mjs` into `<scratch>/scripts/`. The 926b691^ guard printed
`ok — 19 override(s) checked against 0 advisory/advisories … none is failing`, exit 0, for an
error-JSON `--audit-file` — the guide's claim was exact.

Related: [[audit-suppression-has-no-rule-doc-home]], [[number-drift-in-tooling-prose]].
