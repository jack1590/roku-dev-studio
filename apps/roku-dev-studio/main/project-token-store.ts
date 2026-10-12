/**
 * Per-project GitHub / JIRA / Figma tokens, encrypted with the OS keychain.
 *
 * Stored at `<userData>/secrets/project-tokens.json` as `{ "<projectId>:<service>": ciphertext }`.
 * Unlike the dev-password store there is no plaintext mode: when Electron reports that
 * encryption is unavailable, `setToken` refuses instead of writing readable tokens to disk.
 *
 * Only `hasToken` crosses IPC. `getToken` is for main-process callers (the review pipeline).
 * Token values are never logged.
 */

import type { App } from 'electron';
import type { ProjectTokenService } from '../shared/project-config';

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron') as typeof import('electron');

const FILE_VERSION = 1;
const DIR_NAME = 'secrets';
const FILE_NAME = 'project-tokens.json';

interface TokenFile {
  version: number;
  entries: Record<string, string>;
}

let filePath: string | null = null;

function entryKey(projectId: string, service: ProjectTokenService): string {
  return `${projectId}:${service}`;
}

function readFile(): TokenFile {
  if (!filePath || !fs.existsSync(filePath)) return { version: FILE_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<TokenFile>;
    return { version: FILE_VERSION, entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} };
  } catch {
    // A corrupt file must not crash the app; treat it as empty and overwrite on next write.
    return { version: FILE_VERSION, entries: {} };
  }
}

function writeFile(file: TokenFile): void {
  if (!filePath) throw new Error('project token store not initialized');
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function init(app: App): void {
  filePath = path.join(app.getPath('userData'), DIR_NAME, FILE_NAME);
}

export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function hasToken(projectId: string, service: ProjectTokenService): boolean {
  return Boolean(readFile().entries[entryKey(projectId, service)]);
}

/** Main-process only. Never pass the result over IPC. */
export function getToken(projectId: string, service: ProjectTokenService): string | null {
  const encoded = readFile().entries[entryKey(projectId, service)];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

export function setToken(projectId: string, service: ProjectTokenService, value: string): void {
  const token = value.trim();
  if (!token) throw new Error('Token is empty.');
  if (!isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable; token not saved.');
  const file = readFile();
  file.entries[entryKey(projectId, service)] = safeStorage.encryptString(token).toString('base64');
  writeFile(file);
}

export function clearToken(projectId: string, service: ProjectTokenService): void {
  const file = readFile();
  delete file.entries[entryKey(projectId, service)];
  writeFile(file);
}

/** Drop every token and secret of a project, e.g. when it is removed from the app. */
export function clearProject(projectId: string, _services?: readonly ProjectTokenService[]): void {
  const file = readFile();
  for (const key of Object.keys(file.entries)) if (key.startsWith(`${projectId}:`)) delete file.entries[key];
  writeFile(file);
}

// Named secrets beyond the four tokens (e.g. a repo's build env). Same encryption, same rules.
const secretKey = (projectId: string, name: string) => `${projectId}:secret:${name}`;

export function setSecret(projectId: string, name: string, value: string): void {
  if (!isEncryptionAvailable()) throw new Error('OS keychain encryption is unavailable; not saved.');
  const file = readFile();
  file.entries[secretKey(projectId, name)] = safeStorage.encryptString(value).toString('base64');
  writeFile(file);
}

/** Main-process only. Never pass the result over IPC. */
export function getSecret(projectId: string, name: string): string | null {
  const encoded = readFile().entries[secretKey(projectId, name)];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

export function clearSecret(projectId: string, name: string): void {
  const file = readFile();
  delete file.entries[secretKey(projectId, name)];
  writeFile(file);
}
