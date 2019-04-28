import { IAuthUser } from '../../modules/auth/interfaces/auth-user.interface';

/**
 * Interface for PersistenceModel
 */
export interface IPersistenceModel {

  // ===========================================================================
  // Properties
  //
  // TestFields: https://typegraphql.ml/docs/types-and-fields.html
  // ===========================================================================

  /**
   * ID of the persistence object
   */
  id: string;

  /**
   * Created date
   */
  createdAt: Date;

  /**
   * User who created the object
   *
   * Not set when created by system
   */
  createdBy?: IAuthUser;

  /**
   * IDs of the Owners
   */
  ownerIds: string[];

  /**
   * Updated date
   */
  updatedAt: Date;

  /**
   * User who last updated the object
   *
   * Not set when updated by system
   */
  updatedBy?: IAuthUser;

  // ===========================================================================
  // TypeORM Entity Listeners
  //
  // https://typeorm.io/#/listeners-and-subscribers
  // ===========================================================================

  /**
   * Manipulation before insert a new entity
   */
  beforeInsert(): void;

  /**
   * Manipulation before update an existing entity
   */
  beforeUpdate(): void;
}
