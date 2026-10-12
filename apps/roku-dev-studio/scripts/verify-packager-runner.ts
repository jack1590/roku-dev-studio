/**
 * Pins the Packager runner against a fake roku-pkg: args, parsing, crash, cancel, duplicates, config writes.
 * Run with `npm run verify:packager-runner`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCli, inspectFolder, parseShellProbe, resetCliCache } from '../main/packager/cli.js';
import { readConfig, writeConfig, configPath } from '../main/packager/config-store.js';
import { startRun, cancelRun } from '../main/packager/runner.js';
import type { RunState } from '../shared/packager.js';

const fake = path.join(__dirname, 'fixtures', 'fake-roku-pkg.mjs');
const argsFile = path.join(os.tmpdir(), `fake-args-${process.pid}.json`);
const device = { key: 'dev1', name: 'Living Room', ip: '10.0.0.5', password: 'pw-secret' };

async function run(mode: string, project = 'My App "QA"'): Promise<{ final: RunState; updates: number }> {
  process.env.FAKE_MODE = mode;
  process.env.FAKE_ARGS_FILE = argsFile;
  const cli = await findCli({ override: fake });
  assert.ok(cli?.ok);
  return new Promise((resolve, reject) => {
    let updates = 0;
    const r = startRun({ cli: cli!, project, device, build: { kind: 'task', label: 'build:prod' }, killAfterMs: 300, onState: () => updates++, onExit: (final) => resolve({ final, updates }) });
    if (!r.ok) return reject(new Error(r.error));
    if (mode === 'hang' || mode === 'stubborn') setTimeout(() => cancelRun(r.runId), 300);
  });
}

async function main(): Promise<void> {
  fs.chmodSync(fake, 0o755);

  // Login-shell probe: rc files may print anything; only the marked values count.
  assert.deepEqual(parseShellProbe('Welcome!\nnvm loaded\n__RDS_BIN__/u/.nvm/bin/roku-pkg__RDS_BIN____RDS_PATH__/u/.nvm/bin:/usr/bin__RDS_PATH__\nbye'), { bin: '/u/.nvm/bin/roku-pkg', PATH: '/u/.nvm/bin:/usr/bin' });
  // Only PATH is needed now (the CLI is bundled); no roku-pkg on PATH is fine
  assert.deepEqual(parseShellProbe('__RDS_BIN____RDS_BIN____RDS_PATH__/usr/bin__RDS_PATH__'), { bin: undefined, PATH: '/usr/bin' });
  assert.equal(parseShellProbe('garbage'), null);

  // The bundled roku-pkg-cli runs on this process's own runtime: no global install needed
  resetCliCache();
  const bundled = await findCli();
  assert.ok(bundled?.ok, 'bundled CLI should be found and new enough');
  assert.equal(bundled!.path, process.execPath);
  assert.match(bundled!.args[0], /roku-pkg-cli[\\/]dist[\\/]index\.js$/);
  assert.equal(bundled!.env.ELECTRON_RUN_AS_NODE, '1');
  const realInspect = await inspectFolder(bundled!, os.tmpdir());
  assert.ok(realInspect.ok, 'bundled CLI runs `inspect`');

  // Version gate
  resetCliCache();
  process.env.FAKE_VERSION = '1.1.5';
  assert.equal((await findCli({ override: fake }))?.ok, false);
  process.env.FAKE_VERSION = '1.2.1';

  // Inspect
  const insp = await inspectFolder((await findCli({ override: fake }))!, '/a');
  assert.ok(insp.ok && insp.result.manifest?.title === 'CNBC');

  // Success: args exact (no shell), split lines joined, noise logged
  const ok = await run('ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), ['generate', 'My App "QA"', '--json', '--host', '10.0.0.5', '--password', 'pw-secret', '--build-task', 'build:prod']);
  assert.equal(ok.final.status, 'ok');
  assert.equal(ok.final.steps.home.state, 'done');
  assert.ok(ok.final.log.includes('plain noise'));
  assert.ok(!JSON.stringify(ok.final).includes('pw-secret'), 'run state must not contain the password');

  // Crash without result: UNKNOWN with stderr tail, failed step marked
  const crash = await run('crash');
  assert.equal(crash.final.status, 'failed');
  assert.equal(crash.final.result && !crash.final.result.ok && crash.final.result.code, 'UNKNOWN');
  assert.equal(crash.final.steps.deploy.state, 'failed');

  // A chatty build is batched: far fewer window updates than lines, and no line lost
  const flood = await run('flood');
  assert.equal(flood.final.status, 'ok');
  assert.ok(flood.final.log.includes('line 1499'));
  assert.ok(flood.updates < 40, `expected batched updates, got ${flood.updates}`);

  // A CLI that ignores SIGTERM is killed, so the device is released
  const stubborn = await run('stubborn');
  assert.equal(stubborn.final.status, 'cancelled');

  // Cancel
  const cancelled = await run('hang');
  assert.equal(cancelled.final.status, 'cancelled');

  // Duplicate run of the same project is refused
  process.env.FAKE_MODE = 'hang';
  const cli = (await findCli({ override: fake }))!;
  const done = new Promise<void>((resolve) => {
    const first = startRun({ cli, project: 'Dup', device, build: { kind: 'none' }, onState: () => {}, onExit: () => resolve() });
    const second = startRun({ cli, project: 'Dup', device: { ...device, key: 'dev2' }, build: { kind: 'none' }, onState: () => {}, onExit: () => {} });
    assert.ok(first.ok);
    assert.equal(second.ok, false);
    if (first.ok) setTimeout(() => cancelRun(first.runId), 200);
  });
  await done;

  // Config store: atomic, 0600, keeps unknown fields
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rpk-home-'));
  assert.deepEqual(readConfig(home).projects, []);
  writeConfig({ rokuDevice: { ip: '1.1.1.1', password: 'x', name: 'tv' }, projects: [{ name: 'A', rootDir: '/a', signKey: 'k', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg', files: ['x'] }], extraTop: true }, home);
  const back = readConfig(home);
  assert.equal(back.extraTop, true);
  assert.deepEqual(back.projects[0].files, ['x']);
  assert.equal(fs.statSync(configPath(home)).mode & 0o777, 0o600);
  // Corrupt JSON is never replaced with an empty config
  fs.writeFileSync(configPath(home), '{ not json');
  assert.throws(() => readConfig(home));

  console.log('verify-packager-runner: ok');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
