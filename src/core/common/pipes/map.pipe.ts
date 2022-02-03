import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';

@Injectable()
export class MapPipe implements PipeTransform {
  transform(value: any, metadata: ArgumentMetadata) {
    let result = value;

    // Check map function is available
    if ((metadata.metatype as any)?.map) {
      // Map object to correct type
      result = (metadata.metatype as any).map(value);
    }

    return result;
  }
}
