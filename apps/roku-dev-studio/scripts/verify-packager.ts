/**
 * Pins the Packager's pure logic: NDJSON parsing, the run reducer, project masking and save rules.
 * Run with `npm run verify:packager`.
 */
import assert from 'node:assert/strict';
import { MIN_CLI_VERSION, historyLabel, appendHistory, applyEvent, buildArgs, compareVersions, createLineSplitter, finishWithoutResult, fixFor, historyEntry, initialRunState, mergeProjectSave, parseEventLine, toView, validateSave, LOG_CAP, HISTORY_PER_PROJECT, type CliProject, type HistoryEntry } from '../shared/packager.js';

// Versions
assert.ok(compareVersions('1.2.0', MIN_CLI_VERSION) < 0, '1.2.0 lacks KEY_MISMATCH and absolute paths');
assert.equal(compareVersions('1.2.1', MIN_CLI_VERSION), 0);
assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
assert.ok(compareVersions('1.10.0', '1.2.0') > 0);
assert.ok(compareVersions('1.1.5', '1.2.0') < 0);

// Lines split across chunks; noise is kept as plain lines
const lines: string[] = [];
const split = createLineSplitter((l) => lines.push(l));
split.push('{"type":"step","st');
split.push('ep":"home","status":"start"}\nnoise from roku-deploy\r\n{"type":"log"');
split.push(',"level":"info","text":"x"}');
split.end();
assert.deepEqual(lines, ['{"type":"step","step":"home","status":"start"}', 'noise from roku-deploy', '{"type":"log","level":"info","text":"x"}']);
assert.deepEqual(parseEventLine(lines[0]), { type: 'step', step: 'home', status: 'start' });
assert.equal(parseEventLine('noise from roku-deploy'), null);
assert.equal(parseEventLine('{"type":"step","step":"bogus","status":"start"}'), null);
assert.equal(parseEventLine('[1,2]'), null);

// Reducer: success
let s = initialRunState('r1', 'CNBC', 'Living Room', 1000);
s = applyEvent(s, { type: 'step', step: 'home', status: 'start' }, 1001);
assert.equal(s.current, 'home');
assert.equal(s.steps.home.state, 'running');
s = applyEvent(s, { type: 'step', step: 'home', status: 'done', ms: 5 }, 1006);
s = applyEvent(s, { type: 'step', step: 'build', status: 'skip', detail: 'used existing build' }, 1007);
assert.equal(s.steps.build.state, 'skipped');
s = applyEvent(s, { type: 'log', level: 'info', text: 'hello' }, 1008);
assert.deepEqual(s.log, ['hello']);
s = applyEvent(s, { type: 'result', ok: true, packagePath: '/out/CNBC.pkg', sizeBytes: 10, version: '4.12.0' }, 2000);
assert.equal(s.status, 'ok');
assert.equal(s.endedAt, 2000);

// Reducer: failure marks the step; log is capped
let f = initialRunState('r2', 'gotham', 'Dev', 0);
for (let i = 0; i < LOG_CAP + 5; i++) f = applyEvent(f, { type: 'log', level: 'info', text: String(i) }, 1);
assert.equal(f.log.length, LOG_CAP);
assert.equal(f.log[0], '5');
f = applyEvent(f, { type: 'step', step: 'rekey', status: 'fail' }, 2);
f = applyEvent(f, { type: 'result', ok: false, step: 'rekey', code: 'REKEY_FAILED', message: 'bad key' }, 3);
assert.equal(f.status, 'failed');
assert.equal(f.steps.rekey.state, 'failed');
assert.equal(fixFor('REKEY_FAILED'), 'edit-signing');
assert.equal(fixFor('AUTH_FAILED'), 'device');
assert.equal(fixFor('BUILD_FAILED'), 'log');
assert.equal(fixFor('DEPLOY_FAILED'), 'retry');
assert.equal(fixFor('KEY_MISMATCH'), 'rekey');

// Exit without result
let u = applyEvent(initialRunState('r3', 'x', 'd', 0), { type: 'step', step: 'deploy', status: 'start' }, 1);
u = finishWithoutResult(u, ['Segmentation fault'], 9, false);
assert.equal(u.status, 'failed');
assert.equal(u.result && !u.result.ok && u.result.code, 'UNKNOWN');
assert.equal(u.steps.deploy.state, 'failed');
assert.match(u.result && !u.result.ok ? u.result.message : '', /Segmentation fault/);
const c = finishWithoutResult(initialRunState('r4', 'x', 'd', 0), [], 1, true);
assert.equal(c.status, 'cancelled');

