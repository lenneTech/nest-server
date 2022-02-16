import { Field, ObjectType } from '@nestjs/graphql';
import { CorePersistenceModel } from '../../../../common/models/core-persistence.model';

/**
 * InvoicePaymentTerm model
 */
@ObjectType({ description: 'InvoicePaymentTerm' })
export class InvoicePaymentTerm extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'term_type of InvoicePaymentTerm' })
  term_type: string = undefined;

  @Field({ description: 'due_date of InvoicePaymentTerm' })
  due_date: string = undefined;
}
