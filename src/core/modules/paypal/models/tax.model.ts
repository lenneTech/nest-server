import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { CoreModel } from '../../../common/models/core-model.model';

export type TaxDocument = Tax & Document;

/**
 * Tax model
 */
@ObjectType({ description: 'Tax' })
@MongooseSchema({ _id: false })
export class Tax extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'percentage of Tax' })
  @Prop()
  percentage: string = undefined;

  @Field({ description: 'inclusive of Tax' })
  @Prop()
  inclusive: boolean = undefined;
}

export const TaxSchema = SchemaFactory.createForClass(Tax);
