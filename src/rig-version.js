// The rig release this action installs when `version` is empty or
// "latest-known". A new rig release reaches consumers only through an action
// release, never through a run-time lookup. Generated: npm run pin-rig.
export const defaultRigVersion = 'v0.3.1';

// Per-asset digests of that release. installRig verifies the default install
// against these instead of the release's SHA256SUMS, so a release replaced
// after this file was generated fails the install.
export const defaultRigSha256 = {
  'rig-darwin-amd64': 'b2a6b8daffb855bea54acb36feaf417e76f2e53cc1ded439594a2070559bf453',
  'rig-darwin-arm64': 'bc0e5c3022691149921fdcd040c416a34d94683ff084284417f8fb8bd3968225',
  'rig-linux-amd64': 'b182077be3e6200806b68e53e7154c176bc12ad39de46d166de4fb39e8a4243b',
  'rig-linux-arm64': '369210e96593195ce3f2f32eec5eb59a25239a92d1650fb57d1191a4b93c72ab',
};
