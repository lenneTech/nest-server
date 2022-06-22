/**
 * Interface for service options in file services
 */
export interface FileServiceOptions {
  currentUser?: { id: any; hasRole: (roles: string[]) => boolean };
  roles?: string | string[];
}
