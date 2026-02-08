# ErrorCode Integration Checklist

**For integrating custom error codes into projects using `@lenne.tech/nest-server`.**

> **Estimated time:** 5-10 minutes

---

## Choose Your Scenario

| Scenario                       | Use When                      | Configuration             | Complexity |
| ------------------------------ | ----------------------------- | ------------------------- | ---------- |
| **A. additionalErrorRegistry** | Simple error code addition    | Config in `config.env.ts` | Minimal    |
| **B. Custom Service**          | Need custom locales or logic  | Service inheritance       | Low        |
| **C. Custom Controller**       | Need custom controller/routes | Service + Controller      | Medium     |

**Recommendation:** Start with **Scenario A**. Only use B or C if you need customization beyond adding error codes.

---

## Reference Implementation

All files are available as reference in the package:

**Local (in your node_modules):**

```
node_modules/@lenne.tech/nest-server/src/server/modules/error-code/
```

**GitHub:**
https://github.com/lenneTech/nest-server/tree/develop/src/server/modules/error-code

---

## Scenario A: additionalErrorRegistry (Simplest)

Use this when you just want to add project-specific error codes.

### 1. Define Error Codes

**Create:** `src/server/common/errors/project-errors.ts`

```typescript
import { IErrorRegistry, mergeErrorCodes } from '@lenne.tech/nest-server';

/**
 * Project-specific error codes
 *
 * Format: PREFIX_XXXX (e.g., PROJ_0001, APP_0001)
 * Use a unique prefix to avoid collisions with LTNS_* core errors.
 */
export const ProjectErrors = {
  ORDER_NOT_FOUND: {
    code: 'PROJ_0001',
    message: 'Order not found',
    translations: {
      de: 'Bestellung mit ID {orderId} wurde nicht gefunden.',
      en: 'Order with ID {orderId} was not found.',
    },
  },
  PAYMENT_FAILED: {
    code: 'PROJ_0002',
    message: 'Payment processing failed',
    translations: {
      de: 'Die Zahlung konnte nicht verarbeitet werden: {reason}',
      en: 'Payment processing failed: {reason}',
    },
  },
} as const satisfies IErrorRegistry;

// Merged error codes for type-safe factory functions
export const ErrorCode = mergeErrorCodes(ProjectErrors);
```

### 2. Add to config.env.ts

```typescript
import { ProjectErrors } from './server/common/errors/project-errors';

const config = {
  // ... other config ...
  errorCode: {
    additionalErrorRegistry: ProjectErrors,
  },
};
```

**Done!** Your project errors are now available via `/api/i18n/errors/:locale`.

---

## Scenario B: Custom Service (For Custom Locales)

Use this when you need:

- Additional locales (e.g., French, Spanish)
- Custom logic in the service

### 1. Define Error Codes

Same as Scenario A, Step 1.

### 2. Create Custom Service

**Create:** `src/server/modules/error-code/error-code.service.ts`
**Copy from:** `node_modules/@lenne.tech/nest-server/src/server/modules/error-code/error-code.service.ts`

**Optional customization - add locales:**

```typescript
@Injectable()
export class ErrorCodeService extends CoreErrorCodeService {
  // Override to add more locales
  protected override supportedLocales = ['de', 'en', 'fr', 'es'] as const;

  constructor() {
    super();
    this.registerErrorRegistry(ProjectErrors);
  }
}
```

### 3. Disable Auto-Registration

**Update:** `src/config.env.ts`

```typescript
const config = {
  // ... other config ...
  errorCode: {
    autoRegister: false, // Required! Prevents CoreModule from registering its own
  },
};
```

**WHY is `autoRegister: false` required?**
NestJS @Global() modules use "first wins" for provider registration. Without this, CoreModule's ErrorCodeModule loads first and your custom service is ignored.

### 4. Register in ServerModule

**Update:** `src/server/server.module.ts`

```typescript
import { ErrorCodeModule as CoreErrorCodeModule } from '@lenne.tech/nest-server';
import { ErrorCodeService } from './modules/error-code/error-code.service';

@Module({
  imports: [
    CoreModule.forRoot(...),
    // Register with custom service
    CoreErrorCodeModule.forRoot({
      service: ErrorCodeService,
    }),
    // ... other modules
  ],
})
export class ServerModule {}
```

---

## Scenario C: Custom Controller (For Custom Routes)

Use this when you need:

- Custom controller endpoints (e.g., `/codes` listing)
- Different route paths
- Additional REST endpoints

**No custom module needed!** Use Core `ErrorCodeModule.forRoot()` with your custom controller and service.

