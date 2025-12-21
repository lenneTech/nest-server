# Migration Guide: X.Y.x → X.Z.x

## Overview

| Category | Details |
|----------|---------|
| **Breaking Changes** | None / List them |
| **New Features** | List new features |
| **Bugfixes** | List bugfixes |
| **Migration Effort** | Estimated time |

---

## Quick Migration (No Breaking Changes)

```bash
# Update package
npm install @lenne.tech/nest-server@X.Z.x

# If package.json dependencies changed
npm run update

# Verify build
npm run build

# Run tests
npm test
```

---

## What's New in X.Z.x

### 1. Feature Name

Description of the feature and how to use it.

```typescript
// Code example
```

---

## Breaking Changes (If Any)

### Change 1: Description

**Before:**
```typescript
// Old code
```

**After:**
```typescript
// New code
```

---

## Detailed Migration Steps

### Step 1: Update Package

```bash
npm install @lenne.tech/nest-server@X.Z.x
```

### Step 2: Address Breaking Changes

(Details for each breaking change)

### Step 3: Adopt New Features (Optional)

(Details for each new feature)

---

## Compatibility Notes

Notes about patterns that continue to work, custom implementations, etc.

---

## Troubleshooting

### Common Issue 1

Solution...

---

## Module Documentation

For detailed information about affected modules, link to their documentation:

### Module Name

- **README:** [src/core/modules/module-name/README.md](../src/core/modules/module-name/README.md)
- **Integration Checklist:** [src/core/modules/module-name/INTEGRATION-CHECKLIST.md](../src/core/modules/module-name/INTEGRATION-CHECKLIST.md) (if exists)
- **Reference Implementation:** `src/server/modules/module-name/`
- **Key Files:** List important files with brief descriptions

> **Note:** Only include modules that have changes relevant to this migration.
> Check for existing documentation using:
> - `src/core/modules/**/README.md`
> - `src/core/modules/**/INTEGRATION-CHECKLIST.md`

---

## References

- [Relevant documentation links]
- [nest-server-starter](https://github.com/lenneTech/nest-server-starter) (reference implementation)
