import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import envConfig from './config.env';
import { ServerModule } from './server/server.module';
import { express as voyagerMiddleware } from 'graphql-voyager/middleware';

/**
 * Preparations for server start
 */
async function bootstrap() {
  // Create a new server based on fastify
  const server = await NestFactory.create<NestExpressApplication>(
    // Include server module, with all necessary modules for the project
    ServerModule
  );

  // Asset directory
  server.useStaticAssets(envConfig.staticAssets.path, envConfig.staticAssets.options);

  // Templates directory
  server.setBaseViewsDir(envConfig.templates.path);
  server.setViewEngine(envConfig.templates.engine);

  // Enable cors to allow requests from other domains
  server.enableCors();

  // Activate GraphQL Voyager
  if (envConfig.graphQl?.voyager) {
    server.use('/voyager', voyagerMiddleware({ endpointUrl: '/graphql' }));
  }

  // Start server on configured port
  await server.listen(envConfig.port);
}

// Start server
bootstrap();
