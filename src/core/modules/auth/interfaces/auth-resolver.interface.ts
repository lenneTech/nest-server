/**
 * Interface for authorization resolver
 */
export interface IAuthResolver {
  signIn(email: string, password: string, ...params: any[]): any;
}
