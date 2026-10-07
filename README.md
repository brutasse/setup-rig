# setup-rig

Reusable GitHub Action that installs the [rig](https://github.com/brutasse/rig)
binary — SHA256-verified from the release — and manages rig's artifact cache,
keyed on your `deps.lock`.

A cache hit means the locked artifacts are already local: a subsequent
`rig verify --frozen --offline` (the hermetic / air-gapped gate) can run with
no network.

Caching is automatic: the action **restores** the cache when the step runs and
**saves** it at the end of the job (GitHub Actions `post` entry point) — no
extra save step needed, and it saves even after failed steps.

## Usage

```yaml
- name: Install the latest version of rig
  uses: brutasse/setup-rig@v1
```

If you do not specify a version, the latest [rig](https://github.com/brutasse/rig)
release is installed. To install a specific version, pin `version`:

```yaml
- name: Install rig v0.3.0
  uses: brutasse/setup-rig@v1
  with:
    version: v0.3.0
    token: ${{ github.token }}
```

### Full workflow

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install rig + cache
        uses: brutasse/setup-rig@v1
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
  uses: brutasse/setup-rig@v1
  with:
    # The version of rig to install, e.g., "v0.3.0" (default: latest release)
    version: ""

    # GitHub token for the latest-release lookup, avoids API rate limits
    # (not needed when version is set)
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
- uses: brutasse/setup-rig@v1
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
      - uses: brutasse/setup-rig@v1  # lock has a graalvm block -> GraalVM installed
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
```
