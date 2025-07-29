# Git Commit Guidelines for Copilot & Conventional Commits

Follow the structure:  
**<type>(<TICKET>): <message>**

Example:  
`feat(DEV-123): implement user login via OAuth`

## Rules

- Extract the **ticket number** (e.g. `DEV-123`) from the current branch name.
    - Branch example: `DEV-123-feature-login`
- Use exactly **one** Conventional Commit prefix per commit:
    - `feat`: for new features
    - `fix`: for bug fixes
    - `perf`: for performance improvements
    - `refactor`: for code changes that neither fix a bug nor add a feature
    - `revert`: for reverting previous commits
    - `docs`: for documentation-only changes
    - `style`: for formatting, whitespace, semicolons, etc. (no code changes)
    - `chore`: for tooling/config/non-runtime maintenance
    - `test`: for adding or updating tests
    - `build`: for build system or dependencies
    - `ci`: for CI/CD configuration
- Write commit messages in **English**.
- Determine the prefix (`feat`, `fix`, etc.) automatically based on the code diff.
- Avoid combining multiple prefixes (e.g. `feat+fix`) – use separate commits if necessary.

## Format

`<type>(<TICKET>): <short imperative message>`

✅ Correct:

- `fix(DEV-456): prevent crash when clicking submit`
- `feat(DEV-789): add search filter for product list`

❌ Incorrect:

- `fix,feat(DEV-123): ...` → use only one type
- `DEV-123: fixed stuff` → missing type prefix
- `feat: login feature` → missing ticket ID
