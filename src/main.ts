import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { CheckResponseInterceptor } from './common/interceptors/check-response.interceptor';
import { CheckPipe } from './common/pipes/check.pipe';
import envConfig from './config.env';
import { ServerModule } from './server.module';

async function bootstrap() {
  const server = await NestFactory.create<NestFastifyApplication>(
    ServerModule,
    new FastifyAdapter(),
  );
  server.useGlobalPipes(new CheckPipe());
  server.useGlobalInterceptors(new CheckResponseInterceptor());
  server.enableCors();
  await server.listen(envConfig.port);
}

bootstrap();
