---
version: "12.1.0"
technologies:
  - NestJS 12
  - GraphQL (Apollo Server 5)
  - REST (Swagger)
  - MongoDB (Mongoose 9)
  - PostgreSQL, MySQL, MariaDB (TypeORM, Kysely, Drizzle)
  - Better Auth
  - Redis, S3
  - Express 5
  - Vitest
  - TypeScript 6
category: "Framework-Bibliothek"
customer: "lenne.Tech (Open Source)"
---

# @lenne.tech/nest-server - NestJS Framework-Bibliothek

## Überblick

`@lenne.tech/nest-server` ist eine Erweiterungsschicht auf NestJS für Server-Anwendungen mit GraphQL- und REST-API. Seit
12.1 liegen die Daten wahlweise in MongoDB, PostgreSQL, MySQL oder MariaDB, auf Wunsch auch gemischt je Modell, hinter
einem einzigen `CrudService` und einer einzigen Sicherheits-Pipeline. Als Open-Source-Bibliothek liefert sie eine
vollständige Basis für Backend-Anwendungen: Authentifizierung, Rechte bis auf Feldebene, Mandantentrennung,
Dateiverwaltung, Migrationen, Health-Checks, einen KI-Assistenten mit MCP-Server und ein Betriebscockpit. Das Framework
wird als npm-Paket veröffentlicht und in zahlreichen Produktionsprojekten eingesetzt; Projekte können den Kern auch als
eigenen Code übernehmen (Vendor-Modus).

Die Architektur folgt einem zweischichtigen Ansatz: Der `core/`-Layer enthält die wiederverwendbaren
Framework-Komponenten, der `server/`-Layer dient als interne Testimplementierung. Module werden über ein Vererbungsmuster
erweitert: Projekte erben von `Core*`-Klassen und überschreiben gezielt einzelne Methoden. Das `CoreModule` richtet
GraphQL, Datenbankquellen, Sicherheits-Interceptoren und Validierungs-Pipes aus der Konfiguration ein.

Sicherheit steht vor Komfort. Dieselben Regeln (Passwort, Rollenschutz, Audit-Felder, Mandantenfilter) gelten auf jeder
Datenbank: als Mongoose-Plugins auf MongoDB, im Data Store auf SQL. Nach jedem Lesezugriff prüft eine
Mandanten-Zeilenkontrolle das Ergebnis, auf PostgreSQL erzwingt zusätzlich Row-Level-Security die Trennung. Optional
machen Redis und S3 den Betrieb mit mehreren Replikaten möglich, ohne dass sich für Projekte mit einer Instanz etwas
ändert.

## Technologie-Stack

| Bereich | Technologie | Version |
|---------|------------|---------|
| Backend-Framework | NestJS | 12.2.0 |
| GraphQL | Apollo Server | 5.5.1 |
| REST-API | Swagger (@nestjs/swagger) | 12.0.4 |
| HTTP-Server | Express | 5.3.0 |
| Datenbank (Dokument) | MongoDB (Mongoose) | 9.11.4 |
| Datenbank (SQL) | PostgreSQL, MySQL 8.4, MariaDB 11.8 | pg 8.23.1, mysql2 3.24.6 |
| SQL-Engines | TypeORM, Kysely, Drizzle | 1.1.2, 0.29.7, 1.0.0-rc.5 |
| Authentifizierung (Modern) | Better Auth | 1.7.13 |
| Authentifizierung (Legacy) | Passport + JWT | 0.7.0 |
| Verteilter Betrieb | Redis (ioredis, BullMQ), S3 (AWS SDK) | 6.0.0, 6.4.2, 3.1156.0 |
| KI / MCP | Model Context Protocol SDK | 1.32.2 |
| Datei-Upload (resumable) | tus.io (@tus/server) | 2.4.6 |
| E-Mail | Nodemailer, Mailjet, Brevo | 10.2.1, 6.0.11, 6.2.0 |
| Testing | Vitest | 5.0.5 |
| TypeScript | TypeScript | 6.0.3 |
| Linting | oxlint + oxfmt | 1.89.0 / 0.74.0 |
| Paketmanager | pnpm | 11.28.5 |

## Features

### 1. Datenbankunabhängigkeit
MongoDB, PostgreSQL, MySQL oder MariaDB je Projekt oder je Modell, hinter einem `CrudService` und einer Sicherheits-Pipeline. Schema-Änderungen und SQL-Migrationen übernimmt das Framework; die SQL-Engine (TypeORM, Kysely, Drizzle) ist austauschbar.
- **Evidenz:** `src/core/common/persistence/data-store.interface.ts`, `mongoose-data-store.ts`, `sql/sql-data-store.ts`, `sql/mysql/mysql-data-store.ts`

