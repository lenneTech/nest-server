# Versioning Strategy

## Version Schema: `MAJOR.MINOR.PATCH`

| Part    | Meaning                                                            |
|---------|--------------------------------------------------------------------|
| `MAJOR` | Mirrors the NestJS major version (e.g., `11.x.x` = NestJS 11)      |
| `MINOR` | Breaking changes or significant restructuring                      |
| `PATCH` | Improvements (bugfixes) or additions (new features) - non-breaking |

## Examples

- `11.0.0` -> Initial release for NestJS 11
- `11.1.0` -> Breaking change or major restructuring within NestJS 11
- `11.1.5` -> Bugfix or new feature (backward compatible)

## Important Rules

1. **Document breaking changes** clearly in commit messages when incrementing MINOR version
2. **Update nest-server-starter** with migration instructions for breaking changes
3. **Consider downstream impact** - this package is used by multiple projects

## Release Process

1. Make changes and ensure all tests pass (`pnpm test`)
2. Update version in `package.json`
3. Build the package (`pnpm run build`)
4. Publish to npm
5. Update and test in [nest-server-starter](https://github.com/lenneTech/nest-server-starter)
6. Commit changes to starter with migration notes

## Package Distribution

- **NPM Package**: `@lenne.tech/nest-server`
- **Main entry**: `dist/index.js`
- **Types**: `dist/index.d.ts`
- **Public APIs**: Exported from `src/index.ts`

## Package Development Commands

```bash
# Build for local development (use with pnpm link)
pnpm run build:dev

# Create tarball for integration testing
pnpm run build:pack

# Clean reinstall with tests and build
pnpm run reinit

# Watch for changes
pnpm run watch
```
