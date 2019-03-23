import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

// Bootstrap server
async function bootstrap() {

  // Init fastify
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule, new FastifyAdapter(),
  );

  // Enable CORS
  app.enableCors();

  // Start server
  await app.listen(3000);
}

// Start server
bootstrap();
