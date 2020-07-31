import { Field, ObjectType } from '@nestjs/graphql';
import { CoreEditorModel } from '../../../core/common/models/core-editor.model';

/**
 * Editor model
 */
@ObjectType({ description: 'Editor' })
export class Editor extends CoreEditorModel {
  /**
   * URL to avatar file of the user
   */
  @Field({ description: 'URL to avatar file of the editor', nullable: true })
  avatar: string = undefined;
}
