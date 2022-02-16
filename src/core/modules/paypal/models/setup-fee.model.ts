import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { CoreModel } from '../../../common/models/core-model.model';

export type SetupFeeDocument = SetupFee & Document;

/**
 * SetupFee model
 */
@ObjectType({ description: 'SetupFee' })
@MongooseSchema({ _id: false })
export class SetupFee extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'value of SetupFee' })
  @Prop()
  value: string = undefined;

  @Field({ description: 'currency_code of SetupFee' })
  @Prop()
  currency_code: string = undefined;
}

export const SetupFeeSchema = SchemaFactory.createForClass(SetupFee);