### 2. Duales Authentifizierungssystem und API-Tokens
Better Auth (2FA, Passkeys, Social Login) auf MongoDB oder PostgreSQL, Legacy-JWT als Opt-in für die Migration. Dazu API-Tokens für Nutzer und Mandanten, die nur auf ausdrücklich freigegebenen Routen gelten.
- **Evidenz:** `src/core/modules/better-auth/core-better-auth.module.ts`, `src/core/modules/api-token/core-api-token.module.ts`

### 3. Dynamisches CoreModule
Zentrales Modul mit optionalem GraphQL (`graphQl: false`), Datenbankquellen, Sicherheits-Interceptoren und Validierungs-Pipes.
- **Evidenz:** `src/core.module.ts`

### 4. CrudService-Basisklasse
Basis für CRUD-Operationen mit Filterung, Paginierung und rollenbasierter Zugriffskontrolle bis auf Feldebene, auf jeder Datenbank gleich.
- **Evidenz:** `src/core/common/services/crud.service.ts`

### 5. @UnifiedField()-Dekorator
Ein Dekorator für GraphQL-Field, Swagger-ApiProperty, Validierung und Feldrechte, auch für verschachtelte Typen.
- **Evidenz:** `src/core/common/decorators/unified-field.decorator.ts`

### 6. Sicherheitssystem in mehreren Ebenen
Passwort-Hashing, Rollenschutz, Audit-Felder und Mandantenfilter auf jeder Datenbank, Mandanten-Zeilenkontrolle nach jedem Lesezugriff, Row-Level-Security auf PostgreSQL, Security-Header, SSRF-Schutz für vom Nutzer eingegebene URLs und erneut geprüfte WebSocket-Verbindungen.
- **Evidenz:** `src/core/common/persistence/policies/`, `src/core/common/middlewares/security-headers.middleware.ts`, `src/core/common/helpers/outbound-url.helper.ts`, `src/core/common/helpers/graphql-ws-connection.helper.ts`

### 7. Multi-Tenancy mit Hierarchie-Rollen
Tenant-Header, Membership-Modell und levelbasierte Rollenhierarchie; Mitgliedschaftsrollen verleihen nie globale Rechte, deaktivierte Mandanten werden auf jedem Weg abgewiesen.
- **Evidenz:** `src/core/modules/tenant/`

### 8. KI-Assistent und MCP-Server
Tool-Registry mit Rollenfilter, Planmodus mit Vorabprüfung, Bestätigungsregeln, Token-Budgets je Nutzer und Mandant, Konversationen, SSE-Streaming und ein MCP-Server unter `/ai/mcp` mit OAuth 2.1.
- **Evidenz:** `src/core/modules/ai/core-ai.module.ts`

### 9. Betriebscockpit (Hub)
Build-freies, nur für Admins zugängliches Cockpit unter `/hub`: Diagnose, Logs, Request-Traces, Query-Profiler, Cron-Jobs, Datenbank, Migrationen, Dateien, Konfiguration, Rechteübersicht, E-Mail-Vorschau und Postfach.
- **Evidenz:** `src/core/modules/hub/core-hub.module.ts`

### 10. Betrieb mit mehreren Replikaten
Optional Redis und S3: geteilte Rate-Limits, Cron-Deduplizierung, GraphQL-Subscriptions über alle Replikate, Cache-Invalidierung, gemeinsamer Dateispeicher und Upload-Staging. Ohne Konfiguration bleibt alles prozesslokal wie bisher.
- **Evidenz:** `src/core/common/services/core-redis.service.ts`, `src/core/common/services/core-s3.service.ts`

### 11. Resumable File Uploads (tus.io)
tus.io-Protokoll für unterbrechungssichere Uploads bis 50 GB, mit Besitzer- und Mandantenprüfung und S3-Staging.
- **Evidenz:** `src/core/modules/tus/core-tus.service.ts`, `src/core/modules/tus/core-tus.controller.ts`

### 12. Modul-Vererbungsmuster
Architekturelles Kernmuster: Projekte erweitern `Core*`-Klassen durch Vererbung statt Hooks oder Events.
- **Evidenz:** `src/core/modules/better-auth/core-better-auth.resolver.ts` (CoreBetterAuthResolver als abstrakte Basis)

## Architektur

