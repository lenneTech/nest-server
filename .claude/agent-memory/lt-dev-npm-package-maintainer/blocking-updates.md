# Blocked Package Updates

## @getbrevo/brevo 3.0.1 → 4.0.1

**Blocked since:** 2026-03-11
**Reason:** Complete API redesign

### Old API (v3):
```typescript
import { SendSmtpEmail, TransactionalEmailsApi, TransactionalEmailsApiApiKeys } from '@getbrevo/brevo';
const apiInstance = new TransactionalEmailsApi();
apiInstance.setApiKey(TransactionalEmailsApiApiKeys.apiKey, this.brevoConfig.apiKey);
```

### New API (v4):
- New `BrevoClient` class replacing all `*Api` classes
- New `BrevoEnvironment` enum
- No `TransactionalEmailsApi`, `SendSmtpEmail`, `TransactionalEmailsApiApiKeys` exports

**File to update:** `src/core/common/services/brevo.service.ts`

---

## graphql-upload 15.0.2 → 17.0.0

**Blocked since:** 2026-03-11
**Reason:** File extension changed from `.js` to `.mjs` in package exports

### Old exports (v15):
```
./graphqlUploadExpress.js
./GraphQLUpload.js
```

### New exports (v17):
```
./graphqlUploadExpress.mjs
./GraphQLUpload.mjs
```

**Files to update:**
- `src/core.module.ts` - imports `graphql-upload/graphqlUploadExpress.js`
- `src/core/modules/file/core-file.resolver.ts` - imports `graphql-upload/GraphQLUpload.js`
- `src/server/modules/file/file.resolver.ts` - imports `graphql-upload/GraphQLUpload.js`
- `src/types/graphql-upload.d.ts` - custom type declarations for both paths
