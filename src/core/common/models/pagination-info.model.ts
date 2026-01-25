import { ObjectType } from '@nestjs/graphql';

import { UnifiedField } from '../decorators/unified-field.decorator';

/**
 * Pagination information for paginated queries
 *
 * Provides metadata about the current page, total pages, and navigation flags
 * to facilitate frontend pagination UI implementation.
 */
@ObjectType({ description: 'Pagination information for paginated queries' })
export class PaginationInfo {
  /**
   * Total number of items across all pages
   */
  @UnifiedField({
    description: 'Total number of items across all pages',
  })
  totalCount: number;

  /**
   * Total number of pages
   */
  @UnifiedField({
    description: 'Total number of pages',
  })
  pageCount: number;

  /**
   * Current page number (1-based)
   */
  @UnifiedField({
    description: 'Current page number (1-based)',
  })
  currentPage: number;

  /**
   * Number of items per page
   */
  @UnifiedField({
    description: 'Number of items per page',
  })
  perPage: number;

  /**
   * Indicates if there is a next page
   */
  @UnifiedField({
    description: 'Indicates if there is a next page',
  })
  hasNextPage: boolean;

  /**
   * Indicates if there is a previous page
   */
  @UnifiedField({
    description: 'Indicates if there is a previous page',
  })
  hasPreviousPage: boolean;

  /**
   * Create PaginationInfo from query parameters and total count
   */
  static create(options: {
    limit?: number;
    offset?: number;
    skip?: number;
    take?: number;
    totalCount: number;
  }): PaginationInfo {
    const { totalCount } = options;
    const skip = options.skip ?? options.offset ?? 0;
    const perPage = options.take ?? options.limit ?? 0;

    // Handle edge case: no limit specified (return all items as single page)
    if (perPage === 0) {
      return {
        currentPage: totalCount > 0 ? 1 : 0,
        hasNextPage: false,
        hasPreviousPage: false,
        pageCount: totalCount > 0 ? 1 : 0,
        perPage: 0,
        totalCount,
      };
    }

    const pageCount = Math.ceil(totalCount / perPage);
    const currentPage = totalCount === 0 ? 0 : Math.floor(skip / perPage) + 1;
    const hasNextPage = currentPage < pageCount;
    const hasPreviousPage = currentPage > 1;

    return {
      currentPage,
      hasNextPage,
      hasPreviousPage,
      pageCount,
      perPage,
      totalCount,
    };
  }
}
