# Error Codes Documentation

This document lists all available error codes with their descriptions and solutions.

## Error Code Format

All error codes follow the format: `#PREFIX_XXXX: Description`

- **PREFIX**: Identifies the source module (e.g., LTNS for core)
- **XXXX**: Unique 4-digit number within the prefix

## Error Code Ranges

| Range | Category |
|-------|----------|
| LTNS_0001-LTNS_0099 | Authentication errors |
| LTNS_0100-LTNS_0199 | Authorization errors |
| LTNS_0200-LTNS_0299 | User errors |
| LTNS_0300-LTNS_0399 | Validation errors |
| LTNS_0400-LTNS_0499 | Resource errors |
| LTNS_0500-LTNS_0599 | File errors |
| LTNS_0600-LTNS_0699 | Database errors |
| LTNS_0700-LTNS_0799 | External service errors |
| LTNS_0800-LTNS_0899 | Configuration errors |
| LTNS_0900-LTNS_0999 | Internal errors |

---

## Authentication Errors (LTNS_0001-LTNS_0099)

### LTNS_0001: userNotFound

**Message:** User not found with given email

**Description:** Thrown when email lookup fails during authentication

**Solution:** Verify the email address exists in the database

**Parameters:** `email`

**Translations:**
- DE: Benutzer mit E-Mail {email} wurde nicht gefunden.
- EN: User with email {email} not found.

---

### LTNS_0002: invalidPassword

**Message:** Invalid password provided

**Description:** Thrown when password verification fails during authentication

**Solution:** Verify the password meets requirements and matches the stored hash

**Translations:**
- DE: Das eingegebene Passwort ist ungültig.
- EN: The provided password is invalid.

---

### LTNS_0003: invalidToken

**Message:** Invalid or expired token

**Description:** Thrown when JWT validation fails

**Solution:** Request a new access token using refresh token or re-authenticate

**Translations:**
- DE: Der Token ist ungültig oder abgelaufen.
- EN: The token is invalid or has expired.

---

### LTNS_0004: tokenExpired

**Message:** Token has expired

**Description:** Thrown when JWT expiration time has passed

**Solution:** Use refresh token to get new access token or re-authenticate

**Translations:**
- DE: Der Token ist abgelaufen. Bitte melden Sie sich erneut an.
- EN: The token has expired. Please sign in again.

---

### LTNS_0005: refreshTokenRequired

**Message:** Refresh token is required

**Description:** Thrown when attempting to refresh without providing refresh token

**Solution:** Include the refresh token in the authorization header or cookie

**Translations:**
- DE: Ein Refresh-Token ist erforderlich.
- EN: A refresh token is required.

---

### LTNS_0006: userNotVerified

**Message:** User email is not verified

**Description:** Thrown when user attempts action requiring verified status

**Solution:** Complete the email verification process

**Translations:**
- DE: Die E-Mail-Adresse wurde noch nicht verifiziert.
- EN: The email address has not been verified yet.

---

## Authorization Errors (LTNS_0100-LTNS_0199)

### LTNS_0100: unauthorized

**Message:** Unauthorized access

**Description:** Thrown when accessing protected resource without authentication

**Solution:** Sign in to access this resource

**Translations:**
- DE: Sie sind nicht angemeldet.
- EN: You are not authenticated.

---

### LTNS_0101: accessDenied

**Message:** Access denied - insufficient permissions

**Description:** Thrown when user does not have the required role

**Solution:** Contact an administrator to request the required permissions

**Parameters:** `requiredRole`

**Translations:**
- DE: Zugriff verweigert. Sie benötigen die Rolle {requiredRole}.
- EN: Access denied. Role {requiredRole} is required.

---

### LTNS_0102: resourceForbidden

**Message:** Access to this resource is forbidden

**Description:** Thrown when user cannot access a resource they do not own

**Solution:** Verify you are the owner or have been granted access

**Parameters:** `resourceId`

**Translations:**
- DE: Der Zugriff auf diese Ressource ({resourceId}) ist nicht gestattet.
- EN: Access to this resource ({resourceId}) is forbidden.

---

## User Errors (LTNS_0200-LTNS_0299)

### LTNS_0200: emailAlreadyExists

**Message:** Email address already registered

**Description:** Thrown when attempting to register with an existing email

**Solution:** Use a different email address or recover the existing account

**Parameters:** `email`

**Translations:**
- DE: Die E-Mail-Adresse {email} ist bereits registriert.
- EN: The email address {email} is already registered.

---

### LTNS_0201: usernameAlreadyExists

**Message:** Username already taken

**Description:** Thrown when attempting to register with an existing username

**Solution:** Choose a different username

**Parameters:** `username`

**Translations:**
- DE: Der Benutzername {username} ist bereits vergeben.
- EN: The username {username} is already taken.

---

## Validation Errors (LTNS_0300-LTNS_0399)

### LTNS_0300: validationFailed

**Message:** Validation failed

**Description:** Thrown when input does not meet validation requirements

**Solution:** Check the validation rules and provide valid input

**Parameters:** `field`

**Translations:**
- DE: Validierung fehlgeschlagen für Feld {field}.
- EN: Validation failed for field {field}.

---

### LTNS_0301: requiredFieldMissing

**Message:** Required field is missing

**Description:** Thrown when a required field is not included in the request

**Solution:** Include the required field in your request

**Parameters:** `field`

**Translations:**
- DE: Das Pflichtfeld {field} fehlt.
- EN: The required field {field} is missing.

---

### LTNS_0302: invalidFieldFormat

**Message:** Invalid format for field

**Description:** Thrown when field value does not match expected format

