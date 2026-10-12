/**
 * Works out how a Roku repo is built, from its own files. Pure: the caller supplies a reader
 * (GitHub contents API on the base branch, or a checkout), so detection never runs repo code.
 *
 * Order: VS Code launch config (what developers actually run) → package.json scripts →
 * bsconfig.json → a plain channel with `manifest` at the root.
 */

export interface DetectedBuild {
  command: string;
  outDir: string;
  install: string;
  detectedFrom: string;
  /** Test channel build for device checks, when the repo has one (the first of testOptions). */
  testCommand?: string;
  testOutDir?: string;
  /** Every test build found, for the user to pick from. */
  testOptions?: TestBuildOption[];
}

/** A test channel build found in the repo. */
export interface TestBuildOption {
  command: string;
  outDir: string;
  /** Where it was found, for display ("package.json script build-all-tests"). */
  from: string;
}

type Reader = (path: string) => Promise<string | null>;

/** JSON with comments and trailing commas, as VS Code writes it. */
export function parseJsonc<T = unknown>(text: string): T | null {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as T;
  } catch {
    return null;
  }
}

const stripWorkspace = (p: string) => p.replace(/^\$\{workspaceFolder\}\/?/, '').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';

const BUILD_SCRIPT_NAMES = ['build', 'generate-code', 'build:dev', 'package', 'bundle'];

