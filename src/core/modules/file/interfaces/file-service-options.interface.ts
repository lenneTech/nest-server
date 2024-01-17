/**
 * Interface for service options in file services
 */
export interface FileServiceOptions {
  currentUser?: { hasRole: (roles: string[]) => boolean; id: any };
  force?: boolean;
  roles?: string | string[];
}
