import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { CorePersistenceModel } from '../../../common/models/core-persistence.model';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { Tax } from './tax.model';
import { BillingCycles } from './billing-cycles.model';
import { PaymentPreferences } from './payment-preferences.model';
import { ModelHelper } from '../../../common/helpers/model.helper';

export type SubscriptionPlanDocument = SubscriptionPlan & Document;

/**
 * SubscriptionPlan model
 */
@ObjectType({ description: 'SubscriptionPlan' })
@MongooseSchema({ timestamps: true, id: true })
export class SubscriptionPlan extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'product_id of SubscriptionPlan' })
  @Prop()
  product_id: string = undefined;

  @Field({ description: 'name of SubscriptionPlan' })
  @Prop()
  name: string = undefined;

  @Field({ description: 'status of SubscriptionPlan' })
  @Prop()
  status: string = undefined;

  @Field({ description: 'description of SubscriptionPlan' })
  @Prop()
  description: string = undefined;

  @Field(() => [BillingCycles], { description: 'billing_cycles of SubscriptionPlan' })
  @Prop([{ type: BillingCycles }])
  billing_cycles: BillingCycles[] = [];

  @Field(() => PaymentPreferences, { description: 'payment_preferences of SubscriptionPlan' })
  @Prop({ type: PaymentPreferences })
  payment_preferences: PaymentPreferences = undefined;

  @Field(() => Tax, { description: 'taxes of SubscriptionPlan', nullable: true })
  @Prop({ type: Tax })
  taxes: Tax = undefined;

  @Field({ description: 'quantity_supported of SubscriptionPlan' })
  @Prop()
  quantity_supported: boolean = undefined;

  @Field({ description: 'create_time of SubscriptionPlan' })
  @Prop()
  create_time: string = undefined;

  @Field({ description: 'update_time of SubscriptionPlan' })
  @Prop()
  update_time: string = undefined;

  // ===================================================================================================================
  // Methods
  // ===================================================================================================================
  /**
   * Overwrite parent map methode
   */
  public map(
    data: Partial<this> | { [key: string]: any },
    options: {
      cloneDeep?: boolean;
      funcAllowed?: boolean;
      mapId?: boolean;
    } = {}
  ): this {
    super.map(data, options);
    this.billing_cycles = ModelHelper.maps(data.billing_cycles, BillingCycles) || [];
    return this;
  }
}

export const SubscriptionPlanSchema = SchemaFactory.createForClass(SubscriptionPlan);
