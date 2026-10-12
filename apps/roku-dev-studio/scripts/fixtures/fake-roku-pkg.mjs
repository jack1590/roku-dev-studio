#!/usr/bin/env node
// Test double for `roku-pkg`. Records its argv to FAKE_ARGS_FILE and prints events by FAKE_MODE.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.FAKE_VERSION ?? '1.2.1'); process.exit(0); }
if (process.env.FAKE_ARGS_FILE) fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.FAKE_MODE ?? 'ok';
if (args[0] === 'inspect') { out({ manifest: { title: 'CNBC', version: '4.12.0' }, buildDir: '/a/dist', buildDirSource: 'launch.json', buildExists: true, tasks: [{ label: 'build:prod', isBuild: true }] }); process.exit(0); }
out({ type: 'step', step: 'home', status: 'start' });
process.stdout.write('{"type":"step","step":"home",'); // split line
setTimeout(() => {
  process.stdout.write('"status":"done","ms":3}\nplain noise\n');
  if (mode === 'ok') { out({ type: 'result', ok: true, packagePath: '/out/CNBC.pkg', sizeBytes: 42, version: '4.12.0' }); process.exit(0); }
  if (mode === 'flood') { for (let i = 0; i < 1500; i++) out({ type: 'log', level: 'info', text: `line ${i}` }); out({ type: 'result', ok: true, packagePath: '/out/CNBC.pkg', sizeBytes: 42 }); process.exit(0); }
  if (mode === 'stubborn') { out({ type: 'step', step: 'deploy', status: 'start' }); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  if (mode === 'crash') { out({ type: 'step', step: 'deploy', status: 'start' }); process.stderr.write('Segmentation fault\n'); process.exit(139); }
  if (mode === 'hang') {
    out({ type: 'step', step: 'deploy', status: 'start' });
    process.on('SIGTERM', () => { out({ type: 'result', ok: false, step: 'deploy', code: 'CANCELLED', message: 'Cancelled' }); process.exit(130); });
    setInterval(() => {}, 1000);
  }
}, 50);
