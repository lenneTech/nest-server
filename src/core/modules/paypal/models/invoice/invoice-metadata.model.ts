import { Field, ObjectType } from '@nestjs/graphql';
import { CorePersistenceModel } from '../../../../common/models/core-persistence.model';

/**
 * InvoiceMetadata model
 */
@ObjectType({ description: 'InvoiceMetadata' })
export class InvoiceMetadata extends CorePersistenceModel {
  // ===================================================================================================================
  // Properties
  // ===================================================================================================================

  @Field({ description: 'create_time of InvoiceMetadata' })
  create_time: string = undefined;

  @Field({ description: 'recipient_view_url of InvoiceMetadata' })
  recipient_view_url: string = undefined;

  @Field({ description: 'invoicer_view_url of InvoiceMetadata' })
  invoicer_view_url: string = undefined;
}
