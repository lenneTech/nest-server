import {
  ArgumentMetadata,
  BadRequestException,
  Inject,
  Injectable,
  PipeTransform,
  Scope,
} from '@nestjs/common';
import { CONTEXT } from '@nestjs/graphql';
import { plainToClass } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { checkRestricted } from '../decorators/restricted.decorator';
import { Context } from '../helpers/context.helper';

/**
 * The CheckInputPipe checks the permissibility of individual properties of inputs for the resolvers
 * in relation to the current user
 */
@Injectable({ scope: Scope.REQUEST })
export class CheckInputPipe implements PipeTransform<any> {
  /**
   * Constructor to inject context
   */
  constructor(@Inject(CONTEXT) private readonly context) {}

  /**
   * Check input
   */
  async transform(value: any, { metatype }: ArgumentMetadata) {
    // Return value if it is only a basic type
    if (!metatype || this.isBasicType(metatype)) {
      return value;
    }

    // Remove restricted values if roles are missing
    const { user }: any = Context.getData(this.context);
    value = checkRestricted(value, user);

    // Validate value
    const plainValue = JSON.parse(JSON.stringify(value));
    const object = plainToClass(metatype, plainValue);
    const errors: ValidationError[] = await validate(object);

    // Check errors
    if (errors.length > 0) {
      throw new BadRequestException('Validation failed');
    }

    // Everything is ok
    return value;
  }

  /**
   * Checks if it is a basic type
   */
  private isBasicType(metatype: any): boolean {
    const types = [String, Boolean, Number, Array, Object, Buffer, ArrayBuffer];
    return types.includes(metatype);
  }
}
