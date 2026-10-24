// Checks every digest in src/rig-version.js against what that release publishes
// today. CI installs on linux/amd64, linux/arm64 and darwin/arm64, so without
// this the digest for a platform no runner reaches — rig-darwin-amd64, since
// GitHub retired the Intel macOS images — would first be tested in a consumer's
// job. It also goes red if a pinned release's asset is ever replaced.
//
//   npm run verify-pin
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as common from '../src/common.js';
import { defaultRigSha256, defaultRigVersion } from '../src/rig-version.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pin-'));
const assets = Object.entries(defaultRigSha256);
const total = assets.length;
const mismatches = [];
try {
  for (const [asset, want] of assets) {
    const file = path.join(tmp, asset);
    await common.download(`https://github.com/${common.REPO}/releases/download/${defaultRigVersion}/${asset}`, file);
    const got = common.sha256File(file);
    console.log(`${asset}: ${got === want ? want : `MISMATCH\n    want ${want}\n    got  ${got}`}`);
    if (got !== want) mismatches.push(asset);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (mismatches.length) {
  throw new Error(`verify-pin: ${mismatches.length}/${total} digests do not match ${defaultRigVersion} (${mismatches.join(', ')})`);
}
console.log(`${total} assets match ${defaultRigVersion}`);
