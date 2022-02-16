import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { Frequency } from './frequency.model';
import { PricingScheme } from './pricing-scheme.model';
import { CoreModel } from '../../../common/models/core-model.model';

export type BillingCyclesDocument = BillingCycles & Document;

/**
 * BillingCycles model
 */
@ObjectType({ description: 'BillingCycles' })
@MongooseSchema({ _id: false })
export class BillingCycles extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field(() => Frequency, { description: 'frequency of BillingCycles' })
  @Prop({ type: Frequency })
  frequency: Frequency = undefined;

  @Field({ description: 'tenure_type of BillingCycles' })
  @Prop()
  tenure_type: string = undefined;

  @Field({ description: 'sequence of BillingCycles' })
  @Prop()
  sequence: number = undefined;

  @Field({ description: 'total_cycles of BillingCycles' })
  @Prop()
  total_cycles: number = undefined;

  @Field(() => PricingScheme, { description: 'pricing_scheme of BillingCycles' })
  @Prop({ type: PricingScheme })
  pricing_scheme: PricingScheme = undefined;
}

export const BillingCyclesSchema = SchemaFactory.createForClass(BillingCycles);
