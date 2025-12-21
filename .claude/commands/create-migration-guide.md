# Create Migration Guide

Create a migration guide for the current version changes.

## Instructions

### Step 1: Check Version Status

First, check if the package version has been modified since the last release:

```bash
# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Get the last released version (latest git tag)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")

# Check if package.json was modified
git diff --name-only HEAD~10 | grep -q "package.json" && echo "package.json modified" || echo "package.json unchanged"
```

### Step 2: Determine Version

Compare the current version with the last tag:

- If versions match: Suggest incrementing PATCH version (e.g., 11.7.1 → 11.7.2)
- If MINOR already incremented: Use current version for migration guide
- Present options to the user:
  - Use current version
  - Increment PATCH (bugfix)
  - Increment MINOR (breaking change / new features)

### Step 3: Check for Existing Migration Guide

Check if a migration guide already exists for this version range:

```bash
ls migration-guides/*.md
```

If a guide exists for the current MINOR version range (e.g., 11.6.x-to-11.7.x), ask user:
- Update existing guide
- Create new guide for next version

### Step 4: Analyze Changes

Analyze changes since last release:

```bash
# Get commits since last tag
git log $LAST_TAG..HEAD --oneline

# Get changed files
git diff --name-only $LAST_TAG..HEAD
```

Focus on:
- `src/core/` changes (breaking changes, new features)
- `src/core/modules/` changes (module-specific updates)
- `package.json` dependency changes

### Step 5: Gather Project Information

Ask the user:
> Which projects should I analyze for migration compatibility?
> Please provide paths to projects using @lenne.tech/nest-server.
> (Leave empty to only analyze src/server/ and nest-server-starter)

Always analyze:
1. Local `src/server/`
2. [nest-server-starter](https://github.com/lenneTech/nest-server-starter)

### Step 6: Create Migration Guide

Use the template at `migration-guides/TEMPLATE.md` and follow the process in `.claude/rules/migration-guides.md`.

Required sections:
1. Overview table
2. Quick Migration
3. What's New
4. Breaking Changes (if any)
5. Compatibility Notes
6. Troubleshooting
7. Module Documentation (link to affected module READMEs and INTEGRATION-CHECKLISTs)

### Step 7: Verify

After creating the guide:
1. Run `npm run build` to verify no build errors
2. Run `npm test` to verify all tests pass
3. Present summary to user

## Output Format

Present the analysis as:

```
## Version Analysis

Current version: X.Y.Z
Last release: X.Y.W (tag: vX.Y.W)
Version status: [unchanged | patch needed | minor needed]

## Suggested Version: X.Y.Z

## Changes Since Last Release
- [List of significant changes]

## Migration Guide: X.Y.x → X.Z.x
- Breaking Changes: [count]
- New Features: [count]
- Bugfixes: [count]
```
