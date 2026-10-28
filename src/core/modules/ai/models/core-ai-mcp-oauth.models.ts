import { Schema } from 'mongoose';

import { AI_MCP_OAUTH_CODE_TTL_SECONDS } from '../core-ai.constants.js';

/**
 * The MCP OAuth artifacts as models — what gives them their tables on a SQL source (db-agnostic phase 4).
 *
 * On MongoDB `CoreAiMcpOAuthService` keeps reading and writing the three collections natively, as before: these
 * schemas only register the names, with `autoIndex: false` so Mongoose never creates an index next to the TTL and
 * unique indexes the service ensures itself. On a SQL source the framework creates the tables from them, the service
 * goes through their stores, and the declared TTL makes the expiry sweep remove old codes.
 */

/** A registered client: the client object the MCP SDK hands over, kept whole, plus its id for the lookup */
export const AiMcpOAuthClientSchema = new Schema(
  {
    client: { type: Schema.Types.Mixed },
    client_id: { index: { unique: true }, type: String },
    createdAt: { type: Date },
  },
  { autoIndex: false, collection: 'aiMcpOAuthClients', versionKey: false },
);

/** An authorization code with its PKCE challenge; valid for `AI_MCP_OAUTH_CODE_TTL_SECONDS` after `createdAt` */
export const AiMcpOAuthCodeSchema = new Schema(
  {
    clientId: { type: String },
    code: { index: { unique: true }, type: String },
    codeChallenge: { type: String },
    // The TTL: MongoDB gets its index from the service, a SQL table its sweep (`CorePersistenceLifecycle`)
    createdAt: { expires: AI_MCP_OAUTH_CODE_TTL_SECONDS, type: Date },
    userId: { type: String },
  },
  { autoIndex: false, collection: 'aiMcpOAuthCodes', versionKey: false },
);

/** A refresh token, bound to the client it was issued to */
export const AiMcpOAuthRefreshTokenSchema = new Schema(
  {
    clientId: { type: String },
    createdAt: { type: Date },
    token: { index: { unique: true }, type: String },
    userId: { type: String },
  },
  { autoIndex: false, collection: 'aiMcpOAuthRefreshTokens', versionKey: false },
);
