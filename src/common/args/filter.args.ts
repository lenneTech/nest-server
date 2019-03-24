import { ArgsType, Field } from 'type-graphql/dist';
import { IsOptional } from 'class-validator';
import { JSON } from '../scalars/json.scalar';
import { FindManyOptions } from 'typeorm';

@ArgsType()
export class FilterArgs {

  /**
   * Limit for pagination
   */
  @Field(type => JSON, {
    description: '[Find options of TypeORM](https://typeorm.io/#/find-options)',
    nullable: true,
  })
  @IsOptional()
  filter?: FindManyOptions;
}
