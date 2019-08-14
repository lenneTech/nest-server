import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import envConfig from './config.env';
import { ServerModule } from './server.module';

/**
 * Preparations for server start
 */
async function bootstrap() {
  // Create a new server based on fastify
  const server = await NestFactory.create<NestExpressApplication>(
    // Include server module, with all necessary modules for the project
    ServerModule,
  );

  // Asset directory
  server.useStaticAssets(
    envConfig.staticAssets.path,
    envConfig.staticAssets.options,
  );

  // Enable cors to allow requests from other domains
  server.enableCors();

  // Start server on configured port
  await server.listen(envConfig.port);
}

// Start server
bootstrap();
