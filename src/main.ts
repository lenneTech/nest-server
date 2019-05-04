import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import envConfig from './config.env';
import { ServerModule } from './server.module';

/**
 * Preparations for server start
 */
async function bootstrap() {

  // Create a new server based on fastify
  const server = await NestFactory.create<NestFastifyApplication>(

    // Include server module, with all necessary modules for the project
    ServerModule,

    // Use fastify instead of express
    new FastifyAdapter(),
  );

  // Enable cors to allow requests from other domains
  server.enableCors();

  // Start server on configured port
  await server.listen(envConfig.port);
}

// Start server
bootstrap();
