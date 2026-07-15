# Package Management Rules

This document defines the rules for managing dependencies in package.json.

## Package Manager: pnpm

This project uses **pnpm** for development. The `packageManager` field in `package.json` ensures the correct version is used (via Corepack).

```bash
# Install dependencies
pnpm install

# Add a new package (fixed version)
pnpm add express@4.18.2

# Add a dev dependency
pnpm add -D typescript@5.3.3

# Remove a package
pnpm remove package-name
```

## Fixed Versions Only

**All package versions in package.json MUST be exact (fixed) versions.**

### Rules

| Allowed | Not Allowed |
|---------|-------------|
| `"express": "4.18.2"` | `"express": "^4.18.2"` |
| `"typescript": "5.3.3"` | `"typescript": "~5.3.3"` |
| `"lodash": "4.17.21"` | `"lodash": ">=4.0.0"` |
| | `"lodash": "4.x"` |
| | `"lodash": "*"` |

### Why Fixed Versions?

1. **Reproducibility**: Every installation produces identical `node_modules`
2. **Stability**: No surprise breaking changes from automatic minor/patch updates
3. **Security Control**: Updates are intentional and reviewed, not automatic
4. **Debugging**: Easier to identify which version introduced issues
5. **Framework Responsibility**: As a framework, we must ensure consuming projects get predictable behavior

### When Adding New Packages

```bash
# CORRECT: Install with exact version
pnpm add express@4.18.2

# Then verify package.json has exact version (no ^ or ~)
```

If pnpm adds `^` automatically, manually remove it from package.json.

### When Updating Packages

```bash
# Use pnpm update or manually update
pnpm update package-name

# Or manually edit package.json with exact version
```

Always:
1. Update to exact version
2. Run `pnpm install`
3. Run `pnpm test`
4. Verify no regressions

### Checking for Version Ranges

To find packages with version ranges:

```bash
# Find all dependencies with ^ or ~
grep -E '"\^|"~' package.json
```

### Common Mistakes

| Mistake | Fix |
|---------|-----|
| pnpm adds `^` by default | Remove `^` after install |
| Copying from other projects | Verify versions are fixed |
| Using `pnpm add package` without version | Specify exact version: `pnpm add package@1.2.3` |

## devDependencies

The same rules apply to devDependencies. All versions must be fixed.

## peerDependencies

peerDependencies may use ranges when necessary for compatibility with consuming projects, but this should be minimized.

## Lock File

The `pnpm-lock.yaml` file must always be committed. It provides additional reproducibility even if someone accidentally introduces a version range.

## Package Manager: pnpm 11

This repo is pinned to **pnpm 11** via the `packageManager` field (corepack/`pnpm/action-setup` follow it, so CI and Docker use it automatically — no version is hardcoded anywhere else).

pnpm 11 **no longer reads the `pnpm` field in `package.json`**, and `.npmrc` is auth/registry only. All pnpm-specific settings live in **`pnpm-workspace.yaml`**:

- `overrides:` — the security overrides (see below)
- `allowBuilds:` — a **map** of `pkg: true|false` classifying every package that has an install script (canonical v11 form; replaces `onlyBuiltDependencies`). Native builds we need are `true` (`bcrypt`, `@swc/core`, …); telemetry like `@scarf/scarf` is `false`. **Every build-script package must be classified**, or `pnpm install` exits non-zero with `ERR_PNPM_IGNORED_BUILDS` and appends a broken stub.
- `nodeLinker`, `autoInstallPeers`, `strictPeerDependencies`, `peerDependencyRules` — moved here from `.npmrc` (camelCase).

`pnpm audit`: pnpm 10.x is broken (npm retired the legacy audit endpoint → HTTP 410); pnpm 11 uses the working bulk-advisory endpoint. `scripts/check.mjs` degrades the retired-endpoint failure to a non-blocking warning as a safety net, so `check` stays green + honest even if a future endpoint change lands.

## Overrides

