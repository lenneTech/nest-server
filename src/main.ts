import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { exec } from 'child_process';
import compression = require('compression');
import cookieParser = require('cookie-parser');

import envConfig from './config.env';
import { FilterArgs } from './core/common/args/filter.args';
import { buildCorsConfig, isCookiesEnabled, isCorsDisabled } from './core/common/helpers/cookies.helper';
import { HttpExceptionLogFilter } from './core/common/filters/http-exception-log.filter';
import { CorePersistenceModel } from './core/common/models/core-persistence.model';
import { CoreAuthModel } from './core/modules/auth/core-auth.model';
import { CoreUserModel } from './core/modules/user/core-user.model';
import { PersistenceModel } from './server/common/models/persistence.model';
import { Auth } from './server/modules/auth/auth.model';
import { User } from './server/modules/user/user.model';
import { ServerModule } from './server/server.module';

/**
 * Preparations for server start
 */
async function bootstrap() {
  // Create a new server based on express
  const server = await NestFactory.create<NestExpressApplication>(
    // Include server module, with all necessary modules for the project
    ServerModule,
  );

  // Log exceptions
  if (envConfig.logExceptions) {
    server.useGlobalFilters(new HttpExceptionLogFilter());
  }

  // Compression (gzip)
  if (envConfig.compression) {
    let envCompressionOptions = {};
    if (typeof envConfig.compression === 'object') {
      envCompressionOptions = envConfig.compression;
    }
    const compressionOptions = {
      filter: () => {
        return true;
      },
      threshold: 0,
      ...envCompressionOptions,
    };
    server.use(compression(compressionOptions));
  }

  // Cookie handling (enabled by default, disable with cookies: false)
  // Pass a signing secret (if configured) to cookieParser so signed cookies can be
  // verified via req.signedCookies. BetterAuth signs its own session cookies
  // independently via HMAC, but the Express layer still benefits from a secret —
  // Legacy Auth cookies and any custom signed cookies rely on this.
  //
  // Fallback chain: jwt.secret → betterAuth.secret (IAM-only mode) → unsigned
  const cookiesEnabled = isCookiesEnabled(envConfig.cookies);
  if (cookiesEnabled) {
    const betterAuthSecret = typeof envConfig.betterAuth === 'object' ? envConfig.betterAuth?.secret : undefined;
    const cookieSecret = envConfig.jwt?.secret || betterAuthSecret;
    server.use(cookieSecret ? cookieParser(cookieSecret) : cookieParser());
  }

  // Asset directory
  server.useStaticAssets(envConfig.staticAssets.path, envConfig.staticAssets.options);

  // Templates directory
  server.setBaseViewsDir(envConfig.templates.path);
  server.setViewEngine(envConfig.templates.engine);

  // Enable CORS (unified with GraphQL and BetterAuth via shared buildCorsConfig helper).
  //
  // Three cases:
  // 1. CORS explicitly disabled (`cors: false` or `cors.enabled: false`) → skip `enableCors()`
  //    entirely. No CORS headers emitted. Same-origin requests still work.
  // 2. Origins resolvable (appUrl/baseUrl/allowedOrigins or allowAll) → use the computed options.
  // 3. Cookies disabled → permissive `enableCors()` without credentials (backward-compatible).
  if (isCorsDisabled(envConfig.cors)) {
    // Case 1 — CORS explicitly disabled. Do nothing.
  } else {
    const corsOptions = buildCorsConfig(envConfig);
    if (Object.keys(corsOptions).length > 0) {
      server.enableCors(corsOptions); // Case 2
    } else if (!cookiesEnabled) {
      server.enableCors(); // Case 3
    }
    // else: cookies enabled but no origins resolvable → secure default (no `enableCors()` call
    // to avoid open CORS with credentials). Callers should configure appUrl/baseUrl/allowedOrigins.
  }

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('Nest Server API')
    .setDescription('API lenne.Tech Nest Server')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const documentFactory = () =>
    SwaggerModule.createDocument(server, config, {
      autoTagControllers: true,
      deepScanRoutes: true,
      extraModels: [CoreUserModel, CoreAuthModel, Auth, User, PersistenceModel, CorePersistenceModel, FilterArgs],
    });
  SwaggerModule.setup('swagger', server, documentFactory, {
    jsonDocumentUrl: '/api-docs-json',
  });

  // Start server on configured port
  await server.listen(envConfig.port, envConfig.hostname);
  console.debug(`Server startet at ${await server.getUrl()}`);

  // Run command after server init
  if (envConfig.execAfterInit) {
    exec(envConfig.execAfterInit, (error, stdout, stderr) => {
      if (error) {
        console.error(`error: ${error.message}`);
        return;
      }

      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }
    });
  }
}

// Start server
bootstrap();
