import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { FixedPrice } from './fixed-price.model';
import { CoreModel } from '../../../common/models/core-model.model';

export type PricingSchemeDocument = PricingScheme & Document;

/**
 * PricingScheme model
 */
@ObjectType({ description: 'PricingScheme' })
@MongooseSchema({ _id: false })
export class PricingScheme extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field(() => FixedPrice, { description: 'auto_bill_outstanding of PricingScheme' })
  @Prop({ type: FixedPrice })
  fixed_price: FixedPrice = undefined;

  @Field({ description: 'setup_fee of PricingScheme' })
  @Prop()
  version: number = undefined;

  @Field({ description: 'create_time of PricingScheme' })
  @Prop()
  create_time: string = undefined;

  @Field({ description: 'update_time of PricingScheme' })
  @Prop()
  update_time: string = undefined;
}

export const PricingSchemeSchema = SchemaFactory.createForClass(PricingScheme);
