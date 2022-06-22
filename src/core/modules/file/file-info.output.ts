import { Field, ObjectType } from '@nestjs/graphql';
import { Types } from 'mongoose';
import { CoreModel } from '../../common/models/core-model.model';

/**
 * File info (output)
 */
@ObjectType({ description: 'Information about attachment file' })
export class FileInfo extends CoreModel {
  _id: Types.ObjectId;

  @Field(() => String, { description: 'ID of the file in bytes' })
  id: string = undefined;

  @Field(() => Number, { description: 'Length of the file in bytes', nullable: true })
  length: number = undefined;

  @Field(() => Number, { description: 'Size of the chunk', nullable: true })
  chunkSize: number = undefined;

  @Field(() => String, { description: 'Name of the file', nullable: true })
  filename?: string = undefined;

  @Field(() => String, { description: 'Content type', nullable: true })
  contentType?: string = undefined;
}
