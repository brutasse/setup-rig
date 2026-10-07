const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const glob = require('@actions/glob');

const REPO = 'brutasse/rig';
const DEFAULT_LOCKFILE = 'deps.lock';

function rigBinaryName() {
  const osName = process.platform === 'linux' ? 'linux'
    : process.platform === 'darwin' ? 'darwin' : null;
  if (!osName) throw new Error(`setup-rig: unsupported platform '${process.platform}' (want linux or darwin)`);
  const archName = process.arch === 'x64' ? 'amd64'
    : process.arch === 'arm64' ? 'arm64' : null;
  if (!archName) throw new Error(`setup-rig: unsupported architecture '${process.arch}' (want x64 or arm64)`);
  return `rig-${osName}-${archName}`;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? require('https') : require('http');
    lib.get(url, { headers: { 'User-Agent': 'setup-rig' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`setup-rig: download ${url}: status ${res.statusCode}`));
      }
      const out = fs.createWriteStream(dest);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.pipe(out);
    }).on('error', reject);
  });
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function parseSHA256SUMS(p, filename) {
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === filename) return parts[0];
  }
  return '';
}

function latestReleaseTag(token) {
  const url = `https://api.github.com/repos/${REPO}/releases/latest`;
  const headers = token
    ? { Authorization: `token ${token}`, 'User-Agent': 'setup-rig' }
    : { 'User-Agent': 'setup-rig' };
  return new Promise((resolve, reject) => {
    require('https').get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`setup-rig: latest-release lookup: status ${res.statusCode}`));
      }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).tag_name);
        } catch (e) {
          reject(new Error(`setup-rig: bad latest-release response: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// Downloads the platform binary for `version` (or the latest release), verifies
// it against the release SHA256SUMS, and installs it to ~/.local/bin/rig.
// Returns { version, bin, dest, installDir }.
async function installRig(version, token) {
  const bin = rigBinaryName();
  let ver = version;
  if (!ver) ver = await latestReleaseTag(token);
  if (!/^v\d+\.\d+\.\d+/.test(ver)) throw new Error(`setup-rig: bad version '${ver}' (want vX.Y.Z)`);

  const base = `https://github.com/${REPO}/releases/download/${ver}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-rig-'));
  const binPath = path.join(tmp, bin);
  const sumsPath = path.join(tmp, 'SHA256SUMS');
  await download(`${base}/${bin}`, binPath);
  await download(`${base}/SHA256SUMS`, sumsPath);
  const want = parseSHA256SUMS(sumsPath, bin);
  if (!want) throw new Error(`setup-rig: ${bin} not listed in SHA256SUMS`);
  const got = sha256File(binPath);
  if (want !== got) throw new Error(`setup-rig: sha256 mismatch for ${bin} (got ${got}, want ${want})`);

  const installDir = path.join(os.homedir(), '.local', 'bin');
  fs.mkdirSync(installDir, { recursive: true });
  const dest = path.join(installDir, 'rig');
  fs.copyFileSync(binPath, dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { version: ver, bin, dest, installDir };
}

function rigStateDir() {
  const shareDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(shareDir, 'rig');
}

// Rig's content-addressed artifact cache, the local Maven repo (the
// `repository` dir only — never ~/.m2, which holds settings.xml credentials),
// and the git-deps checkout.
function cachePaths() {
  return [rigStateDir(), path.join(os.homedir(), '.m2', 'repository'), path.join(os.homedir(), '.gitlibs')];
}

// @actions/cache refuses to save nonexistent paths; create them so a cold
// cache (no Maven or git deps yet) still saves/restore cleanly.
function prepareCachePaths() {
  const paths = cachePaths();
  for (const p of paths) fs.mkdirSync(p, { recursive: true });
  return paths;
}

// Resolve the `lockfile` input: workspace-relative paths or glob patterns,
// whitespace/newline-separated (a monorepo matches its rig modules with e.g.
// `services/*/deps.lock`). Returns sorted, deduped absolute paths. Nothing
// matched is only tolerated for the untouched default — a repo without a
// deps.lock then keeps the pre-lockfile behavior (no-lock key, no pins);
// an explicit pattern that matches nothing is a typo and fails.
async function resolveLockFiles(patterns) {
  const list = String(patterns || DEFAULT_LOCKFILE).split(/[\s,]+/).filter(Boolean);
  const ws = process.env.GITHUB_WORKSPACE || process.cwd();
  const matcher = await glob.create(list.map((p) => path.resolve(ws, p)).join('\n'));
  const files = [...new Set(await matcher.glob())].sort();
  if (!files.length && list.join(' ') !== DEFAULT_LOCKFILE) {
    throw new Error(`setup-rig: no deps.lock matched '${list.join(' ')}'`);
  }
  return files;
}

// The cache key: platform + the lock content. One lock -> sha256 of its
// bytes; several locks -> one hash over the (path, hash) pairs, sorted —
// every module writes into the same global stores, so the cache is restored
// and saved as one unit and any lock bump re-fetches it all.
function cacheKey(files) {
  let lockHash = 'no-lock';
  if (files.length === 1) {
    lockHash = sha256File(files[0]);
  } else if (files.length > 1) {
    const ws = process.env.GITHUB_WORKSPACE || process.cwd();
    const h = crypto.createHash('sha256');
    for (const f of files) h.update(`${path.relative(ws, f)}\0${sha256File(f)}\0`);
    lockHash = h.digest('hex');
  }
  return `rig-${process.platform}-${process.arch}-${lockHash}`;
}

// The toolchain pins from the deps.lock files (JSON): {"jvm":{"requested":
// "21"}, "graalvm":{"requested":"21"}}. A missing or unparseable lock (e.g.
// a stub lock) contributes no pins — the action then behaves as it did
// before JVM support. One lock pins a block when it has it; across locks
// the pins must agree, since the action installs one toolchain and reports
// one java-home. rig itself validates the locks; the action only reads pins.
function readLockPins(files) {
  const requested = (block) =>
    block && typeof block.requested === 'string' && /^\d{1,2}$/.test(block.requested.trim()) ? block.requested.trim() : '';
  const pins = {};
  for (const block of ['jvm', 'graalvm']) {
    const owners = {};
    for (const f of files) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      const v = requested(doc && doc[block]);
      if (v) (owners[v] = owners[v] || []).push(f);
    }
    const values = Object.keys(owners);
    if (values.length > 1) {
      const detail = values.map((v) => `${v} (in ${owners[v].join(', ')})`).join(' vs ');
      throw new Error(`setup-rig: the deps.lock files disagree on the ${block} pin: ${detail}`);
    }
    if (values.length === 1) pins[block] = values[0];
  }
  return pins;
}

// What to install: the pinned JVM (unless enable-jvm is off), and a GraalVM
// when the lock has a graalvm block (auto — rig locks carry one only when a
// module declares :rig/native?), or when enable-graalvm is true and a major
// can be derived from the JVM pin.
function jvmPlan(pins, enableJvm, enableGraalvm) {
  const plan = { jvm: '', graalvm: '' };
  if (enableJvm && pins.jvm) plan.jvm = pins.jvm;
  if (enableGraalvm !== 'false') {
    if (pins.graalvm) plan.graalvm = pins.graalvm;
    else if (enableGraalvm === 'true' && pins.jvm) plan.graalvm = pins.jvm;
  }
  return plan;
}

// The rig-managed toolchain stores (rig jvm / graalvm install into the state
// dir). Cached under a key of the pins, not the lock hash: a lock bump never
// re-downloads a JDK, and artifact-cache saves stay lean.
function jvmCachePaths(plan) {
  const root = rigStateDir();
  const paths = [];
  if (plan.jvm) paths.push(path.join(root, 'jdks'));
  if (plan.graalvm) paths.push(path.join(root, 'graal'));
  return paths;
}

function prepareJvmCachePaths(plan) {
  const paths = jvmCachePaths(plan);
  for (const p of paths) fs.mkdirSync(p, { recursive: true });
  return paths;
}

function jvmCacheKey(plan) {
  let key = `rig-jvm-${process.platform}-${process.arch}`;
  if (plan.jvm) key += `-jvm${plan.jvm}`;
  if (plan.graalvm) key += `-graalvm${plan.graalvm}`;
  return key;
}

// Runs the rig binary with the token propagated: `rig graalvm install`
// resolves through the GitHub API and otherwise hits the unauthenticated
// per-IP rate limit. Returns trimmed stdout when capture is set.
function runRig(bin, args, token, opts = {}) {
  const env = { ...process.env };
  if (token) {
    env.GITHUB_TOKEN = token;
    env.GH_TOKEN = token;
  }
  const out = execFileSync(bin, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', opts.capture ? 'pipe' : 'inherit', 'inherit'],
  });
  return opts.capture ? (out || '').trim() : '';
}

function rigHasCommand(bin, cmd) {
  try {
    execFileSync(bin, [cmd, '--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  REPO,
  rigBinaryName,
  download,
  sha256File,
  parseSHA256SUMS,
  latestReleaseTag,
  installRig,
  rigStateDir,
  cachePaths,
  prepareCachePaths,
  resolveLockFiles,
  cacheKey,
  readLockPins,
  jvmPlan,
  jvmCachePaths,
  prepareJvmCachePaths,
  jvmCacheKey,
  runRig,
  rigHasCommand,
};
