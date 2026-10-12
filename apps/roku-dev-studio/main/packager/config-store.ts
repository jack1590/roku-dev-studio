/** roku-pkg's own config (~/.roku-pkg/config.json). Shared with the terminal CLI; we keep fields we don't know. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliProject } from '../../shared/packager';

export interface CliConfig {
  rokuDevice: { ip: string; password: string; name?: string; [k: string]: unknown };
  projects: CliProject[];
  [k: string]: unknown;
}

export const configPath = (home = os.homedir()) => path.join(home, '.roku-pkg', 'config.json');

export function readConfig(home?: string): CliConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf8')) as Partial<CliConfig>;
    return { ...parsed, rokuDevice: parsed.rokuDevice ?? { ip: '', password: '' }, projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rokuDevice: { ip: '', password: '' }, projects: [] };
    throw err; // corrupt JSON: never overwrite the user's file with an empty one
  }
}

/** Temp file + rename so a crash never leaves half a config; owner-only (it holds sign keys). */
export function writeConfig(cfg: CliConfig, home?: string): void {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
