---
title: nest-server
description: An extension layer on top of NestJS for server applications with REST, GraphQL, authentication, multi-tenancy and MongoDB, PostgreSQL, MySQL or MariaDB.
navigation:
  title: Overview
---

`@lenne.tech/nest-server` is the backend framework of the lenne.tech stack. A project either installs it as an npm
package (`@lenne.tech/nest-server`) or copies its core into the project (vendor mode). New projects start from the
[nest-server-starter](https://github.com/lenneTech/nest-server-starter), usually through the lt CLI
(`lt fullstack init` or `lt server create`).

## Where to start

| Page | When you need it |
|---|---|
| [Request Lifecycle & Security Architecture](./REQUEST-LIFECYCLE.md) | How a request flows through the framework, every security mechanism, the decorator reference |
| [Choosing a database](./choosing-a-database.md) | Deciding between MongoDB, PostgreSQL and MySQL / MariaDB for a project |
| [Error Codes](./error-codes.md) | Looking up an error code and how to resolve it |
| [Native MongoDB Driver Access](./native-driver-security.md) | Before using the native MongoDB driver instead of Mongoose |
| [process() Performance Optimization](./process-performance-optimization.md) | Hot paths, service cascades and large subdocument arrays |
| [Offline sync protocol](./offline-sync-protocol.md) | Building an offline-capable client on the sync module |
| [Security Overrides](./security-overrides.md) | Keeping the dependency tree of your project free of known vulnerabilities |

## More in the repository

- [README](https://github.com/lenneTech/nest-server/blob/main/README.md): installation and configuration
- [FRAMEWORK-API.md](https://github.com/lenneTech/nest-server/blob/main/FRAMEWORK-API.md): generated API reference of
  the configuration interfaces and `CrudService`
- [Migration guides](https://github.com/lenneTech/nest-server/tree/main/migration-guides): what to change when
  updating to a new version
- Core modules: each module under
  [`src/core/modules/`](https://github.com/lenneTech/nest-server/tree/main/src/core/modules) has a `README.md` and,
  where a project has to wire it up, an `INTEGRATION-CHECKLIST.md`
