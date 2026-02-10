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

## Overrides

Package overrides are configured in the `pnpm.overrides` section of `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "lodash": "4.17.23"
    }
  }
}
```
