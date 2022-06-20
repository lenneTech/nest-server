import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { createWriteStream } from 'fs';
import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import type { FileUpload } from 'graphql-upload/processRequest.js';
import { Roles } from '../../../core/common/decorators/roles.decorator';
import { RoleEnum } from '../../../core/common/enums/role.enum';

/**
 * File resolver
 */
@Resolver()
export class FileResolver {
  /**
   * Upload file
   */
  @Roles(RoleEnum.ADMIN)
  @Mutation(() => Boolean)
  async uploadFile(
    @Args({ name: 'file', type: () => GraphQLUpload })
    file: FileUpload
  ) {
    const { filename, mimetype, encoding, createReadStream } = file;
    console.log('file', filename, mimetype, encoding);
    await new Promise((resolve, reject) =>
      createReadStream()
        .pipe(createWriteStream(`./uploads/${filename}`))
        .on('finish', () => resolve(true))
        .on('error', (error) => reject(error))
    );
    return true;
  }

  /**
   * Upload files
   */
  @Roles(RoleEnum.ADMIN)
  @Mutation(() => Boolean)
  async uploadFiles(
    @Args({ name: 'files', type: () => [GraphQLUpload] })
    files: FileUpload[]
  ) {
    const promises: Promise<any>[] = [];
    for (const file of files) {
      const { filename, mimetype, encoding, createReadStream } = await file;
      console.log('file', filename, mimetype, encoding);
      promises.push(
        new Promise((resolve, reject) =>
          createReadStream()
            .pipe(createWriteStream(`./uploads/${filename}`))
            .on('finish', () => resolve(true))
            .on('error', (error) => reject(error))
        )
      );
    }
    await Promise.allSettled(promises);
    return true;
  }
}
