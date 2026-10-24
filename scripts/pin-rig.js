// Regenerates src/rig-version.js: the rig release the action installs when
// `version` is empty or "latest-known", plus the SHA256 of every binary asset
// of that release. The digests travel in the bundle on purpose — checking a
// binary against the sums file published by the same release cannot catch that
// release being replaced afterwards.
//
//   npm run pin-rig              # pin rig's latest release
//   npm run pin-rig -- v0.3.0    # pin a specific release
//
// Then `npm run build` and commit dist/ with it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as common from '../src/common.js';

const PIN_FILE = path.join(import.meta.dirname, '..', 'src', 'rig-version.js');
const PINNED_ASSET = /^rig-(?:linux|darwin)-(?:amd64|arm64)$/;
const REQUIRED_ASSETS = ['rig-darwin-amd64', 'rig-darwin-arm64', 'rig-linux-amd64', 'rig-linux-arm64'];

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const version = process.argv[2] || (await common.latestReleaseTag(token));
if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`pin-rig: bad version '${version}' (want vX.Y.Z)`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-rig-'));
try {
  const sumsPath = path.join(tmp, 'SHA256SUMS');
  await common.download(`https://github.com/${common.REPO}/releases/download/${version}/SHA256SUMS`, sumsPath);

  const digests = {};
  for (const line of fs.readFileSync(sumsPath, 'utf8').split('\n')) {
    const [hash, asset] = line.trim().split(/\s+/);
    if (PINNED_ASSET.test(asset || '')) digests[asset] = hash;
  }
  const missing = REQUIRED_ASSETS.filter((asset) => !digests[asset]);
  if (missing.length) throw new Error(`pin-rig: ${version} SHA256SUMS lists no ${missing.join(', ')}`);

  const assets = Object.keys(digests).sort().map((asset) => `  '${asset}': '${digests[asset]}',`).join('\n');
  fs.writeFileSync(PIN_FILE, `// The rig release this action installs when \`version\` is empty or
// "latest-known". A new rig release reaches consumers only through an action
// release, never through a run-time lookup. Generated: npm run pin-rig.
export const defaultRigVersion = '${version}';

// Per-asset digests of that release. installRig verifies the default install
// against these instead of the release's SHA256SUMS, so a release replaced
// after this file was generated fails the install.
export const defaultRigSha256 = {
${assets}
};
`);
  console.log(`pinned ${common.REPO} ${version} (${Object.keys(digests).length} assets) -> src/rig-version.js`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
