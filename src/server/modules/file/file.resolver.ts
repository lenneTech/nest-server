import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { createWriteStream } from 'fs';
import * as GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import type { FileUpload } from 'graphql-upload/processRequest.js';

/**
 * File resolver
 */
@Resolver()
export class FileResolver {
  /**
   * Upload file
   */
  @Mutation(() => Boolean)
  async uploadFile(
    @Args({ name: 'file', type: () => GraphQLUpload })
    file: FileUpload
  ) {
    console.log(JSON.stringify(file, null, 2));
    /*
    const {filename, mimetype, encoding, createReadStream} = file;
    await new Promise((resolve, reject) =>
      createReadStream()
        .pipe(createWriteStream(`./uploads/${filename}`))
        .on('finish', () => resolve(true))
        .on('error', (error) => reject(error))
    );
    */
    return true;
  }

  /**
   * Upload files
   */
  @Mutation(() => Boolean)
  async uploadFiles(
    @Args({ name: 'files', type: () => [GraphQLUpload] })
    files: FileUpload[]
  ) {
    const promises: Promise<any>[] = [];
    for (const file of files) {
      console.log(JSON.stringify(await file, null, 2));
      /*
      const {filename, mimetype, encoding, createReadStream} = await file
      promises.push(new Promise((resolve, reject) =>
        createReadStream()
          .pipe(createWriteStream(`./uploads/${filename}`))
          .on('finish', () => resolve(true))
          .on('error', (error) => reject(error))
      ));
      */
    }
    await Promise.all(promises);
    return true;
  }
}
