import { Injectable, Logger, OnModuleInit, Optional, PayloadTooLargeException } from '@nestjs/common';
import { HttpAdapterHost, ModuleRef } from '@nestjs/core';
import { json, urlencoded } from 'express';

import { ErrorCode } from '../../modules/error-code/error-codes';
import { IBodyParserConfig } from '../interfaces/server-options.interface';
import { ConfigService } from './config.service';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** The two parsers NestJS registers on every Express application */
export type CoreBodyParserType = 'json' | 'urlencoded';

/**
 * The function names body-parser gives its middleware. NestJS identifies its own parser layers by
 * exactly these names (`ExpressAdapter.isMiddlewareApplied()`), which is why a wrapper must keep them.
 */
const PARSER_NAMES: Record<CoreBodyParserType, string> = { json: 'jsonParser', urlencoded: 'urlencodedParser' };

/** 1024-based, like the `bytes` package body-parser itself parses limits with */
const UNIT_FACTORS: Record<string, number> = { b: 1, gb: 1024 ** 3, kb: 1024, mb: 1024 ** 2 };

/** The router layer fields this initializer reads and writes (Express 5 / `router` 2.x) */
interface ExpressLayer {
  handle: RequestHandler;
  slash?: boolean;
}

/**
 * Convert a configured body limit into bytes.
 *
 * Returns `undefined` for anything that is not a positive size, so the caller can refuse it. The
 * value is turned into a number HERE rather than handed to body-parser as a string, so the limit that
 * is logged and the limit that is enforced cannot differ.
 *
 * @example parseBodyLimit('2mb') // 2097152
 * @example parseBodyLimit(500000) // 500000
 * @example parseBodyLimit('lots') // undefined
 */
export function parseBodyLimit(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const bytes = Math.floor(Number(match[1]) * UNIT_FACTORS[(match[2] || 'b').toLowerCase()]);
  return bytes >= 1 ? bytes : undefined;
}

/**
 * Applies `ServerOptions.bodyParser` to the body parsers NestJS registered, and turns their 413 into
 * an answer a caller can act on.
 *
 * WHY it swaps layers instead of calling `useBodyParser()`: NestJS registers its parsers inside
 * `app.init()`, BEFORE any `onModuleInit` runs, and a parser appended afterwards would sit behind
 * the routes. So the layers NestJS created are replaced in place — same position in the middleware
 * chain, same options otherwise. Doing it during module init (rather than in `main.ts`) is what
 * makes the limit hold under `Test.createTestingModule()`, which never runs `main.ts`.
 *
 * Unconfigured, the parsers are not replaced, only wrapped: their own limit and options stay, and a
 * 413 they raise is answered with `ErrorCode.REQUEST_BODY_TOO_LARGE` plus size and limit instead of
 * a bare "request entity too large", and logged as a warning that names the route and the config
 * key. Without that line the first symptom of a too-small limit is a user whose save keeps failing.
 *
 * Registered as a CoreModule provider; consumers never interact with it.
 */
@Injectable()
export class CoreBodyParserInitializer implements OnModuleInit {
  protected readonly logger = new Logger(CoreBodyParserInitializer.name);

  constructor(
    @Optional() protected readonly httpAdapterHost?: HttpAdapterHost,
    @Optional() protected readonly moduleRef?: ModuleRef,
  ) {}

  onModuleInit(): void {
    const stack = this.getRouterStack();
    if (!stack) {
      // Fastify and non-HTTP contexts have no body-parser layers; there is nothing to adjust.
      return;
    }

    const config = this.getConfig();
    for (const type of ['json', 'urlencoded'] as const) {
      const limit = this.resolveLimit(type, config?.[type]?.limit);
      const layers = stack.filter((layer) => this.isGlobalParserLayer(layer, type));

      if (!layers.length) {
        this.warnMissingGlobalParser(type, stack, limit);
        continue;
      }

      for (const layer of layers) {
        const parser = limit === undefined ? layer.handle : this.createParser(type, limit);
        layer.handle = this.wrapParser(type, parser);
      }

      if (limit !== undefined) {
        this.logger.log(`Body parser: ${type} limit set to ${limit} bytes`);
      }
    }
  }

