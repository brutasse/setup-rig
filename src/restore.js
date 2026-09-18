const core = require('@actions/core');
const cache = require('@actions/cache');
const path = require('path');
const common = require('./common');

async function run() {
  const version = (core.getInput('version') || '').trim();
  const token = (core.getInput('token') || process.env.GITHUB_TOKEN || '').trim();
  const enableCache = core.getBooleanInput('enable-cache');
  const enableJvm = core.getBooleanInput('enable-jvm');
  const enableGraalvm = (core.getInput('enable-graalvm') || 'auto').trim().toLowerCase();
  const javaOnPath = core.getBooleanInput('java-on-path');
  if (!['auto', 'true', 'false'].includes(enableGraalvm)) {
    throw new Error(`setup-rig: bad enable-graalvm '${enableGraalvm}' (want auto, true or false)`);
  }

  // 1. Install rig (download + SHA256-verify + PATH).
  const inst = await common.installRig(version, token);
  core.addPath(inst.installDir);
  core.setOutput('rig-version', inst.version);
  core.saveState('setup-rig-setup', 'true');
  core.info(`setup-rig: installed rig ${inst.version} (${inst.bin}) -> ${inst.dest}`);

  // 2. Restore the artifact cache (key = platform + sha256(deps.lock)).
  if (enableCache) {
    const key = common.cacheKey();
    let hit = false;
    try {
      hit = !!(await cache.restoreCache(common.prepareCachePaths(), key));
    } catch (e) {
      hit = false;
      core.warning(`setup-rig: cache restore failed: ${e.message}`);
    }
    core.setOutput('cache-hit', String(hit));
    core.saveState('setup-rig-cache-hit', String(hit));
    core.saveState('setup-rig-cache-key', key);
    if (hit) {
      core.info(`setup-rig: cache hit (${key})`);
    } else {
      core.info(`setup-rig: cache miss (${key}); it will be saved at the end of the job`);
    }
  } else {
    core.setOutput('cache-hit', 'false');
    core.info('setup-rig: cache disabled; not restoring.');
  }

  // 3. Install the toolchain pinned in deps.lock (rig-managed Temurin /
  // GraalVM CE in the rig state dir; both installs are idempotent).
  const pins = common.readLockPins();
  const plan = common.jvmPlan(pins, enableJvm, enableGraalvm);
  core.setOutput('jvm-version', plan.jvm);
  core.setOutput('graalvm-version', plan.graalvm);
  if (!plan.jvm && !plan.graalvm) {
    if (pins.jvm && !enableJvm) core.info('setup-rig: deps.lock pins a JVM but enable-jvm=false; skipping.');
    if (enableGraalvm === 'true' && !pins.graalvm && !pins.jvm) {
      core.warning('setup-rig: enable-graalvm=true but the lock pins no graalvm/jvm to install from.');
    }
    return;
  }
  if (!common.rigHasCommand(inst.dest, 'jvm')) {
    throw new Error(`setup-rig: deps.lock pins a JVM/GraalVM but rig ${inst.version} has no 'jvm' command (rig >= v0.2 required)`);
  }
  if (enableCache) {
    const key = common.jvmCacheKey(plan);
    const paths = common.prepareJvmCachePaths(plan);
    let hit = false;
    try {
      hit = !!(await cache.restoreCache(paths, key));
    } catch (e) {
      hit = false;
      core.warning(`setup-rig: jvm cache restore failed: ${e.message}`);
    }
    core.saveState('setup-rig-jvm-cache', JSON.stringify({ key, paths, hit }));
    core.info(hit ? `setup-rig: jvm cache hit (${key})` : `setup-rig: jvm cache miss (${key}); it will be saved at the end of the job`);
  } else {
    core.info('setup-rig: cache disabled; installing the pinned toolchain without persisting it.');
  }
  if (plan.jvm) common.runRig(inst.dest, ['jvm', 'install', plan.jvm], token);
  if (plan.graalvm) common.runRig(inst.dest, ['graalvm', 'install', plan.graalvm], token);

  // 4. Publish the installed homes (needs rig's 'jvm path'/'graalvm path'
  // commands; empty on releases that predate them).
  const tryPath = (args) => {
    try {
      return common.runRig(inst.dest, args, token, { capture: true });
    } catch {
      return '';
    }
  };
  const javaHome = plan.jvm ? tryPath(['jvm', 'path', plan.jvm]) : '';
  const graalHome = plan.graalvm ? tryPath(['graalvm', 'path', plan.graalvm]) : '';
  core.setOutput('java-home', javaHome);
  core.setOutput('graalvm-home', graalHome);
  if (javaOnPath) {
    if (javaHome) {
      core.exportVariable('JAVA_HOME', javaHome);
      core.addPath(path.join(javaHome, 'bin'));
    }
    if (graalHome) {
      core.exportVariable('GRAALVM_HOME', graalHome);
      core.addPath(path.join(graalHome, 'bin'));
    }
  }
}

run().catch((e) => core.setFailed(e && e.message ? e.message : String(e)));
