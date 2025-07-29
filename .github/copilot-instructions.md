# GitHub Copilot Instructions for lenne.Tech Nest Server

This file provides specific guidance for GitHub Copilot when working with this NestJS-based server project.

## Project Overview

This is a **NestJS server framework** with:
- **GraphQL API** using Apollo Server
- **MongoDB** integration with Mongoose
- **JWT authentication** with refresh tokens
- **Role-based access control**
- **Modular architecture** with Core/Server separation

## Code Architecture & Patterns

### Module Structure
- **Core modules** (`src/core/`): Reusable framework components
- **Server modules** (`src/server/`): Project-specific implementations
- Use `CoreModule.forRoot()` for dynamic module configuration
- Extend core classes rather than creating from scratch

### Model Patterns
```typescript
// Always extend CorePersistenceModel for database entities
@MongooseSchema({ timestamps: true })
@ObjectType({ description: 'Your Model' })
@Restricted(RoleEnum.S_EVERYONE)
export class YourModel extends CorePersistenceModel {
  @UnifiedField({
    description: 'Field description',
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsString()],
  })
  fieldName: string = undefined;
}
```

### Input Classes
```typescript
// Use CoreInput as base and UnifiedField decorator
@InputType({ description: 'Your input' })
@Restricted(RoleEnum.S_EVERYONE)
export class YourInput extends CoreInput {
  @UnifiedField({
    description: 'Field description',
    isOptional: false,
    roles: RoleEnum.S_EVERYONE,
    validator: () => [IsString(), IsNotEmpty()],
  })
  fieldName: string = undefined;
}
```

### Service Patterns
```typescript
// Extend CrudService for standard CRUD operations
@Injectable()
export class YourService extends CrudService<YourModel, YourCreateInput, YourUpdateInput> {
  constructor(
    @InjectModel('YourModel') protected readonly model: Model<YourModelDocument>,
    protected readonly configService: ConfigService,
  ) {
    super({ model });
  }
}
```

## Security & Authorization

### Access Control
- Use `@Restricted(RoleEnum.ROLE_NAME)` on classes and fields
- Use `@Roles(RoleEnum.ROLE_NAME)` on methods
- Never expose sensitive fields without proper restrictions
- Password fields should use `@Restricted(RoleEnum.S_NO_ONE)`

### Authentication
- JWT tokens contain: `id`, `deviceId`, `tokenId`, `deviceDescription`
- Refresh tokens are stored in `user.refreshTokens[deviceId]`
- Use `@CurrentUser()` decorator to access authenticated user
- Device tracking is automatic via `deviceId`

## Database Patterns

### Mongoose Configuration
- Use `@Prop()` for simple fields
- Use `@Prop(raw({}))` for dynamic objects
- Index important fields with `@Prop({ index: true })`
- Always use timestamps: `@MongooseSchema({ timestamps: true })`

### Filtering & Pagination
```typescript
// Use built-in filtering and pagination
async findMany(
  filter?: FilterArgs,
  pagination?: PaginationArgs,
  serviceOptions?: ServiceOptions,
): Promise<YourModel[]> {
  return super.find(filter, serviceOptions, pagination);
}
```

## GraphQL Patterns

### Resolvers
```typescript
@Resolver(() => YourModel)
export class YourResolver {
  @Query(() => YourModel)
  @Roles(RoleEnum.USER)
  async getYour(@Args() args: GetArgs): Promise<YourModel> {
    return this.yourService.get(args.id);
  }

  @Mutation(() => YourModel)
  @Roles(RoleEnum.USER)
  async createYour(@Args('input') input: YourCreateInput): Promise<YourModel> {
    return this.yourService.create(input);
  }
}
```

### Field Resolvers
```typescript
@ResolverField(() => [RelatedModel])
async relatedItems(@Parent() parent: YourModel): Promise<RelatedModel[]> {
  return this.relatedService.find({ yourId: parent.id });
}
```

## Development Practices

### Error Handling
- Use NestJS exceptions: `BadRequestException`, `UnauthorizedException`
- Provide meaningful error messages
- Handle validation errors automatically via `MapAndValidatePipe`

### Testing
- Write E2E tests in `tests/` directory
- Use `test.helper.ts` utilities
- Test with `NODE_ENV=local`
- Mock external services appropriately

### Configuration
- Environment configs in `src/config.env.ts`
- Support multiple config sources:
  - Direct environment variables
  - `NEST_SERVER_CONFIG` JSON
  - `NSC__*` prefixed variables

## File Organization

### New Features
1. Create module in appropriate location (`src/core/` or `src/server/`)
2. Include: model, service, resolver, controller (if needed)
3. Add input/output classes in dedicated folders
4. Export everything in module's `index.ts`

### Naming Conventions
- Models: `YourModel` (singular)
- Services: `YourService`
- Resolvers: `YourResolver`
- Controllers: `YourController`
- Inputs: `YourCreateInput`, `YourUpdateInput`
- Files: kebab-case (e.g., `your-model.model.ts`)

## Common Commands

### Development
```bash
npm start              # Start local development
npm run start:dev      # Start with file watching
npm run build          # Build application
npm run lint           # Run ESLint
npm run test:e2e       # Run E2E tests
npm run docs           # Generate documentation
```

### Package Development
```bash
npm run build:dev      # Build and push to yalc
npm run build:pack     # Create tarball for testing
```

## Anti-Patterns to Avoid

❌ **Don't do:**
- Create models without extending `CorePersistenceModel`
- Use plain `@Field()` instead of `@UnifiedField()`
- Expose sensitive data without `@Restricted()`
- Create services without proper CRUD patterns
- Skip input validation
- Hardcode configuration values
- Create duplicate authentication logic

✅ **Do instead:**
- Follow established inheritance patterns
- Use framework decorators and helpers
- Implement proper security restrictions
- Leverage existing CRUD functionality
- Use configuration system
- Follow modular architecture

## TypeScript Guidelines

- Use strict typing, avoid `any`
- Use interfaces for complex data structures
- Prefer composition over inheritance where appropriate
- Use proper generics for reusable components
- Export types alongside implementation files

## Email & Templates

- Use `EmailService` for sending emails
- Templates are in `src/templates/` using EJS
- Support both SMTP and Mailjet providers
- Use `TemplateService` for rendering

Remember: This is a **framework package** that can be extended. Focus on creating reusable, well-documented components that follow the established patterns.