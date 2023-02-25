import { createParamDecorator } from '@nestjs/common';
import { currentUserDec } from '../helpers/decorator.helper';

/**
 * Decorator to get current user for Controller (http context) and Resolver (graphql context)
 */
export const CurrentUser = createParamDecorator(currentUserDec);
