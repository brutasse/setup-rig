# setup-rig

Reusable GitHub Action that installs the [rig](https://github.com/brutasse/rig)
binary — the release it installs by default is pinned and sha256-verified
against a digest shipped inside the action — and manages rig's artifact cache,
keyed on your `deps.lock`.

A cache hit means the locked artifacts are already local: a subsequent
`rig verify --frozen --offline` (the hermetic / air-gapped gate) can run with
no network.

Caching is automatic: the action **restores** the cache when the step runs and
**saves** it at the end of the job (GitHub Actions `post` entry point) — no
extra save step needed, and it saves even after failed steps.

## Usage

```yaml
- name: Install rig
  uses: brutasse/setup-rig@b204f6b12fde6574ebbebe0227fcaaa10391882f # v2.0.0
```

### Which rig version

| `version` | what you get |
|---|---|
| *(omitted)* or `latest-known` | the release pinned in this action version, verified against a digest shipped inside the action |
| `v0.3.0` | that release, verified against its release `SHA256SUMS` |
| `latest` | whatever rig's newest release is when the job runs — an API lookup, verified against its `SHA256SUMS` |

The default is pinned rather than looked up: a new rig release reaches your jobs
only when this action ships a release that pins it, and the binary is checked
against the digest bundled in `dist/` instead of a sums file published by the
same release — sums cannot show that a release was replaced after the fact.
`latest` gives both properties up, which is why it has to be asked for.

What the pin does **not** cover: rig fetches its resolver/runner jars at run
time and offers `rig self-update`, both outside what this action installs.

### Full workflow

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install rig + cache
        uses: brutasse/setup-rig@b204f6b12fde6574ebbebe0227fcaaa10391882f # v2.0.0
        with:
          version: v0.3.0
          token: ${{ github.token }}

      - name: Verify, check and test (frozen)
        run: |
          rig verify --frozen
          rig check --frozen
          rig test --frozen
```

The `uses:` refs are SHA-pinned with a version comment — the form renovate
bumps automatically, and CI rewrites them to the newest release on every tag
push. The floating `v1` tag is published too, but prefer the SHA pin.

### Inputs

All inputs and their defaults:

```yaml
- name: Install rig with all available options
  uses: brutasse/setup-rig@b204f6b12fde6574ebbebe0227fcaaa10391882f # v2.0.0
  with:
    # The rig release to install: a tag like "v0.3.0", "latest-known" (the
    # release pinned in this action, the default) or "latest" (run-time lookup)
    version: "latest-known"

    # GitHub token propagated to rig's jvm/graalvm installs and used by
    # version: latest, avoids API rate limits
    token: ${{ github.token }}

    # Restore the cache at setup and save it at the end of the job, keyed on deps.lock
    enable-cache: "true"

    # Path(s) to deps.lock, relative to the workspace root: multiple entries
    # (whitespace/newline-separated) and glob patterns allowed
    lockfile: "deps.lock"

    # Install the JVM pinned in deps.lock, `rig jvm install` (no-op when the
    # lock pins no JVM)
    enable-jvm: "true"

    # Install a GraalVM for native-image builds: "auto" (only when the lock
    # has a graalvm block), "true" (also derived from the JVM pin), "false"
    enable-graalvm: "auto"

    # Export JAVA_HOME/GRAALVM_HOME and prepend their bin dirs to PATH for
    # later steps (rig commands use the pinned JVM either way)
    java-on-path: "false"
```

The cache is saved automatically at the end of the job, after all other
steps, and even when a step fails (artifacts fetched against the lock are
still valid). Set `enable-cache: false` to opt out entirely.

## What it caches

`~/.local/share/rig` (the content-addressed artifact cache),
`~/.m2/repository`, and `~/.gitlibs` — under the key
`rig-<platform>-<sha256(deps.lock)>`. Same lock → warm hit; a changed lock →
miss and re-fetch. (It deliberately does **not** cache `~/.m2` itself, which
holds `settings.xml` credentials.)

With several lockfiles (see below) the key hashes them together, so any
lock bump re-fetches the whole cache.

### Multiple modules

A monorepo's rig modules keep their `deps.lock` in their module dirs. Point
`lockfile` at them — paths and globs, one entry per line:

```yaml
- uses: brutasse/setup-rig@b204f6b12fde6574ebbebe0227fcaaa10391882f # v2.0.0
  with:
    lockfile: |
      deps.lock
      services/*/deps.lock
```

Every module reads and writes the same global stores, so the matched locks
hash into **one** cache key (restored and saved as a unit), and their
JVM/GraalVM pins must **agree** — the action installs one toolchain and
reports one `java-home`.

The rig-managed JDK and GraalVM stores are cached separately — see
[JVM & GraalVM](#jvm--graalvm).

## JVM & GraalVM

A rig project pins its JVM with `{:rig/jvm "21"}` in the root `deps.edn`.
`rig lock` carries the pin into `deps.lock` (plus a `graalvm` block when a
module declares `:rig/native?`), and the action reads those pins:

- `rig jvm install <major>` — Temurin from the Adoptium API, sha256-verified,
  into the rig state dir;
- `rig graalvm install <major>` when the lock has a `graalvm` block (or with
  `enable-graalvm: true`) — GraalVM CE from the official GitHub releases,
  same treatment, and the token is propagated so the release lookup isn't
  rate-limited.

Both installs are idempotent — a warm store means zero network — and rig
uses the managed JDK itself: it takes precedence over the system `java` for
every rig command, so a workflow that only runs `rig` needs no
`actions/setup-java`.

The stores are cached under their own key,
`rig-jvm-<platform>-<arch>-jvm<major>[-graalvm<major>]`: a lock bump never
re-downloads a JDK, and projects pinning nothing pay nothing.

```yaml
  native:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: brutasse/setup-rig@b204f6b12fde6574ebbebe0227fcaaa10391882f # v2.0.0
      - run: rig build --native
```

If steps other than rig need the toolchain, use the `java-home` /
`graalvm-home` outputs, or set `java-on-path: true` to export
`JAVA_HOME`/`GRAALVM_HOME` and prepend their `bin` dirs. (The homes come
from rig's `jvm path` / `graalvm path` commands, added in rig v0.3.0.) To
make rig use a workflow-provided JDK or GraalVM instead — e.g. one from
`gradle/setup-graalvm` — point `RIG_JAVA` / `RIG_GRAALVM_HOME` at it; rig
trusts those overrides as-is.

## Outputs

| Output | Description |
|---|---|
| `rig-version` | the rig version that was installed |
| `cache-hit` | `true` when the cache was restored |
| `jvm-version` | the JVM major pinned in `deps.lock` and installed (empty when none) |
| `graalvm-version` | the GraalVM major installed for native builds (empty when none) |
| `java-home` | `JAVA_HOME` of the installed managed JDK (empty below rig v0.3.0) |
| `graalvm-home` | `GRAALVM_HOME` of the installed GraalVM (empty below rig v0.3.0) |

## Build

```sh
npm install
npm run build        # bundles src/restore.js -> dist/restore, src/save.js -> dist/save (ncc)
npm run pin-rig      # repoints src/rig-version.js (the default rig release and its
                     # asset digests) at rig's latest release, or at one given as an
                     # argument: npm run pin-rig -- v0.3.0
npm run verify-pin   # hashes every asset of that release against the digests in
                     # src/rig-version.js — CI runs it alongside installs on
                     # linux/amd64, linux/arm64 and darwin/arm64
```

`npm run pin-rig` edits a bundled constant, so it is followed by `npm run build`
and both are committed together — Renovate opens the bump PR and says so, and
cutting an action tag afterwards is what publishes the new default.

`dist/` is committed and is what the runner executes, so commit the rebuild together
with the `src/` or dependency change it came from — CI rebuilds and fails on any diff.