async function installFor(read: Reader): Promise<string> {
  if (await read('package-lock.json')) return 'npm ci';
  if (await read('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (await read('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (await read('package.json')) return 'npm install';
  return '';
}

/** Script names that build a test channel, compile-only first. Project-agnostic guesses; the user can edit. */
const TEST_SCRIPT_NAMES = ['test:build', 'build:test', 'build:tests', 'build-tests', 'build-all-tests', 'test:compile', 'test:device', 'test:roku'];
/** Scripts that deploy or run tests themselves are not builds: the app sideloads and reads results. */
const DEPLOYS = /roku-deploy|--deploy\b|stream-telnet|capture-coverage|\bunzip\b/;

async function stagingOf(read: Reader, bsconfig: string): Promise<string> {
  const cfg = parseJsonc<{ stagingDir?: string; stagingFolderPath?: string }>((await read(bsconfig)) ?? '');
  const dir = cfg?.stagingDir || cfg?.stagingFolderPath;
  return dir ? stripWorkspace(dir) : '';
}

/**
 * Every test channel build the repo has, best first: package.json scripts that compile a test
 * bsconfig (or carry a test-build name), then VS Code launch configs named like tests. A repo can
 * have several (all tests, app tests, refactor tests…); the user picks one.
 */
async function detectTests(read: Reader): Promise<TestBuildOption[]> {
  const options: TestBuildOption[] = [];
  const add = (o: TestBuildOption) => {
    if (o.command && !options.some((x) => x.command === o.command)) options.push(o);
  };
  const pkg = parseJsonc<{ scripts?: Record<string, string> }>((await read('package.json')) ?? '');
  const scripts = Object.entries(pkg?.scripts ?? {});
  const fromScript = async (name: string, cmd: string): Promise<TestBuildOption | null> => {
    if (DEPLOYS.test(cmd)) return null;
    const project = /--project\s+["']?([^\s"']+\.json)/.exec(cmd)?.[1];
    if (project && (/test/i.test(project) || /test/i.test(name))) return { command: `npm run ${name}`, outDir: await stagingOf(read, stripWorkspace(project)), from: `package.json script "${name}" (${stripWorkspace(project)})` };
    if (!TEST_SCRIPT_NAMES.includes(name)) return null;
    for (const file of ['bsconfig.test.json', 'bsconfig.tests.json', 'bsconfig-test.json']) {
      const dir = await stagingOf(read, file);
      if (dir) return { command: `npm run ${name}`, outDir: dir, from: `package.json script "${name}"` };
    }
    // A script like "ts-node scripts/tests/build.ts": look for a staging folder named in that file.
    const scriptFile = /([\w./-]+\.(?:ts|js|mjs|cjs))/.exec(cmd)?.[1];
    const source = scriptFile ? await read(scriptFile) : null;
    const named = source ? /["'`]((?:\.\/)?[\w./-]*staging[\w./-]*)["'`]/.exec(source)?.[1] : undefined;
    return { command: `npm run ${name}`, outDir: named ? stripWorkspace(named) : '', from: `package.json script "${name}"` };
  };
  // The main test bsconfig first, then the other script matches in package.json order.
  const ranked = [...scripts].sort(([, a], [, b]) => Number(/bsconfig\.tests?\.json/.test(b)) - Number(/bsconfig\.tests?\.json/.test(a)));
  for (const [name, cmd] of ranked) {
    const option = await fromScript(name, cmd);
    if (option) add(option);
  }

  const launch = parseJsonc<{ configurations?: { name?: string; type?: string; rootDir?: string; preLaunchTask?: string }[] }>((await read('.vscode/launch.json')) ?? '');
  const tasks = parseJsonc<{ tasks?: { label?: string; type?: string; script?: string; command?: string; args?: string[] }[] }>((await read('.vscode/tasks.json')) ?? '');
  for (const c of launch?.configurations ?? []) {
    if (c.type !== 'brightscript' || !/test/i.test(c.name ?? '') || !c.preLaunchTask || !c.rootDir) continue;
    const task = tasks?.tasks?.find((t) => t.label === c.preLaunchTask);
    const command = task?.type === 'npm' && task.script ? `npm run ${task.script}` : task?.command ? [task.command, ...(task.args ?? [])].join(' ') : '';
    if (command && !DEPLOYS.test(command)) add({ command, outDir: stripWorkspace(c.rootDir), from: `.vscode/launch.json "${c.name}"` });
  }
  return options;
}

export async function detectBuild(read: Reader): Promise<DetectedBuild | null> {
  const found = await detectApp(read);
  if (!found) return null;
  const tests = await detectTests(read);
  return tests.length ? { ...found, testCommand: tests[0].command, testOutDir: tests[0].outDir, testOptions: tests } : found;
}

/**
 * Folders of a repo that look like a Roku project (a manifest, bsconfig.json or package.json),
 * shallowest first, from a list of the repo's file paths. '' is the repo root. Pure.
 */
export function projectFolders(paths: string[]): string[] {
  const found = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    const name = parts.pop() ?? '';
    if (!['manifest', 'bsconfig.json', 'package.json'].includes(name)) continue;
    if (parts.length > 3 || parts.some((x) => x === 'node_modules' || x.startsWith('.') || /^(dist|build|out|tests?|specs?|docs?)$/i.test(x))) continue;
    found.add(parts.join('/'));
  }
  return [...found].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 15);
}

async function detectApp(read: Reader): Promise<DetectedBuild | null> {
  const install = await installFor(read);

  // 1. .vscode/launch.json → brightscript config → preLaunchTask → tasks.json
  const launch = parseJsonc<{ configurations?: { type?: string; rootDir?: string; preLaunchTask?: string }[] }>((await read('.vscode/launch.json')) ?? '');
  const config = launch?.configurations?.find((c) => c.type === 'brightscript');
  if (config) {
    const outDir = config.rootDir ? stripWorkspace(config.rootDir) : '.';
    let command = '';
    if (config.preLaunchTask) {
      const tasks = parseJsonc<{ tasks?: { label?: string; type?: string; script?: string; command?: string; args?: string[] }[] }>((await read('.vscode/tasks.json')) ?? '');
      const task = tasks?.tasks?.find((t) => t.label === config.preLaunchTask) ?? tasks?.tasks?.find((t) => t.type === 'npm' && `npm: ${t.script}` === config.preLaunchTask);
      if (task?.type === 'npm' && task.script) command = `npm run ${task.script}`;
      else if (task?.command) command = [task.command, ...(task.args ?? [])].join(' ');
      else if (config.preLaunchTask.startsWith('npm:')) command = `npm run ${config.preLaunchTask.slice(4).trim()}`;
    }
    return { command, outDir, install, detectedFrom: `.vscode/launch.json${config.preLaunchTask ? ` (preLaunchTask "${config.preLaunchTask}")` : ''}` };
  }

  // 2. package.json build script; output from bsconfig.json
  const bsconfig = parseJsonc<{ stagingDir?: string; stagingFolderPath?: string; outDir?: string; rootDir?: string }>((await read('bsconfig.json')) ?? '');
  const bsOut = bsconfig ? stripWorkspace(bsconfig.stagingDir || bsconfig.stagingFolderPath || 'out/.roku-deploy-staging') : null;
  const pkg = parseJsonc<{ scripts?: Record<string, string> }>((await read('package.json')) ?? '');
  const script = BUILD_SCRIPT_NAMES.find((name) => pkg?.scripts?.[name]);
  if (script) return { command: `npm run ${script}`, outDir: bsOut ?? 'dist', install, detectedFrom: `package.json script "${script}"` };

  // 3. BrighterScript without a script
  if (bsconfig && bsOut) return { command: 'npx bsc', outDir: bsOut, install, detectedFrom: 'bsconfig.json' };

  // 4. Plain channel: zip the repo root
  if (await read('manifest')) return { command: '', outDir: '.', install: '', detectedFrom: 'manifest at the repo root (no build step)' };
  return null;
}