  /**
   * A parser equivalent to the one NestJS registers, with the configured limit.
   *
   * `extended: true` mirrors NestJS's URL-encoded default (nested objects via `qs`). `req.rawBody`
   * is kept when the app was created with `rawBody: true`, because webhook signature checks read it
   * and would otherwise fail on every request once a limit is configured.
   */
  protected createParser(type: CoreBodyParserType, limit: number): RequestHandler {
    const verify = this.isRawBodyEnabled() ? captureRawBody : undefined;
    return type === 'json' ? json({ limit, verify }) : urlencoded({ extended: true, limit, verify });
  }

  /** The configured `bodyParser` block, or `undefined` when the project did not set one */
  protected getConfig(): IBodyParserConfig | undefined {
    return ConfigService.getFastButReadOnly<IBodyParserConfig>('bodyParser');
  }

  /** The Express router stack, or `undefined` for a non-Express adapter */
  protected getRouterStack(): ExpressLayer[] | undefined {
    const app = this.httpAdapterHost?.httpAdapter?.getInstance?.();
    if (typeof app?.use !== 'function' || typeof app?.set !== 'function') {
      return undefined;
    }
    const stack = app.router?.stack;
    return Array.isArray(stack) ? stack : undefined;
  }

  /**
   * Whether a layer is a GLOBAL parser of this type.
   *
   * `slash` is how the Express 5 router marks `app.use(fn)` — mounted on `/` without an end. A
   * path-scoped `app.use('/upload', json({ limit }))` is a project's deliberate exception for one
   * path and is left alone, including its 413.
   */
  protected isGlobalParserLayer(layer: ExpressLayer | undefined, type: CoreBodyParserType): boolean {
    return layer?.slash === true && typeof layer.handle === 'function' && layer.handle.name === PARSER_NAMES[type];
  }

  /**
   * Whether the application was created without `bodyParser: false`.
   *
   * Read from the same container options as `rawBody`. Under `Test.createTestingModule()` those
   * options never reach the container, so the answer there is always "enabled".
   */
  protected isBodyParserEnabled(): boolean {
    const container = (this.moduleRef as unknown as { container?: { contextOptions?: { bodyParser?: boolean } } })
      ?.container;
    return container?.contextOptions?.bodyParser !== false;
  }

  /**
   * Whether the application was created with `rawBody: true`.
   *
   * `NestFactory.create()` hands its options to the container and nothing public exposes them, so
   * they are read from the container `ModuleRef` carries. Under `Test.createTestingModule()` the
   * options passed to `createNestApplication()` never reach the container — that is the caveat
   * documented on `IServerOptions.bodyParser`.
   */
  protected isRawBodyEnabled(): boolean {
    const container = (this.moduleRef as unknown as { container?: { contextOptions?: { rawBody?: boolean } } })
      ?.container;
    return container?.contextOptions?.rawBody === true;
  }

