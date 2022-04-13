import { ArgumentMetadata, Inject, Injectable, PipeTransform } from '@nestjs/common';
import { CONTEXT } from '@nestjs/graphql';
import { getContextData } from '../helpers/context.helper';
import { check } from '../helpers/input.helper';

/**
 * The CheckInputPipe checks the permissibility of individual properties of inputs for the resolvers
 * in relation to the current user
 *
 * ATTENTION: Pipe does not work yet, because context is missing: https://github.com/nestjs/graphql/issues/325
 * Once this works MapAndValidate can be replaced in the CoreModule with this pipe.
 */
@Injectable()
export class CheckInputPipe implements PipeTransform {
  /**
   * Constructor to inject context
   */
  constructor(@Inject(CONTEXT) protected readonly context) {}

  /**
   * Check input
   */
  async transform(value: any, metadata: ArgumentMetadata) {
    // Get meta type
    const metatype = metadata?.metatype;

    // Get user
    const { user }: any = getContextData(this.context);

    // Check and return
    return check(value, user, metatype);
  }
}