```
nest-server/
  src/
    core/                                 # Exportierte Framework-Komponenten
      common/
        decorators/                       # @Restricted, @Roles, @UnifiedField, @CurrentUser
        helpers/                          # DB, GraphQL, Filter, Validierung, SSRF-Schutz
        inputs/                           # Filter, Sort, Pagination Inputs
        interceptors/                     # Response, Security Interceptors
        middlewares/                      # Request-Kontext, Security-Header
        persistence/                      # Data-Store-Port, MongoDB- und SQL-Stores, Policies
        pipes/                            # MapAndValidatePipe
        services/
          crud.service.ts                 # CRUD-Basisklasse
          core-redis.service.ts           # Optionale zentrale Redis-Verbindung
          core-s3.service.ts              # Optionaler S3-Speicher
          core-cron-jobs.service.ts       # Cron-Basisklasse mit Deduplizierung
      modules/
        ai/                               # KI-Assistent, MCP-Server, OAuth
        api-token/                        # API-Tokens für Nutzer und Mandanten
        auth/                             # Legacy JWT-Authentifizierung
        better-auth/                      # Better Auth (2FA, Passkey, Social)
        error-code/                       # Zentralisierte Fehlercodes
        file/                             # Datei-Upload/Download (GridFS, S3, Dateisystem)
        health-check/                     # Health-Monitoring
        hub/                              # Betriebscockpit
        migrate/                          # Migrationen für MongoDB und SQL
        permissions/                      # Rechteübersicht
        system-setup/                     # Initiale Admin-Erstellung
        tenant/                           # Multi-Tenancy
        tus/                              # Resumable Uploads (tus.io)
        user/                             # Nutzerverwaltung
    core.module.ts                        # Dynamisches CoreModule
    config.env.ts                         # Umgebungskonfiguration
    index.ts                              # Öffentliche API-Exporte
    server/                               # Interne Testimplementierung
    test/                                 # Test-Utilities (TestHelper)
```

## Highlights

- **Eine Pipeline, jede Datenbank:** Sicherheitsregeln und Ausgabefilter existieren einmal und gelten auf MongoDB, PostgreSQL, MySQL und MariaDB; die gesamte e2e-Suite läuft auf MongoDB und PostgreSQL
- **Vererbungs-Architektur:** Module werden durch Vererbung (`extends Core*`) erweitert, nicht durch Hooks oder Events
- **Konfigurierbare Features:** „Presence implies enabled“ und „Boolean shorthand“ für alle optionalen Features
- **Dual-API:** GraphQL und REST/Swagger parallel oder einzeln
- **Regressionstests mit Nachweis:** Jeder Test, der einen Fehler festhält, nennt eine registrierte Mutation, die ihn nachweislich rot macht
- **MAJOR = NestJS:** Versionierung spiegelt die NestJS-Hauptversion wider (12.x.x = NestJS 12)
- **ESM-Paket:** lädt in ESM- und CommonJS-Projekten; als npm-Paket oder als übernommener Kern (Vendor-Modus)
- **Fixe Paketversionen:** keine `^` oder `~` in package.json, für reproduzierbare Installationen

## Ergebnis

`@lenne.tech/nest-server` ist die zentrale Framework-Bibliothek für alle lenne.Tech-Backend-Projekte und beschleunigt die
Entwicklung neuer Server-Anwendungen erheblich. Vorgefertigte Module (Auth, User, Tenant, File, Migrate, KI, Hub),
mehrschichtige Sicherheitsmechanismen und das Modul-Vererbungsmuster reduzieren den Boilerplate-Code auf ein Minimum,
während die volle Flexibilität für individuelle Anpassungen erhalten bleibt. Mit der Datenbankunabhängigkeit entscheidet
ein Projekt nach fachlichen Gründen zwischen Dokument- und relationaler Datenbank, ohne auf eine Sicherheitsgarantie zu
verzichten.

## Changelog

| Version | Datum | Änderungen |
|---------|-------|-------------|
| 12.1.0 | 2026-10 | Datenbankunabhängigkeit: PostgreSQL, MySQL, MariaDB neben MongoDB, MongoDB-Bibliotheken optional |
| 12.0.0 | 2026-10 | NestJS 12, TypeScript 6, ESM-Paket, SWC statt ts-node |
| 11.42.0 | 2026-10 | Schutz auf jedem Einstiegspunkt, SSRF-Schutz, deaktivierbare Mandanten |
| 11.38.0 | 2026-09 | Security-Header, Legacy-Auth als Opt-in, ablaufende Reset-Tokens |
| 11.35.0 | 2026-09 | Feldrechte auf verschachtelten Typen, Mandantenkontext auf WebSockets |
| 11.33.0 | 2026-08 | Optional Redis und S3 für den Betrieb mit mehreren Replikaten |
| 11.21.0 | - | Multi-Tenancy, Mongoose-Plugins, Response-Interceptor |
| 11.17.0 | - | Better Auth IAM-Only-Modus, BetterAuth-Rollen-Guard |
| 11.6.0 | - | Better Auth eingeführt |
| 11.0.0 | - | NestJS 11 Migration, Express 5, Mongoose 9 |
