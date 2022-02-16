import { Module } from '@nestjs/common';
import { PayPalService } from './paypal.service';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { JSON } from '../../common/scalars/json.scalar';
import { SubscriptionPlan, SubscriptionPlanSchema } from './models/subscription-plan.model';
import { PaypalResolver } from './paypal.resolver';

/**
 * PaypalModule
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: SubscriptionPlan.name, schema: SubscriptionPlanSchema }]), HttpModule],
  providers: [JSON, PayPalService, PaypalResolver],
  exports: [MongooseModule, PayPalService, PaypalResolver],
})
export class PaypalModule {}
