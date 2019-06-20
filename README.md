# lenne.Tech Nest Server

Modern, fast, powerful Node.js web framework in TypeScript based on Nest with a GraphQL API and a connection to MongoDB
(or other databases).

## Description

The lenne.Tech **Nest Server** is based on the [Nest](https://github.com/nestjs/nest) framework and can either be used 
and extended as a boilerplate (git clone) or integrated as a module (npm package).

## Boilerplate / npm package

**Boilerplate** 
You can use the git repository as a template to start your new server. So you can manipulate the complete source code 
of the nest server, but you have to update the core yourself. 
 
```bash
$ git clone https://github.com/lenneTech/nest-server.git
$ cd node-server
$ npm install
```

**npm package**  
A simpler and recommended variant is the integration via npm package.

```bash
$ cd YOUR-PROJECT
$ npm i @lenne.tech/nest-server
```

*src/main.ts*:  
(see https://github.com/lenneTech/nest-server/tree/master/src/main.ts)
```
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ServerModule } from '@lenne.tech/nest-server';

/**
 * Preparations for server start
 */
async function bootstrap() {

  // Create a new server based on fastify
  const server = await NestFactory.create<NestExpressApplication>(

    // Include server module, with all necessary modules for the project
    ServerModule,
  );

  // Enable cors to allow requests from other domains
  server.enableCors();

  // Start server on configured port
  await server.listen(3000);
}

// Start server
bootstrap();
```

## Running the app

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
