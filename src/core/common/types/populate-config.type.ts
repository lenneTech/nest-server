import { PopulateOptions } from 'mongoose';

/**
 * Configuration (path or options) for Mongoose populate methode
 */
export type PopulateConfig = string | string[] | PopulateOptions | (PopulateOptions | string)[];
