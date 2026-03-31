---
version: "11.21.0"
technologies:
  - NestJS 11
  - GraphQL (Apollo Server 5)
  - MongoDB (Mongoose 9)
  - Better Auth
  - REST (Swagger)
  - Express 5
  - Vitest
  - TypeScript 5.9
category: "Framework-Bibliothek"
customer: "lenne.Tech (Open Source)"
---

# @lenne.tech/nest-server - NestJS Framework-Bibliothek

## Ueberblick

`@lenne.tech/nest-server` ist eine leistungsfaehige Erweiterungsschicht auf NestJS fuer den Aufbau von Server-Applikationen mit GraphQL-API und MongoDB-Anbindung. Als Open-Source-Framework-Bibliothek bietet sie eine vollstaendige Basis fuer die Entwicklung moderner Backend-Anwendungen mit integrierter Authentifizierung, Rollenverwaltung, Dateiverwaltung, Health-Checks und Datenbank-Migrationen. Das Framework wird als npm-Paket veroeffentlicht und in zahlreichen Produktionsprojekten eingesetzt.

Die Architektur folgt einem zweischichtigen Ansatz: Der `core/`-Layer enthaelt wiederverwendbare Framework-Komponenten, die als npm-Paket exportiert werden, waehrend der `server/`-Layer als interne Testimplementierung dient. Module werden ueber ein Vererbungsmuster erweitert - Projekte erben von `Core*`-Klassen und ueberschreiben gezielt einzelne Methoden. Das `CoreModule` bietet eine dynamische Konfiguration, bei der GraphQL, MongoDB, Sicherheits-Interceptoren und Validierungs-Pipes automatisch eingerichtet werden.

Ein zentrales Alleinstellungsmerkmal ist das duale Authentifizierungssystem: Das moderne Better Auth (IAM) mit Unterstuetzung fuer 2FA, Passkeys und Social Login kann parallel zum Legacy-JWT-System betrieben werden. Die schrittweise Migration wird durch ein Status-Dashboard und automatische Passwort-Hash-Migration beim Login unterstuetzt. Zusaetzlich bieten der `@UnifiedField()`-Dekorator, die `CrudService`-Basisklasse und konfigurierbare Mongoose-Plugins (Passwort, Role Guard, Audit Fields) eine erhebliche Beschleunigung der Entwicklungszeit.

## Technologie-Stack

| Bereich | Technologie | Version |
|---------|------------|---------|
| Backend-Framework | NestJS | 11.1.16 |
| GraphQL | Apollo Server | 5.4.0 |
| Datenbank | MongoDB (Mongoose) | 9.3.0 |
| Authentifizierung (Modern) | Better Auth | 1.5.5 |
| Authentifizierung (Legacy) | Passport + JWT | 0.7.0 |
| REST-API | Swagger (@nestjs/swagger) | 11.2.6 |
| HTTP-Server | Express | 5.2.1 |
| Datei-Upload (resumable) | tus.io (@tus/server) | 2.3.0 |
| E-Mail (Provider 1) | Mailjet | 6.0.11 |
| E-Mail (Provider 2) | Nodemailer | 8.0.2 |
| Testing | Vitest | 4.1.0 |
| TypeScript | TypeScript | 5.9.3 |
| Linting | oxlint + oxfmt | 1.55.0 / 0.40.0 |
| Paketmanager | pnpm | 10.29.2 |

## Features

### 1. Duales Authentifizierungssystem (Better Auth + Legacy)
Parallelbetrieb von modernem Better Auth (2FA, Passkeys, Social Login) und Legacy-JWT mit schrittweiser Migration.
- **Evidenz:** `src/core/modules/better-auth/core-better-auth.module.ts:216`
- **Screenshot:** ![Better Auth](docs/showcase/screenshots/better-auth-desktop.png)

### 2. Dynamisches CoreModule mit konfigurierbarem GraphQL
Zentrales Modul mit optionalem GraphQL (`graphQl: false`), MongoDB, Sicherheits-Interceptoren und Validierungs-Pipes.
- **Evidenz:** `src/core.module.ts:53`
- **Screenshot:** ![CoreModule](docs/showcase/screenshots/core-module-desktop.png)

### 3. CrudService-Basisklasse
Abstrakte Basis fuer CRUD-Operationen mit automatischer Filterung, Paginierung und Rollenbasierter Zugriffskontrolle.
- **Evidenz:** `src/core/common/services/crud.service.ts:23`
- **Screenshot:** ![CrudService](docs/showcase/screenshots/crud-service-desktop.png)

### 4. @UnifiedField()-Dekorator
Einzelner Dekorator, der GraphQL-Field, Swagger-ApiProperty und Validierungs-Dekoratoren vereint.
- **Evidenz:** `src/core/common/inputs/single-filter.input.ts:20`
- **Screenshot:** ![UnifiedField](docs/showcase/screenshots/unified-field-desktop.png)

