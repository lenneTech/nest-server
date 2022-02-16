import { Field, ObjectType } from '@nestjs/graphql';
import { CorePersistenceModel } from '../../../../common/models/core-persistence.model';
import { InvoicePaymentTerm } from './invoice-payment-term.model';
import { InvoiceMetadata } from './invoice-metadata.model';

/**
 * InvoiceDetail model
 */
@ObjectType({ description: 'InvoiceDetail' })
export class InvoiceDetail extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'invoice_number of InvoiceDetail' })
  invoice_number: string = undefined;

  @Field({ description: 'reference of InvoiceDetail' })
  reference: string = undefined;

  @Field({ description: 'invoice_date of InvoiceDetail' })
  invoice_date: string = undefined;

  @Field({ description: 'currency_code of InvoiceDetail' })
  currency_code: string = undefined;

  @Field({ description: 'note of InvoiceDetail' })
  note: string = undefined;

  @Field({ description: 'term of InvoiceDetail' })
  term: string = undefined;

  @Field({ description: 'memo of InvoiceDetail' })
  memo: string = undefined;

  @Field(() => InvoicePaymentTerm, { description: 'payment_term of InvoiceDetail' })
  payment_term: InvoicePaymentTerm = undefined;

  @Field(() => InvoiceMetadata, { description: 'metadata of InvoiceDetail' })
  metadata: InvoiceMetadata = undefined;
}