### 1. Create Files

**Copy from:** `node_modules/@lenne.tech/nest-server/src/server/modules/error-code/`

Files needed:

- `error-codes.ts` - Your error definitions
- `error-code.service.ts` - Service extending CoreErrorCodeService
- `error-code.controller.ts` - Controller (**standalone**, not extending)
- `index.ts` - Exports

**No `error-code.module.ts` needed!**

### 2. Disable Auto-Registration

Same as Scenario B, Step 3.

### 3. Register via Core ErrorCodeModule

**Update:** `src/server/server.module.ts`

```typescript
import { ErrorCodeModule } from '@lenne.tech/nest-server';
import { ErrorCodeController } from './modules/error-code/error-code.controller';
import { ErrorCodeService } from './modules/error-code/error-code.service';

@Module({
  imports: [
    CoreModule.forRoot(...),
    // Use Core ErrorCodeModule with custom service and controller
    ErrorCodeModule.forRoot({
      controller: ErrorCodeController,
      service: ErrorCodeService,
    }),
    // ... other modules
  ],
})
export class ServerModule {}
```

**WHY standalone controller instead of extending?**
NestJS registers routes from parent classes first, regardless of method order in child classes. This causes `:locale` to intercept `/codes`. A standalone controller ensures correct route order: static routes (`/codes`) first, then parameterized routes (`:locale`).

---

## Verification Checklist

After integration, verify:

- [ ] `npm run build` succeeds without errors
- [ ] `npm test` passes
- [ ] `GET /api/i18n/errors/de` returns your project error codes
- [ ] `GET /api/i18n/errors/en` returns English translations
- [ ] Error codes follow format `PREFIX_XXXX` (e.g., `PROJ_0001`)
- [ ] Translations include placeholders where needed (`{param}`)

### For Scenario C only:

- [ ] `GET /api/i18n/errors/codes` returns all error codes (if implemented)

---

## Common Mistakes

| Mistake                                    | Symptom                      | Fix                                                |
| ------------------------------------------ | ---------------------------- | -------------------------------------------------- |
| Forgot `autoRegister: false`               | Project errors not appearing | Add `errorCode: { autoRegister: false }` to config |
| Wrong error code format                    | Validation errors            | Use `PREFIX_XXXX` format (4 digits)                |
| Missing translations                       | Runtime errors               | Ensure all locales have translations               |
| Controller extends CoreErrorCodeController | `/codes` returns 404         | Use standalone controller                          |
| Duplicate error codes                      | Unpredictable behavior       | Ensure unique codes across all registries          |
| Forgot to import module                    | No error translations        | Import ErrorCodeModule in ServerModule             |

---

## Using Error Codes in Code

```typescript
import { ErrorCode, Errors } from '@lenne.tech/nest-server';

// Type-safe error code access
const code = ErrorCode.userNotFound; // Returns '#LTNS_0001: User not found'

// Factory functions with parameters
throw new BadRequestException(Errors.userNotFound({ email: 'test@example.com' }));
// Throws: '#LTNS_0001: User with email test@example.com was not found.'

// Project-specific errors (after registration)
import { ErrorCode as ProjectErrorCode } from './common/errors/project-errors';

const orderCode = ProjectErrorCode.ORDER_NOT_FOUND; // '#PROJ_0001: Order not found'
```

---

## API Reference

### REST Endpoints

| Endpoint                   | Method | Description                               |
| -------------------------- | ------ | ----------------------------------------- |
| `/api/i18n/errors/:locale` | GET    | Get translations for locale (de, en, ...) |
| `/api/i18n/errors/codes`   | GET    | Get all error codes (Scenario C only)     |

### Response Format (Nuxt i18n compatible)

```json
{
  "errors": {
    "LTNS_0001": "Benutzer wurde nicht gefunden.",
    "LTNS_0100": "Sie sind nicht angemeldet.",
    "PROJ_0001": "Bestellung mit ID {orderId} wurde nicht gefunden."
  }
}
```

> **Note:** Core LTNS*\* translations are user-friendly messages without placeholders. Project-specific errors (PROJ*\*) may include placeholders like `{orderId}` if defined in your `ProjectErrors` registry.

---

## Detailed Documentation

For complete API reference and advanced topics:

- **Core Error Codes:** `node_modules/@lenne.tech/nest-server/src/core/modules/error-code/error-codes.ts`
- **Interfaces:** `node_modules/@lenne.tech/nest-server/src/core/modules/error-code/interfaces/error-code.interfaces.ts`