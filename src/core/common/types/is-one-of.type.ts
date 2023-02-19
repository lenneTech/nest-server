/**
 * Type that ensures that the property or method is of a specific class
 *
 * Example (see https://stackoverflow.com/a/66202968):
 *
 * interface myFunctions{
 *     one: () => number;
 *     two: () => number;
 *     echo: (str: string) => string;
 * }
 *
 * const myFunctions: myFunctions = {
 *     one: () => 1,
 *     two: () => 2,
 *     echo: (str: string) => str
 * }
 *
 * const wrapper = <U extends (...args: any[]) => any>(func: U extends IsOneOf<myFunctions, U> ? U : never) => (...args: Parameters<U>) : ReturnType<U> => func(...args);
 *
 * const one = wrapper(myFunctions.one);
 * const two = wrapper(myFunctions.two);
 * const echo = wrapper(myFunctions.echo);
 * const rand = wrapper((a:string,b:number,c:boolean) => {}); //not assignable to parameter of type 'never'.
 * const hm = wrapper(() => 'a'); //also error
 */
export type IsOneOf<T, F> = { [P in keyof T]: F extends T[P] ? (T[P] extends F ? T[P] : never) : never }[keyof T];
