const core = require('@actions/core');
const cache = require('@actions/cache');
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
    await save(common.prepareCachePaths(), key, 'cache');
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
  } else {
    await save(jvm.paths, jvm.key, 'jvm cache');
  }
}

run().catch((e) => core.setFailed(e && e.message ? e.message : String(e)));
