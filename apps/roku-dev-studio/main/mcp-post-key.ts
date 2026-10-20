/**
 * Posting key for the MCP review tools. `review_post` writes to GitHub, so on top of the bridge
 * token it needs this key, which the user gives only to the MCP clients that may post (as
 * `RDS_POST_KEY` in that client's MCP config). No key set: posting from MCP is off.
 *
 * Stored like project tokens (OS keychain via safeStorage). Main-process only: the key goes to the
 * Settings window once, right after it is generated, and is never logged or sent over the bridge.
 */

import { randomBytes } from 'crypto';
import * as tokenStore from './project-token-store';

const OWNER = '__app__';
const NAME = 'mcp-post-key';

export function getPostKey(): string | null {
  return tokenStore.getSecret(OWNER, NAME);
}

export function hasPostKey(): boolean {
  return !!getPostKey();
}

/** A new key; replaces any old one, so clients holding the old key can no longer post. */
export function generatePostKey(): string {
  const key = randomBytes(32).toString('base64url');
  tokenStore.setSecret(OWNER, NAME, key);
  return key;
}

export function clearPostKey(): void {
  tokenStore.clearSecret(OWNER, NAME);
}