Package overrides live in the `overrides:` section of **`pnpm-workspace.yaml`** (they moved out of `package.json`'s `pnpm.overrides` in the pnpm 11 upgrade). They force transitive dependencies to a security-patched version.

**Keep the set minimal.** On the pnpm 11 upgrade the list was pruned from 36 to the 9 still load-bearing — an override is only necessary if removing it lets the package resolve back INTO its vulnerable range (verify with a with/without lockfile diff; `pnpm audit` is the arbiter). Each surviving entry carries its CVE rationale as a comment. Remove an entry once its parent dependency ships a fixed version.

### Rule: Override Targets MUST Be Fixed Versions

The **target** of an override (the value on the right-hand side) MUST be a fixed version — the **same exact-versioning rule that applies to direct dependencies applies here**. Never use range selectors (`>=`, `^`, `~`, `*`) as override targets.

| Allowed | Not Allowed | Reason |
|---------|-------------|--------|
| `"lodash": "4.17.23"` | `"lodash": ">=4.17.23"` | `>=` is unbounded — pnpm installs the latest, possibly crossing a major version |
| `"vite": "7.3.2"` | `"vite": ">=7.3.2"` | Would allow `vite@8.x.y` to be installed |
| `"@apollo/server": "5.5.0"` | `"@apollo/server": "^5.5.0"` | Defeats the purpose of an override |

### Key Selector Forms

The **key** (left-hand side) of an override entry selects which installed versions the override applies to. Both forms are valid:

```yaml
# pnpm-workspace.yaml
overrides:
  # Form 1: Replace ALL versions of a package with a fixed one
  'lodash': '4.17.23'
  # Form 2: Replace only vulnerable versions with a fixed patched one
  'minimatch@<3.1.4': '3.1.4'
  'path-to-regexp@>=8.0.0 <8.4.0': '8.4.2'
```

Form 2 is preferred for security-driven overrides because it leaves non-vulnerable versions untouched, which reduces the blast radius of the override.

### Never Use Unbounded Range Targets

**Incident (TurboOps, April 2026):** A security audit added the override `"vite@>=7.0.0 <=7.3.1": ">=7.3.2"` intending to force `vite` onto the 7.3.2 patched version. Because the target `">=7.3.2"` is unbounded on the upper end, pnpm resolved it to the latest matching version — `vite@8.0.8` — silently performing a major version upgrade. This cascaded into broken peer dependencies in `@nuxt/test-utils`, `better-auth` (drizzle-orm peer dropped), and vitest, and caused 13 e2e test regressions in the `server` module.

The fix was to change every override target to a fixed version:

```json
// WRONG — unbounded, allows major jumps
"vite@>=7.0.0 <=7.3.1": ">=7.3.2"
"drizzle-orm@<0.45.2": ">=0.45.2"
"@apollo/server@<5.5.0": ">=5.5.0"

// RIGHT — fixed target, no surprise upgrades
"vite": "7.3.2"
"drizzle-orm": "0.45.2"
"@apollo/server": "5.5.0"
```

### Safe Override Workflow

When adding an override to fix a vulnerability:

1. Identify the exact patched version from the advisory (e.g. `vite >= 7.3.2`)
2. Check the latest fixed version **within the same major** (e.g. `7.x.y`) via `pnpm view <pkg> versions`
3. Use that specific version as the override target: `"pkg@<7.3.2": "7.3.2"` (or just `"pkg": "7.3.2"`)
4. Run `pnpm install && pnpm run build && pnpm test` — verify nothing regresses
5. Run `pnpm audit` — verify the vulnerability is gone
6. Commit both `package.json` and `pnpm-lock.yaml`

### Document Why Each Override Exists

Override entries without context become unmaintainable over time. Add a brief comment-style key or keep a parallel `OVERRIDES.md` documenting for each entry: which CVE/advisory, which package pulls in the vulnerable version, and when the override can be removed. Example:

```json
// brace-expansion@1 — RegExp DoS (GHSA-v6h2-p8h4-qcjw), pulled in by @nestjs/cli>fork-ts-checker-webpack-plugin>minimatch
"brace-expansion@<1.1.13": "1.1.13"
```
