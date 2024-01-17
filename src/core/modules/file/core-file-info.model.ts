import { Field, ObjectType } from '@nestjs/graphql';
import { Prop } from '@nestjs/mongoose';
import { Types } from 'mongoose';

import { CoreModel } from '../../common/models/core-model.model';

/**
 * File info
 */
@ObjectType({ description: 'Information about file' })
export class CoreFileInfo extends CoreModel {
  // ===========================================================================
  // Getter
  // ===========================================================================

  get _id() {
    return new Types.ObjectId(this.id);
  }

  // ===========================================================================
  // Properties
  // ===========================================================================

  @Field(() => String, { description: 'ID of the file' })
  id: string = undefined;

  @Field(() => Number, {
    description:
      'The size of each chunk in bytes. GridFS divides the document into chunks of size chunkSize, '
      + 'except for the last, which is only as large as needed. The default size is 255 kilobytes (kB)',
    nullable: true,
  })
  @Prop({ required: false, type: Number })
  chunkSize: number = undefined;

  @Field(() => String, { description: 'Content type', nullable: true })
  @Prop({ required: false, type: String })
  contentType?: string = undefined;

  @Field(() => String, { description: 'Name of the file', nullable: true })
  @Prop({ required: false, type: String })
  filename?: string = undefined;

  @Field(() => Number, { description: 'The size of the document in bytes', nullable: true })
  @Prop({ required: false, type: Number })
  length: number = undefined;

  @Field(() => Date, { description: 'The date the file was first stored', nullable: true })
  @Prop({ required: false, type: Date })
  uploadDate: Date = undefined;
}
