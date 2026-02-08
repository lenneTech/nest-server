# lenne.Tech Nest Server

Modern, fast, powerful Node.js web framework in TypeScript based on Nest with a GraphQL API and a connection to MongoDB
(or other databases).

The lenne.tech nest server can be included as an npm package (`npm i @lenne.tech/nest-server`) or used directly as a
project (`git clone https://github.com/lenneTech/nest-server.git`).

In combination with Angular (see [lenne.Tech Angular example](https://github.com/lenneTech/angular-example)
incl. [ng-base](https://github.com/lenneTech/ng-base/tree/main/projects/ng-base/README.md)) the Nest Server is an ideal
basis for your next project.

[![License](https://img.shields.io/github/license/lenneTech/nest-server)](/LICENSE)

## Set up your server

The easiest way to set up your own server based on the lenne.Tech Nest Server is to use the
[lenne.Tech Nest Server starter kit](https://github.com/lenneTech/nest-server-starter) via [CLI](https://github.com/lenneTech/cli):

```
$ npm install -g @lenne.tech/cli
$ lt server create <ServerName>
$ cd <ServerName>
```

## Description

The lenne.Tech **Nest Server** is based on the [Nest](https://github.com/nestjs/nest) framework and can either be used
and extended as a boilerplate (git clone) or integrated as a module (npm package).

Since the server is based on [Nest](https://nestjs.com/), you can find all information about extending your server
in the [documentation of Nest](https://docs.nestjs.com/).

We use Mongoose Module from nestjs. (https://docs.nestjs.com/techniques/mongodb)

To create a new Module with model, inputs, resolver and service you can use the [CLI](https://github.com/lenneTech/cli):

```
$ lt server module <ModuleName>
```

We are currently working on a documentation of the extensions and auxiliary classes that the
[lenne.Tech Nest Server](https://github.com/lenneTech/nest-server) contains. As long as this is not yet available,
have a look at the [source code](https://github.com/lenneTech/nest-server/tree/master/src/core).
There you will find a lot of things that will help you to extend your server, such as:

- [GraphQL scalars](https://github.com/lenneTech/nest-server/tree/master/src/core/common/scalars)
- [Filter and pagination](https://github.com/lenneTech/nest-server/tree/master/src/core/common/args)
- [Decorators for restrictions and roles](https://github.com/lenneTech/nest-server/tree/master/src/core/common/decorators)
- [Authorisation handling](https://github.com/lenneTech/nest-server/tree/master/src/core/modules/auth)
- [Ready to use user module](https://github.com/lenneTech/nest-server/tree/master/src/core/modules/user)
- [Common helpers](https://github.com/lenneTech/nest-server/tree/master/src/core/common/helpers) and
  [helpers for tests](https://github.com/lenneTech/nest-server/blob/master/src/test/test.helper.ts)
- ...

## Running the server

```bash
# development
$ npm start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```


## Test

```bash
# unit tests
$ npm test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

Configuration for testing:
```
Node interpreter: /user/local/bin/node
Working directory: FULL_PATH_TO_PROJECT_DIR
Test command: npm run test:e2e
```

## Debugging

Configuration for debugging is:
```
Node interpreter: /user/local/bin/node
Node parameters: node_modules/@nestjs/cli/bin/nest.js start --debug --watch
Working directory: FULL_PATH_TO_PROJECT_DIR
JavaScript file: src/main.ts
```
see [Debug.run.xml](.run/Debug.run.xml)

### Debugging as package in a project
Via [yalc](https://github.com/wclr/yalc) the NestJS Server can be linked into the project.

In NestJS Server run `npm run watch` to watch for changes and build yalc package.
Project use following scripts (via `package.json`):

- `npm run link:nest-server` (for `yalc add @lenne.tech/nest-server && yalc link @lenne.tech/nest-server && npm install`)
- `npm run unlink:nest-server` (for `yalc remove @lenne.tech/nest-server && npm install`)

## Configuration

The configuration of the server is done via the `src/config.env.ts` file. This file is a TypeScript file that exports 
an object with the configuration values. It is automatically integrated into the `ConfigService` 
(see src/core/common/services/config.service.ts).

### Environment variables

To protect sensitive data and to avoid committing them to the repository the `.env` file can be used.
An example `.env` file is provided in the `.env.example` file.

There are multiple ways to manipulate or extend the configuration via environment variables:
1. Via "normal" integration of the environment variables into the `src/config.env.ts`
2. Via JSON in the `NEST_SERVER_CONFIG` environment variable
3. Via single environment variables with the prefix `NSC__` (Nest Server Config)

#### Normal environment variables
Using `dotenv` (see https://www.dotenv.org/) environment variables can directly integrated into the 
`src/config.env.ts` via `process.env`. E.g.:
```typescript
export const config = {
  development: {
    port: process.env.PORT || 3000,
  },
};
```

#### JSON
The `NEST_SERVER_CONFIG` is the environment variable for the server configuration. 
The value of `NEST_SERVER_CONFIG` must be a (multiline) JSON string that will be parsed by the server 
(see config.env.ts). The keys will override the other configuration values via deep merge
(see https://lodash.com/docs/4.17.15#merge, without array merging).

#### Single config variables
The prefix `NSC__` (**N**est **S**erver **C**onfig) can be used to set single configuration values via environment 
variables. The key is the name of the configuration value in uppercase and with double underscores (`__`) instead of 
dots. Single underscores are used to separate compound terms like `DEFAULT_SENDER` for `defaultSender`.
For example, the configuration value `email.defaultSender.name` can be set via the environment variable 
`NSC__EMAIL_DEFAULT_SENDER_NAME`.

## Documentation
The API and developer documentation can automatically be generated.

```bash
# generate and serve documentation
$ npm run docs
```

## Thanks

Many thanks to the developers of [Nest](https://github.com/nestjs/nest)
and all the developers whose packages are used here.

## License

MIT - see LICENSE
