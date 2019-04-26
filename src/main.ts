import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import envConfig from './config.env';
import { ServerModule } from './server.module';

async function bootstrap() {
  const server = await NestFactory.create<NestFastifyApplication>(
    ServerModule,
    new FastifyAdapter(),
  );
  server.enableCors();
  await server.listen(envConfig.port);
}

bootstrap();
