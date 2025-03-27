import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';

import { Restricted } from '../../../core/common/decorators/restricted.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';
import { CoreFileInfo } from '../../../core/modules/file/core-file-info.model';

/**
 * File info model
 */
@MongooseSchema({ collection: 'fs.files' })
@ObjectType({ description: 'Information about file' })
@Restricted(RoleEnum.ADMIN)
export class FileInfo extends CoreFileInfo {}

/**
 * File info schema
 */
export const FileInfoSchema = SchemaFactory.createForClass(FileInfo);
