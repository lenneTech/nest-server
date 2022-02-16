import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { CoreModel } from '../../../common/models/core-model.model';

export type FixedPriceDocument = FixedPrice & Document;

/**
 * FixedPrice model
 */
@ObjectType({ description: 'FixedPrice' })
@MongooseSchema({ _id: false })
export class FixedPrice extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'currency_code of FixedPrice' })
  @Prop()
  currency_code: string = undefined;

  @Field({ description: 'value of FixedPrice' })
  @Prop()
  value: string = undefined;
}

export const FixedPriceSchema = SchemaFactory.createForClass(FixedPrice);
