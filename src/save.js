const core = require('@actions/core');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const common = require('./common');

async function save(paths, key, label) {
  try {
    const id = await cache.saveCache(paths, key);
    core.info(`setup-rig: ${label} ${id >= 0 ? 'saved' : 'not saved'} (${key})`);
  } catch (e) {
    const msg = String(e.message);
    if (/path validation|no cache is being saved/i.test(msg)) {
      core.info(`setup-rig: ${label} not saved (${msg})`);
    } else {
      core.warning(`setup-rig: ${label} save failed: ${msg}`);
    }
  }
}

// The toolchain stores live inside the rig state dir, but are cached under
// their own pins-derived key: move them aside while taring the artifact
// cache so it does not duplicate ~200 MB of JDK into every lock-keyed
// entry. The renames stay inside the XDG share dir, so they are cheap.
async function withoutStores(fn) {
  const root = common.rigStateDir();
  const moved = [];
  for (const name of ['jdks', 'graal']) {
    const from = path.join(root, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(path.dirname(root), `.setup-rig-${name}`);
    fs.renameSync(from, to);
    moved.push([to, from]);
  }
  try {
    await fn();
  } finally {
    for (const [to, from] of moved.reverse()) fs.renameSync(to, from);
  }
}

async function run() {
  if (core.getState('setup-rig-setup') !== 'true') {
    core.info('setup-rig: setup did not run; not saving.');
    return;
  }

  // The artifact cache (keyed on deps.lock).
  const key = core.getState('setup-rig-cache-key');
  if (!key) {
    core.info('setup-rig: artifact cache disabled; not saving.');
  } else if (core.getState('setup-rig-cache-hit') === 'true') {
    // If the restore was an exact hit, the cache is unchanged — skip the save
    // (avoids taring a large cache only to hit "key already exists").
    core.info(`setup-rig: cache hit on restore (${key}); not saving.`);
  } else {
    await withoutStores(() => save(common.prepareCachePaths(), key, 'cache'));
  }

  // The managed toolchain stores (keyed on the deps.lock pins).
  let jvm = null;
  try {
    jvm = JSON.parse(core.getState('setup-rig-jvm-cache') || '');
  } catch {
    jvm = null;
  }
  if (!jvm) return;
  if (jvm.hit) {
    core.info(`setup-rig: jvm cache hit on restore (${jvm.key}); not saving.`);
  } else if (core.getState('setup-rig-installs-ok') !== 'true') {
    core.info('setup-rig: toolchain installs did not complete; not saving the jvm cache.');
  } else {
    await save(jvm.paths, jvm.key, 'jvm cache');
  }
}

run().catch((e) => core.setFailed(e && e.message ? e.message : String(e)));
