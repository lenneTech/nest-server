import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { SubscriptionPlan } from './models/subscription-plan.model';
import { PayPalService } from './paypal.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { GraphQLUser } from '../../common/decorators/graphql-user.decorator';
import { User } from '../../../server/modules/user/user.model';
import { Invoice } from './models/invoice/invoice.model';

/**
 * PaypalResolver
 */
@Resolver((of) => SubscriptionPlan)
export class PaypalResolver {
  constructor(private paypalService: PayPalService) {}

  // ===========================================================================
  // Queries
  // ===========================================================================

  @Roles(RoleEnum.ADMIN)
  @Query((returns) => Boolean, { description: 'Load SubscriptionPlans from paypal api to db' })
  async loadPlans(): Promise<boolean> {
    return await this.paypalService.loadPlans();
  }

  @Roles(RoleEnum.USER)
  @Query((returns) => [SubscriptionPlan], { description: 'Get all SubscriptionPlans' })
  async getAllPlans(): Promise<SubscriptionPlan[]> {
    return this.paypalService.plans;
  }

  @Roles(RoleEnum.OWNER)
  @Query((returns) => [Invoice], { description: 'Get all invoices from user' })
  async getInvoices(@GraphQLUser() user: User): Promise<Invoice[]> {
    return await this.paypalService.getInvoicesByMail(user.email);
  }

  // ===========================================================================
  // Mutations
  // ===========================================================================

  @Roles(RoleEnum.OWNER)
  @Mutation((returns) => Boolean, { description: 'Cancel active subscription' })
  async cancelSubscription(@Args('subscriptionId') subscriptionId: string): Promise<boolean> {
    return !!(await this.paypalService.cancelSubscription(subscriptionId));
  }
}
