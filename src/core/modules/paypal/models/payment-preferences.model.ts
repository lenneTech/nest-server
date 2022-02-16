import { Document } from 'mongoose';
import { Field, ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema } from '@nestjs/mongoose/dist/decorators/schema.decorator';
import { Prop, SchemaFactory } from '@nestjs/mongoose';
import { SetupFee } from './setup-fee.model';
import { CoreModel } from '../../../common/models/core-model.model';

export type PaymentPreferencesDocument = PaymentPreferences & Document;

/**
 * PaymentPreferences model
 */
@ObjectType({ description: 'PaymentPreferences' })
@MongooseSchema({ _id: false })
export class PaymentPreferences extends CoreModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'auto_bill_outstanding of PaymentPreferences' })
  @Prop()
  auto_bill_outstanding: boolean = undefined;

  @Field(() => SetupFee, { description: 'setup_fee of PaymentPreferences' })
  @Prop({ type: SetupFee })
  setup_fee: SetupFee = undefined;

  @Field({ description: 'setup_fee_failure_action of PaymentPreferences' })
  @Prop()
  setup_fee_failure_action: string = undefined;

  @Field({ description: 'payment_failure_threshold of PaymentPreferences' })
  @Prop()
  payment_failure_threshold: number = undefined;
}

export const PaymentPreferencesSchema = SchemaFactory.createForClass(PaymentPreferences);
