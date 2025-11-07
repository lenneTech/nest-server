/**
 * TypeScript compiler for migrate CLI
 *
 * This file registers ts-node to allow TypeScript migrations to be executed.
 *
 * Usage with migrate CLI:
 * migrate --compiler="ts:./node_modules/@lenne.tech/nest-server/dist/core/modules/migrate/helpers/ts-compiler.js"
 *
 * Or copy this file to your project's migrations-utils folder.
 */

const tsNode = require('ts-node');

module.exports = tsNode.register;
