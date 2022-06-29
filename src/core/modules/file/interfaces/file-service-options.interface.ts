/**
 * Interface for service options in file services
 */
export interface FileServiceOptions {
  currentUser?: { id: any; hasRole: (roles: string[]) => boolean };
  force?: boolean;
  roles?: string | string[];
}
