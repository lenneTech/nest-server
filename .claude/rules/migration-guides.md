# Migration Guide Creation Process

This document describes the process for creating migration guides when releasing new versions of @lenne.tech/nest-server.

## When to Create a Migration Guide

**Versioning Context:** The MAJOR version mirrors NestJS (e.g., `11.x.x` = NestJS 11). This means MINOR can contain breaking changes and PATCH can contain new features.

**Create a migration guide when consuming projects need to:**
- Change code, configuration, or usage to use new features
- Modify anything to keep the application working after update
- Adapt to breaking changes or new requirements

**Examples:**
- `11.6.x → 11.7.x` - Required (new BetterAuth module, new CoreModule signature)
- `11.7.0 → 11.7.1` - Required if new features need configuration changes
- `11.7.1 → 11.7.2` - Not required if purely internal bugfixes with no user action needed

**Rule of thumb:** If a developer needs to do anything beyond `pnpm update` to benefit from or accommodate the changes, create a migration guide.

## Migration Guide Location

All migration guides are stored in `migration-guides/`:
- `migration-guides/11.6.x-to-11.7.x.md`
- `migration-guides/TEMPLATE.md` - Template for new guides

## Creation Process

### Step 1: Gather Project Information

**Always analyze these sources:**
1. Local `src/server/` - Internal test implementation
2. [nest-server-starter](https://github.com/lenneTech/nest-server-starter) - Reference project

**Ask developer for additional projects:**
```
Which projects should I analyze for migration compatibility?
Please provide paths to projects using @lenne.tech/nest-server.
```

### Step 2: Analyze Projects

Focus on files affected by the version changes:
- Module files (`*.module.ts`)
- Service files (`*.service.ts`)
- Resolver files (`*.resolver.ts`)
- Controller files (`*.controller.ts`)
- Configuration files (`config.env.ts`)

Look for:
- Module inheritance patterns (extending Core* classes)
- Method overrides
- Custom implementations
- Version-specific features in use

### Step 3: Identify Changes

Categorize all changes:

| Category | Description |
|----------|-------------|
| **Breaking Changes** | Changes that require code modifications |
| **New Features** | New functionality (opt-in) |
| **Bugfixes** | Corrections to existing behavior |
| **Deprecations** | Features marked for future removal |

### Step 4: Write the Guide

Use `migration-guides/TEMPLATE.md` as starting point.

**Required Sections:**
1. **Overview** - Summary table with categories and effort
2. **Quick Migration** - For non-breaking updates
3. **What's New** - New features with examples
4. **Breaking Changes** - Before/after code samples
5. **Compatibility Notes** - Common patterns and their status
6. **Troubleshooting** - Known issues and solutions
7. **Module Documentation** - Links to affected module docs (README.md, INTEGRATION-CHECKLIST.md)

**Rules:**
- **Write ALL content in English** - This includes section titles, descriptions, explanations, and code comments. Technical terms and code identifiers remain unchanged.
- Do NOT name specific customer projects (except nest-server-starter as reference)
- Keep information general and pattern-based
- Include code examples for all changes
- Mention `npm run update` if package.json dependencies changed

### Step 5: Update References

After creating the guide, verify references in:
- `CLAUDE.md` - Should link to migration-guides/
- `CHANGELOG.md` - If it exists

### Step 6: Link Module Documentation

For each affected module, check for and link to:
- `src/core/modules/<module>/README.md` - Module overview and usage
- `src/core/modules/<module>/INTEGRATION-CHECKLIST.md` - Integration steps
- `src/server/modules/<module>/` - Reference implementation

Find existing documentation:
```bash
# Find all module READMEs
ls src/core/modules/**/README.md

# Find all integration checklists
ls src/core/modules/**/INTEGRATION-CHECKLIST.md
```

## Guide Quality Checklist

- [ ] **Written entirely in English**
- [ ] Overview table is complete
- [ ] Quick migration path provided
- [ ] All breaking changes documented with before/after
- [ ] New features have usage examples
- [ ] Compatibility notes cover common patterns
- [ ] Troubleshooting section addresses likely issues
- [ ] Module documentation section links to affected modules
- [ ] No customer project names mentioned
- [ ] Code examples are tested

## Example Analysis Output

```markdown
## Analysis Summary

### Pattern: AuthResolver Extension
- Found in: 4/4 analyzed projects
- Status: Compatible
- Notes: Projects override signIn() calling authService directly

### Pattern: Custom Role Enums
- Found in: 1/4 analyzed projects
- Status: Compatible
- Notes: CompanyRoles used instead of RoleEnum

### Potential Issues: None identified
```

## Automation

When asked to create a migration guide, Claude Code should:

1. Prompt for project paths (unless already provided)
2. Read auth, user, and configuration files from each project
3. Compare patterns against new version requirements
4. Generate compatibility report
5. Create migration guide using template
6. Verify all tests pass with new version
