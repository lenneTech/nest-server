import { SetMetadata } from '@nestjs/common';

/** Metadata key of {@link ApiMethods} */
export const API_METHODS_KEY = 'lt:apiMethods';

/**
 * Lists the HTTP methods an `@All()` handler actually serves.
 *
 * `@nestjs/swagger` documents an `@All()` handler as eight operations (GET, POST, PUT, DELETE, PATCH,
 * OPTIONS, HEAD, SEARCH), whatever the handler does with them. `setupSwagger()` keeps only the methods
 * named here, so a catch-all that serves three of them is documented with three.
 *
 * @example
 * ```typescript
 * @All(':id')
 * @ApiMethods('head', 'patch', 'delete')
 * async handleUpload(@Req() req: Request, @Res() res: Response) { … }
 * ```
 * @since 11.42.9
 */
export const ApiMethods = (...methods: string[]) =>
  SetMetadata(
    API_METHODS_KEY,
    methods.map((method) => method.toLowerCase()),
  );
