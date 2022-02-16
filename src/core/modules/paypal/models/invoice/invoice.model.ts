import { Field, ObjectType } from '@nestjs/graphql';
import { CorePersistenceModel } from '../../../../common/models/core-persistence.model';
import { InvoiceDetail } from './invoice-detail.model';

/**
 * Invoice model
 */
@ObjectType({ description: 'Invoice' })
export class Invoice extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'id of Invoice' })
  id: string = undefined;

  @Field({ description: 'status of Invoice' })
  status: string = undefined;

  @Field(() => InvoiceDetail, { description: 'status of Invoice' })
  detail: InvoiceDetail = undefined;

  @Field({ description: 'status of Invoice' })
  invoicer: string = undefined;

  @Field({ description: 'status of Invoice' })
  primary_recipients: string = undefined;

  @Field({ description: 'status of Invoice' })
  amount: string = undefined;
}