### 5. Konfigurierbares Sicherheitssystem
Mongoose-Plugins fuer Passwort-Verschluesselung, Role-Guard und Audit-Felder mit Boolean-Shorthand-Konfiguration.
- **Evidenz:** `src/core/common/services/module.service.ts:19` (ModuleService)
- **Screenshot:** ![Sicherheitssystem](docs/showcase/screenshots/sicherheitssystem-desktop.png)

### 6. Resumable File Uploads (tus.io)
Integriertes tus.io-Protokoll fuer unterbrechungssichere Datei-Uploads mit File-Store-Backend.
- **Evidenz:** `src/core/modules/tus/core-tus.service.ts` und `src/core/modules/tus/core-tus.controller.ts`
- **Screenshot:** ![Tus Uploads](docs/showcase/screenshots/tus-uploads-desktop.png)

### 7. Modul-Vererbungsmuster
Architekturelles Kernmuster: Projekte erweitern `Core*`-Klassen durch Vererbung statt Hooks/Events.
- **Evidenz:** `src/core/modules/better-auth/core-better-auth.resolver.ts:69` (CoreBetterAuthResolver als abstrakte Basis)
- **Screenshot:** ![Modul-Vererbung](docs/showcase/screenshots/modul-vererbung-desktop.png)

### 8. Multi-Tenancy mit Hierarchie-Rollen
Konfigurierbares Multi-Tenancy-System mit Tenant-Header, Membership-Modell und Level-basierter Rollenhierarchie.
- **Evidenz:** `src/core/modules/tenant/` und `src/core/common/interfaces/server-options.interface.ts` (multiTenancy-Konfiguration)
- **Screenshot:** ![Multi-Tenancy](docs/showcase/screenshots/multi-tenancy-desktop.png)

## Architektur

```
nest-server/
  src/
    core/                                 # Exportierte Framework-Komponenten
      common/
        decorators/                       # @Restricted, @Roles, @UnifiedField, @CurrentUser
        helpers/                          # DB, GraphQL, Filter, Validierung
        inputs/                           # Filter, Sort, Pagination Inputs
        interceptors/                     # Response, Security Interceptors
        pipes/                            # MapAndValidatePipe
        services/
          crud.service.ts                 # CRUD-Basisklasse
          module.service.ts               # Modul-Basisklasse
          core-cron-jobs.service.ts        # Cron-Basisklasse
      modules/
        auth/                             # Legacy JWT-Authentifizierung
        better-auth/                      # Better Auth (2FA, Passkey, Social)
        error-code/                       # Zentralisierte Fehlercodes
        file/                             # Datei-Upload/Download (GridFS)
        health-check/                     # Health-Monitoring
        migrate/                          # Datenbank-Migrationen
        permissions/                      # Berechtigungssystem
        system-setup/                     # Initiale Admin-Erstellung
        tenant/                           # Multi-Tenancy
        tus/                              # Resumable Uploads (tus.io)
        user/                             # Nutzerverwaltung
    core.module.ts                        # Dynamisches CoreModule
    config.env.ts                         # Umgebungskonfiguration
    index.ts                              # Oeffentliche API-Exporte
    server/                               # Interne Testimplementierung
    test/                                 # Test-Utilities (TestHelper)
```

## Highlights

- **Vererbungs-Architektur:** Module werden durch Vererbung (`extends Core*`) erweitert, nicht durch Hooks/Events
- **Konfigurierbare Features:** "Presence implies enabled" und "Boolean shorthand" Patterns fuer alle optionalen Features
- **Dual-API:** GraphQL und REST/Swagger koennen parallel oder einzeln betrieben werden
- **Migrationspfad:** Schrittweise Migration von Legacy Auth zu Better Auth mit Status-Dashboard
- **MAJOR = NestJS:** Versionierung spiegelt die NestJS-Hauptversion wider (11.x.x = NestJS 11)
- **TypeScript-first:** Strenge Typisierung mit `@UnifiedField()` fuer GraphQL + Swagger + Validierung in einem Dekorator
- **Fixe Paketversionen:** Keine `^` oder `~` in package.json fuer maximale Reproduzierbarkeit

## Ergebnis

`@lenne.tech/nest-server` ist die zentrale Framework-Bibliothek fuer alle lenne.Tech Backend-Projekte und beschleunigt die Entwicklung neuer Server-Anwendungen erheblich. Die Kombination aus vorgefertigten Modulen (Auth, File, User, Migrate), konfigurierbaren Sicherheitsmechanismen und dem Modul-Vererbungsmuster reduziert den Boilerplate-Code auf ein Minimum, waehrend die volle Flexibilitaet fuer individuelle Anpassungen erhalten bleibt. Die Bibliothek wird kontinuierlich weiterentwickelt und in zahlreichen Produktionsprojekten eingesetzt.

## Changelog

| Version | Datum | Aenderungen |
|---------|-------|-------------|
| 11.21.0 | - | Aktuelle Version mit Multi-Tenancy, Mongoose-Plugins, Response-Interceptor |
| 11.17.0 | - | Better Auth IAM-Only-Modus, BetterAuth-Rollen-Guard |
| 11.6.0 | - | Better Auth eingefuehrt |
| 11.0.0 | - | NestJS 11 Migration, Express 5, Mongoose 9 |