// Masking
const cli: CliProject = { name: 'CNBC', rootDir: '/a', signKey: 'SECRET', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg', extra: 1 };
const view = toView(cli);
assert.equal(view.hasSignKey, true);
assert.ok(!JSON.stringify(view).includes('SECRET'));

// Save validation
assert.equal(validateSave({ name: '', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }, []).ok, false);
assert.equal(validateSave({ name: 'CNBC', rootDir: 'rel', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }, []).ok, false);
assert.equal(validateSave({ name: 'CNBC', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.txt' }, []).ok, false);
assert.equal(validateSave({ name: 'CNBC', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }, ['CNBC']).ok, false);
assert.equal(validateSave({ originalName: 'CNBC', name: 'CNBC', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }, ['CNBC']).ok, true);
assert.equal(validateSave({ name: 'My App "QA"', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }, []).ok, true);

// The output must never overwrite the signed package used for rekeying
assert.equal(validateSave({ name: 'G', rootDir: '/a', signPackageLocation: '/keys/g.pkg', outputLocation: '/keys/g.pkg' }, []).ok, false);

// Build output colour codes are stripped from the log
let colored = initialRunState('rc', 'x', 'd', 0);
colored = applyEvent(colored, { type: 'log', level: 'info', text: '\u001b[90m08:41:40 AM\u001b[39m Copying' }, 1);
assert.deepEqual(colored.log, ['08:41:40 AM Copying']);

// Edit with empty key keeps the saved key and unknown fields; add without a key fails
const kept = mergeProjectSave(cli, { originalName: 'CNBC', name: 'CNBC', rootDir: '/b', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg', signKey: '' });
assert.ok(kept.ok && kept.project.signKey === 'SECRET' && kept.project.rootDir === '/b' && kept.project.extra === 1);
const replaced = mergeProjectSave(cli, { originalName: 'CNBC', name: 'CNBC', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg', signKey: 'NEW' });
assert.ok(replaced.ok && replaced.project.signKey === 'NEW');
assert.equal(mergeProjectSave(undefined, { name: 'N', rootDir: '/a', signPackageLocation: '/k.pkg', outputLocation: '/o.pkg' }).ok, false);

// Args: one array element per value, so spaces and quotes survive
assert.deepEqual(buildArgs('My App "QA"', '10.0.0.5', 'pw', { kind: 'task', label: 'build:prod' }, {}), ['generate', 'My App "QA"', '--json', '--host', '10.0.0.5', '--password', 'pw', '--build-task', 'build:prod']);
assert.deepEqual(buildArgs('A', 'h', 'p', { kind: 'existing' }, { skipRekey: true, packageOnly: true }).slice(-3), ['--use-existing-build', '--skip-rekey', '--package-only']);
assert.ok(buildArgs('A', 'h', 'p', { kind: 'none' }, {}).includes('--skip-build'));

// History
const e = historyEntry(s);
assert.equal(e.ok, true);
assert.equal(e.packagePath, '/out/CNBC.pkg');
let all: HistoryEntry[] = [];
for (let i = 0; i < HISTORY_PER_PROJECT + 3; i++) all = appendHistory(all, { ...e, runId: String(i), at: i });
all = appendHistory(all, { ...e, project: 'other', runId: 'o' });
assert.equal(all.filter((h) => h.project === 'CNBC').length, HISTORY_PER_PROJECT);
assert.equal(all[0].runId, 'o'); // newest first

// History rows say why a run failed and what it skipped
let km = initialRunState('k1', 'CNBC', 'Stick', 0);
km = applyEvent(km, { type: 'step', step: 'rekey', status: 'skip' }, 1);
km = applyEvent(km, { type: 'result', ok: false, step: 'sign', code: 'KEY_MISMATCH', message: 'x' }, 2);
assert.equal(historyLabel(historyEntry(km)), 'Device keyed for another app · rekey skipped');
let good = initialRunState('k2', 'CNBC', 'Stick', 0);
good = applyEvent(good, { type: 'step', step: 'build', status: 'done', detail: 'build:prod' }, 1);
good = applyEvent(good, { type: 'result', ok: true, packagePath: '/o.pkg', sizeBytes: 4404019, version: '10.0.0' }, 2);
assert.equal(historyLabel(historyEntry(good)), 'v10.0.0 · 4.2 MB · build:prod');
const oldEntry: HistoryEntry = { runId: 'o', project: 'p', at: 0, ok: false, code: 'SIGN_FAILED', step: 'sign', ms: 1 };
assert.equal(historyLabel(oldEntry), 'Sign package failed'); // entries saved before this change still read fine

console.log('verify-packager: ok');
