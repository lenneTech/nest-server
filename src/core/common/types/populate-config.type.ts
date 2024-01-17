import { PopulateOptions } from 'mongoose';

/**
 * Configuration (path or options) for Mongoose populate methode
 */
export type PopulateConfig = (PopulateOptions | string)[] | PopulateOptions | string | string[];
