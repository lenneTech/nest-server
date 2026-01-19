# Error Code Module - Reference Implementation

This directory contains the reference implementation for extending the ErrorCodeModule.

## Purpose

Demonstrates **Scenario C: Custom Service + Controller via forRoot()** where a project:
1. Defines its own error codes with a unique prefix (`SRV_*`)
2. Creates a custom service extending `CoreErrorCodeService`
3. Creates a **standalone** controller (not extending CoreErrorCodeController - see below)
4. Uses `ErrorCodeModule.forRoot({ service, controller })` from Core

**No custom module needed!** The Core ErrorCodeModule handles everything.

## Files

| File | Description |
|------|-------------|
| `error-codes.ts` | Server-specific error definitions (`SRV_*` prefix) |
| `error-code.service.ts` | Custom service registering `ServerErrors` |
| `error-code.controller.ts` | Custom controller with `/codes` endpoint |
| `index.ts` | Module exports |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│               Core ErrorCodeModule.forRoot()                 │
│                         (@Global)                            │
├──────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐    ┌─────────────────────────────┐  │
│  │  ErrorCodeService   │    │   ErrorCodeController       │  │
│  │  extends Core...    │    │   (standalone - see below)  │  │
│  │                     │    │                             │  │
│  │  - LTNS_* (core)    │    │   GET /api/i18n/errors/codes│  │
│  │  - SRV_* (server)   │    │   GET /api/i18n/errors/de   │  │
│  │                     │    │   GET /api/i18n/errors/en   │  │
│  └─────────────────────┘    └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Usage

### In ServerModule

```typescript
import { ErrorCodeModule } from '@lenne.tech/nest-server';
import { ErrorCodeController } from './modules/error-code/error-code.controller';
import { ErrorCodeService } from './modules/error-code/error-code.service';

@Module({
  imports: [
    CoreModule.forRoot({
      // ...config
      errorCode: {
        autoRegister: false, // Required! Prevents CoreModule auto-registration
      },
    }),
    // Use Core ErrorCodeModule with custom service and controller
    ErrorCodeModule.forRoot({
      controller: ErrorCodeController,
      service: ErrorCodeService,
    }),
  ],
})
export class ServerModule {}
```

### In Code

```typescript
import { ErrorCode } from './modules/error-code/error-codes';
import { Errors } from '@lenne.tech/nest-server';

// Access error codes
console.log(ErrorCode.DEMO_ERROR);  // '#SRV_0001: Demo error for testing'

// Use factory functions
throw new BadRequestException(Errors.userNotFound({ email: 'test@example.com' }));
```

## When to Use This Pattern

Use Scenario C when you need:
- Custom REST endpoints (like `/codes`)
- Different route paths
- Complex controller logic

For simpler cases, see:
- **Scenario A**: `additionalErrorRegistry` in config (simplest)
- **Scenario B**: Custom service via inheritance

See `src/core/modules/error-code/INTEGRATION-CHECKLIST.md` for all scenarios.

## Important Notes

### Why Standalone Controller Instead of Extending?

The controller is **standalone** (does not extend `CoreErrorCodeController`) because:

**NestJS registers routes from parent classes first**, regardless of method declaration
order in child classes. This causes parameterized routes (`:locale`) to intercept
static routes (`/codes`), even if you re-declare the methods.

```typescript
// DOES NOT WORK - parent route registered first!
@Controller('api/i18n/errors')
export class ErrorCodeController extends CoreErrorCodeController {
  @Get('codes')                    // Registered AFTER parent's :locale
  getAllCodes(): string[] { }

  @Get(':locale')                  // Parent already registered this
  override getTranslations() { }
}

// WORKS - standalone ensures correct order
@Controller('api/i18n/errors')
export class ErrorCodeController {
  @Get('codes')                    // Registered first
  getAllCodes(): string[] { }

  @Get(':locale')                  // Registered second
  getTranslations() { }
}
```

**Key insight:** NestJS Controller inheritance does NOT work like Service inheritance for route ordering.

### Why is `autoRegister: false` required?

NestJS `@Global()` modules use "first wins" for provider registration. Without `autoRegister: false`, CoreModule registers its ErrorCodeModule first, and your custom service is ignored.
