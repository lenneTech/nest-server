import { ObjectType } from '@nestjs/graphql';
import { Types } from 'mongoose';

import { Restricted } from '../../common/decorators/restricted.decorator';
import { UnifiedField } from '../../common/decorators/unified-field.decorator';
import { RoleEnum } from '../../common/enums/role.enum';
import { CoreModel } from '../../common/models/core-model.model';

/**
 * File info
 */
@ObjectType({ description: 'Information about file' })
@Restricted(RoleEnum.S_EVERYONE)
export class CoreFileInfo extends CoreModel {
  // ===========================================================================
  // Getter
  // ===========================================================================

  @Restricted(RoleEnum.S_EVERYONE)
  get _id() {
    return new Types.ObjectId(this.id);
  }

  // ===========================================================================
  // Properties
  // ===========================================================================

  @UnifiedField({
    description: 'ID of the file',
    roles: RoleEnum.S_EVERYONE,
    type: () => String,
  })
  id: string = undefined;

  @UnifiedField({
    description:
      'The size of each chunk in bytes. GridFS divides the document into chunks of size chunkSize, ' +
      'except for the last, which is only as large as needed. The default size is 255 kilobytes (kB)',
    isOptional: true,
    mongoose: { required: false, type: Number },
    roles: RoleEnum.S_EVERYONE,
    type: () => Number,
  })
  chunkSize: number = undefined;

  @UnifiedField({
    description: 'Content type',
    isOptional: true,
    mongoose: { required: false, type: String },
    roles: RoleEnum.S_EVERYONE,
  })
  contentType?: string = undefined;

  @UnifiedField({
    description: 'Name of the file',
    isOptional: true,
    mongoose: { required: false, type: String },
    roles: RoleEnum.S_EVERYONE,
  })
  filename?: string = undefined;

  @UnifiedField({
    description: 'The size of the document in bytes',
    isOptional: true,
    mongoose: { required: false, type: Number },
    roles: RoleEnum.S_EVERYONE,
    type: () => Number,
  })
  length: number = undefined;

  @UnifiedField({
    description: 'The date the file was first stored',
    isOptional: true,
    mongoose: { required: false, type: Date },
    roles: RoleEnum.S_EVERYONE,
    type: () => Date,
  })
  uploadDate: Date = undefined;
}
