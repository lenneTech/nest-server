import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { CoreModel } from '../../../common/models/core-model.model';

export type FrequencyDocument = Frequency & Document;

/**
 * Frequency model
 */
@ObjectType({ description: 'Frequency' })
@MongooseSchema({ _id: false })
export class Frequency extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'interval_unit of Frequency' })
  @Prop()
  interval_unit: string = undefined;

  @Field({ description: 'interval_count of Frequency' })
  @Prop()
  interval_count: number = undefined;
}

export const FrequencySchema = SchemaFactory.createForClass(Frequency);
