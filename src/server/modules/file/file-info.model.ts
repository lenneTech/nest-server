import { ObjectType } from '@nestjs/graphql';
import { Schema as MongooseSchema, SchemaFactory } from '@nestjs/mongoose';

import { CoreFileInfo } from '../../../core/modules/file/core-file-info.model';

/**
 * File info model
 */
@ObjectType({ description: 'Information about file' })
@MongooseSchema({ collection: 'fs.files' })
export class FileInfo extends CoreFileInfo {}

/**
 * File info schema
 */
export const FileInfoSchema = SchemaFactory.createForClass(FileInfo);
