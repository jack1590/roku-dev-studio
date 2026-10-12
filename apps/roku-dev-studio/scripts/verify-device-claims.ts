/** Pins device claiming shared by PR Reviews and the Packager. Run with `npm run verify:device-claims`. */
import assert from 'node:assert/strict';
import { busyLabel, tryClaim } from '../shared/device-claims.js';

const busy = new Map<string, string>();
assert.equal(tryClaim(busy, 'dev1', 'packager:CNBC'), true);
assert.equal(tryClaim(busy, 'dev1', 'acme|o/r#1'), false); // held by the packager
assert.equal(tryClaim(busy, 'dev1', 'packager:CNBC'), false); // a second run of the same project too
assert.equal(busyLabel('packager:CNBC'), 'Packaging CNBC');
assert.equal(busyLabel('acme|o/r#1'), undefined);
console.log('verify-device-claims: ok');