**Solution:** Check the expected format and provide a valid value

**Parameters:** `field`, `expectedFormat`

**Translations:**
- DE: Ungültiges Format für {field}. Erwartet: {expectedFormat}.
- EN: Invalid format for {field}. Expected: {expectedFormat}.

---

### LTNS_0303: nonWhitelistedProperties

**Message:** Non-whitelisted properties found

**Description:** Thrown when request body contains properties not decorated with `@UnifiedField`. Only active when `nonWhitelistedFields: 'error'` is configured.

**Solution:** Remove the non-whitelisted properties from the request, or decorate them with `@UnifiedField` in the input class. If using `'strip'` mode (default), these properties are silently removed instead of throwing an error.

**Parameters:** `properties`

**Translations:**
- DE: Die folgenden Eigenschaften sind nicht erlaubt: {{properties}}. Nur mit @UnifiedField dekorierte Eigenschaften werden akzeptiert.
- EN: The following properties are not allowed: {{properties}}. Only properties decorated with @UnifiedField are accepted.

---

## Resource Errors (LTNS_0400-LTNS_0499)

### LTNS_0400: resourceNotFound

**Message:** Resource not found

**Description:** Thrown when the requested resource does not exist

**Solution:** Verify the resource ID is correct

**Parameters:** `resourceType`, `resourceId`

**Translations:**
- DE: {resourceType} mit ID {resourceId} wurde nicht gefunden.
- EN: {resourceType} with ID {resourceId} was not found.

---

### LTNS_0401: resourceAlreadyExists

**Message:** Resource already exists

**Description:** Thrown when attempting to create a resource that already exists

**Solution:** Use update operation or choose a different identifier

**Parameters:** `resourceType`, `identifier`

**Translations:**
- DE: {resourceType} mit Kennung {identifier} existiert bereits.
- EN: {resourceType} with identifier {identifier} already exists.

---

## File Errors (LTNS_0500-LTNS_0599)

### LTNS_0500: fileNotFound

**Message:** File not found

**Description:** Thrown when the requested file does not exist

**Solution:** Verify the file ID is correct

**Parameters:** `fileId`

**Translations:**
- DE: Datei mit ID {fileId} wurde nicht gefunden.
- EN: File with ID {fileId} was not found.

---

### LTNS_0501: fileUploadFailed

**Message:** File upload failed

**Description:** Thrown when file upload process encounters an error

**Solution:** Check file size limits, allowed formats, and try again

**Parameters:** `reason`

**Translations:**
- DE: Datei-Upload fehlgeschlagen: {reason}.
- EN: File upload failed: {reason}.

---

### LTNS_0502: fileTypeNotAllowed

**Message:** File type not allowed

**Description:** Thrown when uploaded file type is not in the allowed list

**Solution:** Convert or upload a file with an allowed type

**Parameters:** `fileType`, `allowedTypes`

**Translations:**
- DE: Dateityp {fileType} ist nicht erlaubt. Erlaubt: {allowedTypes}.
- EN: File type {fileType} is not allowed. Allowed: {allowedTypes}.

---

## Internal Errors (LTNS_0900-LTNS_0999)

### LTNS_0900: internalError

**Message:** An internal error occurred

**Description:** Thrown when an unexpected internal error occurs

**Solution:** Contact support if the issue persists

**Translations:**
- DE: Ein interner Fehler ist aufgetreten. Bitte versuchen Sie es später erneut.
- EN: An internal error occurred. Please try again later.

---

### LTNS_0901: serviceUnavailable

**Message:** Service temporarily unavailable

**Description:** Thrown when an external service is not responding

**Solution:** Try again later or contact support

**Parameters:** `serviceName`

**Translations:**
- DE: Der Dienst {serviceName} ist vorübergehend nicht verfügbar.
- EN: Service {serviceName} is temporarily unavailable.

---

### LTNS_0902: legacyAuthDisabled

**Message:** Legacy authentication is disabled

**Description:** Thrown when trying to use disabled legacy auth endpoints

**Solution:** Migrate to BetterAuth (IAM) endpoints for authentication

**Parameters:** `endpoint`

**Translations:**
- DE: Der Legacy-Authentifizierungs-Endpoint {endpoint} ist deaktiviert. Bitte verwenden Sie BetterAuth (IAM).
- EN: Legacy authentication endpoint {endpoint} is disabled. Please use BetterAuth (IAM).

---

## Extending Error Codes

Projects can extend the error code system by creating their own error registry:

```typescript
import { defineErrors, createProjectErrors, CoreErrorCodeService } from '@lenne.tech/nest-server';

// Define project-specific errors
const PROJECT_ERRORS = defineErrors({
  PROJ_0001: {
    name: 'orderNotFound',
    message: 'Order not found',
    params: ['orderId'] as const,
    translations: {
      de: 'Bestellung {orderId} nicht gefunden.',
      en: 'Order {orderId} not found.',
    },
    docs: {
      description: 'Thrown when order lookup fails',
      solution: 'Verify the order ID',
    },
  },
});

// Create factory functions
export const ProjectErrors = createProjectErrors(PROJECT_ERRORS);

// Extend the service to register project errors
@Injectable()
export class ErrorCodeService extends CoreErrorCodeService {
  constructor() {
    super();
    this.registerErrors(PROJECT_ERRORS);
  }
}
```

## Usage in Code

```typescript
import { Errors } from '@lenne.tech/nest-server';

// Throw an error with parameters
throw Errors.userNotFound('user@example.com');
// → "#LTNS_0001: User not found with given email"

// Throw an error without parameters
throw Errors.invalidPassword();
// → "#LTNS_0002: Invalid password provided"
```