  /**
   * The configured limit in bytes, or `undefined` when unset or invalid.
   *
   * An invalid value is refused rather than passed on: body-parser would throw at boot for some
   * inputs and apply nonsense (a negative limit rejects every body) for others. The parser keeps the
   * limit it has — never "no limit", since it runs before authentication.
   */
  protected resolveLimit(type: CoreBodyParserType, value: unknown): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const limit = parseBodyLimit(value);
    if (limit === undefined) {
      this.logger.error(
        `bodyParser.${type}.limit ${JSON.stringify(value)} is not a positive size (bytes, or e.g. '500kb' / '2mb') ` +
          `— ignored, the ${type} body parser keeps the limit it has (100 kB unless set elsewhere).`,
      );
    }
    return limit;
  }

  /**
   * Answer a body-parser 413 with an error code, the size and the limit, and log it.
   *
   * Every other error (malformed JSON, unsupported charset, too many parameters) passes through
   * unchanged, so NestJS answers it exactly as before.
   */
  protected translateError(type: CoreBodyParserType, error: unknown, req: Request): unknown {
    const details = error as undefined | { length?: unknown; limit?: unknown; type?: unknown };
    if (details?.type !== 'entity.too.large') {
      return error;
    }

    // `length` is the declared Content-Length; a chunked body has none, and the byte count at which
    // body-parser stopped reading says nothing about how large the body really was.
    const length = typeof details.length === 'number' ? details.length : undefined;
    const sizeText = length === undefined ? '' : `${length} bytes, `;
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];

    this.logger.warn(
      `413 ${req.method} ${path}: ${type} body ${length === undefined ? '' : `of ${length} bytes `}` +
        `exceeds the limit of ${details.limit} bytes. If payloads of this size are legitimate here, ` +
        `raise \`bodyParser.${type}.limit\` in the server options.`,
    );
    return new PayloadTooLargeException(
      `${ErrorCode.REQUEST_BODY_TOO_LARGE} [${sizeText}limit ${details.limit} bytes]`,
    );
  }

  /**
   * Explain why there is no global parser of this type, when there should be one.
   *
   * NestJS registers its own parsers inside `app.init()` only if no layer with the parser's function
   * name exists yet (`ExpressAdapter.isMiddlewareApplied()` compares the NAME and nothing else). A
   * path-scoped `server.use('/upload', json({ limit }))` in `main.ts` therefore counts as "applied",
   * NestJS skips its global parser, and every request outside that path reaches its handler with an
   * empty body — a sign-in fails with a validation error, and nothing says why. Restoring the parser
   * from here is not safe: NestJS would have placed it after everything `main.ts` registered, and that
   * position is no longer knowable during module init (a raw-body webhook or a proxy registered after
   * the path-scoped parser must keep seeing the unread stream). So this reports, with the remedy.
   */
  protected warnMissingGlobalParser(type: CoreBodyParserType, stack: ExpressLayer[], limit: number | undefined): void {
    const name = PARSER_NAMES[type];
    const shadowed = stack.some((layer) => layer?.slash !== true && layer?.handle?.name === name);
    if (shadowed && this.isBodyParserEnabled()) {
      this.logger.warn(
        `No global ${type} body parser is registered: NestJS skips its own when a layer named \`${name}\` ` +
          `already exists, and a path-scoped \`${type}()\` parser registered before \`app.init()\` counts as one. ` +
          `Every request outside that path reaches its handler with an EMPTY body. Register the global parser ` +
          `in main.ts as well — \`server.useBodyParser('${type}')\` — a configured \`bodyParser.${type}.limit\` ` +
          'is applied to it.',
      );
      return;
    }
    if (limit !== undefined) {
      this.logger.warn(
        `bodyParser.${type}.limit is configured, but no global ${type} body parser is registered ` +
          '(was the app created with `bodyParser: false`?) — the limit has no effect.',
      );
    }
  }

  /**
   * Wrap a parser so its 413 is translated, keeping the name NestJS identifies the layer by.
   *
   * Wrapping an already wrapped parser is harmless: the outer wrapper receives the translated
   * `PayloadTooLargeException`, which carries no body-parser `type`, and passes it on unchanged.
   */
  protected wrapParser(type: CoreBodyParserType, parser: RequestHandler): RequestHandler {
    const wrapped = (req: Request, res: Response, next: NextFunction) =>
      parser(req, res, (error?: unknown) => (error ? next(this.translateError(type, error, req)) : next()));
    Object.defineProperty(wrapped, 'name', { value: PARSER_NAMES[type] });
    return wrapped;
  }
}

/** Same behaviour as the `verify` NestJS installs for `rawBody: true` */
function captureRawBody(req: Request & { rawBody?: Buffer }, _res: Response, buffer: Buffer): void {
  if (Buffer.isBuffer(buffer)) {
    req.rawBody = buffer;
  }
}
