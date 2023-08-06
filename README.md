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
