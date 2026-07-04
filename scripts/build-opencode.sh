#!/usr/bin/env bash
# Build OpenCode standalone binary for Android aarch64
#
# Usage: ./scripts/build-opencode.sh
#
# This script:
# 1. Clones OpenCode if needed
# 2. Swaps x86_64 libopentui.so with ARM64 version
# 3. Creates synthetic @opentui/core-linux-arm64 package for platform detection
# 4. Runs the TypeScript build script to create the standalone binary
# 5. Restores original libopentui.so and cleans up synthetic package
#
# Requires:
# - Android Bun binary built (scripts/build-bun.sh)
# - libopentui.so built (scripts/build-opentui.sh)
# - Host Bun installed (for bundling)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

HOST_BUN="${HOST_BUN:-bun}"

echo "=== Building OpenCode v${OPENCODE_VERSION} for Android aarch64 ==="

# Clone OpenCode if needed
if [ ! -d "$OPENCODE_SRC/.git" ]; then
    echo ">>> Cloning OpenCode..."
    git clone --depth 1 --branch "v${OPENCODE_VERSION}" https://github.com/anomalyco/opencode.git "$OPENCODE_SRC"
else
    echo ">>> OpenCode source exists at $OPENCODE_SRC"
fi

# Patch watcher.ts for Android standalone file watching
# In standalone binaries, dlopen() cannot load .node from Bun's virtual FS ($bunfs/).
# Patch watcher.ts to extract watcher.node to real disk before require().
WATCHER_TS="$OPENCODE_SRC/packages/core/src/filesystem/watcher.ts"
if [ -f "$WATCHER_TS" ]; then
    echo ">>> Patching watcher.ts for Android standalone..."
    python3 - "$WATCHER_TS" << 'PATCHSCRIPT'
import sys

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    content = f.read()

OLD = """  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }"""

NEW = """  try {
    // In standalone binaries, dlopen() cannot load .node from Bun's virtual
    // filesystem ($bunfs/). Extract watcher.node from $bunfs to real disk first.
    try {
      const fs = require("fs")
      const tmpDir = process.env.TMPDIR || "/tmp"
      const extractDir = tmpDir + "/opencode-parcel"
      fs.mkdirSync(extractDir, { recursive: true })
      const realPath = extractDir + "/watcher.node"
      if (!fs.existsSync(realPath)) {
        // fs.readFileSync CAN read from $bunfs virtual filesystem paths.
        // Try known paths where the watcher.node is embedded in the module graph.
        const candidates = [
          "/$bunfs/root/node_modules/.bun/@parcel+watcher-linux-x64-glibc@2.5.1/node_modules/@parcel/watcher-linux-x64-glibc/watcher.node",
          "node_modules/.bun/@parcel+watcher-linux-x64-glibc@2.5.1/node_modules/@parcel/watcher-linux-x64-glibc/watcher.node",
        ]
        let data = null
        for (const p of candidates) {
          try { data = fs.readFileSync(p); if (data?.length) break } catch {}
        }
        if (data?.length) {
          fs.writeFileSync(realPath, data)
          console.error("[opencode-parcel] Extracted from $bunfs (" + data.length + " bytes)")
        } else {
          console.error("[opencode-parcel] watcher.node not found in $bunfs, using polling")
          return
        }
      }
      const binding = require(realPath)
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (e) { console.error("[opencode-parcel] Error: " + e) }
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }"""

if OLD in content:
    content = content.replace(OLD, NEW, 1)
    with open(filepath, 'w') as f:
        f.write(content)
    print("    watcher.ts patched successfully")
else:
    print("    WARNING: watcher.ts pattern not found (already patched or source changed)")
PATCHSCRIPT
fi

OPENCODE_PKG="$OPENCODE_SRC/packages/opencode"

# Install OpenCode dependencies
echo ">>> Installing OpenCode dependencies..."
cd "$OPENCODE_SRC"
"$HOST_BUN" install

# Install ARM64 @parcel/watcher platform package for native file watching
# On Android aarch64, watcher.ts resolves to @parcel/watcher-linux-arm64-glibc
# The host bun install only pulls x86_64 packages, so we install the ARM64 variant
# and copy its watcher.node into the x64 package dir so the bundler embeds it.
echo ">>> Installing ARM64 @parcel/watcher..."

# First try bun add (which updates lockfile)
cd "$OPENCODE_SRC/packages/core"
"$HOST_BUN" add @parcel/watcher-linux-arm64-glibc@2.5.1 --optional 2>&1 || true
cd "$OPENCODE_SRC"

# If bun didn't download the file, download and extract it manually
PARCEL_ARM64_DIR=""
while IFS= read -r f; do
    if [ -d "$(dirname "$f")" ]; then
        PARCEL_ARM64_DIR="$(dirname "$f")"
        break
    fi
done < <(find "$OPENCODE_SRC" "$OPENCODE_PKG" -name "watcher.node" -path "*parcel*arm64*" 2>/dev/null)

if [ -z "$PARCEL_ARM64_DIR" ]; then
    echo "    bun add did not download the file, fetching manually..."
    PARCEL_ARM64_DIR="${OPENCODE_SRC}/node_modules/@parcel/watcher-linux-arm64-glibc"
    mkdir -p "$PARCEL_ARM64_DIR"
    TMP_TGZ="${TMPDIR:-/tmp}/parcel-arm64.tgz"
    curl -fsSL "https://registry.npmjs.org/@parcel/watcher-linux-arm64-glibc/-/watcher-linux-arm64-glibc-2.5.1.tgz" -o "$TMP_TGZ"
    tar xzf "$TMP_TGZ" -C "$PARCEL_ARM64_DIR" --strip-components=1
    rm -f "$TMP_TGZ"
    echo "    Extracted to $PARCEL_ARM64_DIR"
fi

# Copy ARM64 watcher.node into the x64 package so bundler embeds it
echo ">>> Searching for @parcel/watcher packages..."
PARCEL_ARM64=""
PARCEL_X64=""

# First try custom-built watcher.node (built from source with NDK for Android libc++)
CUSTOM_WATCHER="$WORK_DIR/watcher-build/watcher.node"
if [ -f "$CUSTOM_WATCHER" ]; then
    PARCEL_ARM64="$CUSTOM_WATCHER"
    echo "    Using custom-built watcher.node: $CUSTOM_WATCHER"
fi

# Find ARM64 package from npm
if [ -z "$PARCEL_ARM64" ]; then
    while IFS= read -r f; do
        if [ -f "$f" ]; then
            PARCEL_ARM64="$f"
            echo "    Found ARM64 (npm): $f"
            break
        fi
    done < <(find "$OPENCODE_SRC" "$OPENCODE_PKG" -name "watcher.node" -path "*parcel*arm64*" 2>/dev/null)
fi

# Find x64 glibc package
while IFS= read -r f; do
    if [ -f "$f" ]; then
        PARCEL_X64="$f"
        echo "    Found x64: $f"
        break
    fi
done < <(find "$OPENCODE_SRC" "$OPENCODE_PKG" -name "watcher.node" -path "*parcel*x64*glibc*" 2>/dev/null)

if [ -n "$PARCEL_ARM64" ] && [ -n "$PARCEL_X64" ]; then
    echo ">>> Swapping x64 watcher.node with ARM64 version"
    cp "$PARCEL_X64" "${PARCEL_X64}.x64.bak"
    cp "$PARCEL_ARM64" "$PARCEL_X64"
    echo "    $PARCEL_X64 replaced with ARM64 version"
elif [ -n "$PARCEL_ARM64" ]; then
    echo ">>> ARM64 watcher.node found but no x64 glibc package to replace"
else
    echo ">>> WARNING: ARM64 @parcel/watcher not found, watcher will use polling fallback"
fi

# Find the Android bun binary
ANDROID_BUN="$BUN_BUILD/bun"
if [ ! -f "$ANDROID_BUN" ]; then
    echo "ERROR: Android bun binary not found at $ANDROID_BUN"
    echo "       Run scripts/build-bun.sh first."
    exit 1
fi

# Find ARM64 libopentui.so
# build.zig installs to ../lib/{target} relative to the zig dir
ARM64_LIBOPENTUI="$OPENTUI_SRC/packages/core/src/lib/aarch64-linux-android.29/libopentui.so"
if [ ! -f "$ARM64_LIBOPENTUI" ]; then
    echo "ERROR: ARM64 libopentui.so not found at $ARM64_LIBOPENTUI"
    echo "       Run scripts/build-opentui.sh first."
    exit 1
fi

# Find x86_64 libopentui.so in node_modules and swap it
# OpenCode uses @opentui/core-linux-x64 (and possibly core-linux-x64-musl)
# which has the x86_64 version. Bun builds use musl so it may resolve to
# the musl variant. Swap BOTH to ensure the ARM64 .so is embedded.
OPENTUI_NODE_MODULE=""
for candidate in \
    "$OPENCODE_SRC/node_modules/@opentui/core-linux-x64-musl/libopentui.so" \
    "$OPENCODE_SRC/node_modules/@opentui/core-linux-x64/libopentui.so" \
    "$OPENCODE_PKG/node_modules/@opentui/core-linux-x64-musl/libopentui.so" \
    "$OPENCODE_PKG/node_modules/@opentui/core-linux-x64/libopentui.so" \
    "$OPENCODE_SRC/node_modules/.bun/@opentui+core-linux-x64-musl@*/node_modules/@opentui/core-linux-x64-musl/libopentui.so" \
    "$OPENCODE_SRC/node_modules/.bun/@opentui+core-linux-x64@*/node_modules/@opentui/core-linux-x64/libopentui.so"
do
    # Handle glob
    for f in $candidate; do
        if [ -f "$f" ]; then
            echo ">>> Swapping x86_64 libopentui.so with ARM64 version: $f"
            BACKUP_FILE="${f}.x64.bak"
            cp "$f" "$BACKUP_FILE"
            cp "$ARM64_LIBOPENTUI" "$f"
            echo "    Backed up to $BACKUP_FILE"
            if [ -z "$OPENTUI_NODE_MODULE" ]; then
                OPENTUI_NODE_MODULE="$f"
            fi
        fi
    done
done

if [ -z "$OPENTUI_NODE_MODULE" ]; then
    echo "WARNING: Could not find x86_64 libopentui.so in node_modules"
    echo "         The build may embed the wrong architecture"
fi

# Create @opentui/core-linux-arm64 for ARM64 platform detection
# @opentui/core's zig.ts does:
#   if (process.arch === "arm64") return await import("@opentui/core-linux-arm64")
# At bundle time (x86_64 host), the bundler follows the x64 code path.
# The ARM64 .so is already swapped into the x64 packages above.
# We also create the arm64 package so that if runtime code ever tries to
# import it directly, it resolves to the ARM64 .so.
if [ -n "$OPENTUI_NODE_MODULE" ]; then
    OPENTUI_X64_DIR="$(dirname "$OPENTUI_NODE_MODULE")"
    OPENTUI_ARM64_DIR="${OPENTUI_X64_DIR//linux-x64/linux-arm64}"
    if [ ! -d "$OPENTUI_ARM64_DIR" ]; then
        echo ">>> Creating @opentui/core-linux-arm64 from @opentui/core-linux-x64..."
        mkdir -p "$(dirname "$OPENTUI_ARM64_DIR")"
        cp -a "$OPENTUI_X64_DIR" "$OPENTUI_ARM64_DIR"
        # Fix package.json: update name and cpu field so Bun resolution finds it
        ARM64_PKGJSON="$OPENTUI_ARM64_DIR/package.json"
        if [ -f "$ARM64_PKGJSON" ]; then
            # Replace name field
            sed -i 's/"@opentui\/core-linux-x64"/"@opentui\/core-linux-arm64"/g' "$ARM64_PKGJSON"
            # Replace cpu field: ["x64"] -> ["arm64"] or "x64" -> "arm64"
            sed -i 's/"cpu":\["x64"\]/"cpu":["arm64"]/g' "$ARM64_PKGJSON"
            sed -i 's/"cpu":"x64"/"cpu":"arm64"/g' "$ARM64_PKGJSON"
            echo "    Fixed package.json name and cpu fields"
        fi
        # Create symlink in node_modules so Bun.build() can resolve it
        # Determine the node_modules directory that has @opentui/core-linux-x64
        if [[ "$OPENTUI_X64_DIR" == *"/node_modules/@opentui/core-linux-x64" ]]; then
            X64_NM_DIR="${OPENTUI_X64_DIR%/node_modules/@opentui/core-linux-x64}/node_modules"
            OPENTUI_ARM64_LINK="$X64_NM_DIR/@opentui/core-linux-arm64"
            if [ ! -L "$OPENTUI_ARM64_LINK" ] && [ ! -d "$OPENTUI_ARM64_LINK" ]; then
                mkdir -p "$X64_NM_DIR/@opentui"
                if [[ "$OPENTUI_ARM64_DIR" == *"/.bun/"* ]]; then
                    REL_TARGET=$(python3 -c "import os.path; print(os.path.relpath('$OPENTUI_ARM64_DIR', '$X64_NM_DIR/@opentui'))" 2>/dev/null || echo "../.bun/@opentui+core-linux-arm64@0.4.2/node_modules/@opentui/core-linux-arm64")
                    ln -sf "$REL_TARGET" "$OPENTUI_ARM64_LINK"
                else
                    ln -sf "$OPENTUI_ARM64_DIR" "$OPENTUI_ARM64_LINK"
                fi
                echo "    Created symlink: $OPENTUI_ARM64_LINK -> $(readlink "$OPENTUI_ARM64_LINK")"
            fi
        fi
        echo "    Created $OPENTUI_ARM64_DIR"
    fi
fi

# Create dist directory
mkdir -p "$DIST_DIR"

# Run the TypeScript build script
# Copy it into the OpenCode tree so Bun can resolve @opentui/solid/bun-plugin
# from node_modules (Bun resolves bare imports relative to the script file's location)
echo ">>> Building OpenCode standalone binary..."
BUILD_SCRIPT="$REPO_ROOT/scripts/build-opencode-android.ts"
BUILD_SCRIPT_LOCAL="$OPENCODE_PKG/build-opencode-android.ts"
cp "$BUILD_SCRIPT" "$BUILD_SCRIPT_LOCAL"

cd "$OPENCODE_PKG"

OPENCODE_VERSION="$OPENCODE_VERSION" \
    ANDROID_BUN="$ANDROID_BUN" \
    OUTPUT_DIR="$DIST_DIR" \
    OPENCODE_DIR="$OPENCODE_PKG" \
    "$HOST_BUN" run "$BUILD_SCRIPT_LOCAL"

# Clean up copied script
rm -f "$BUILD_SCRIPT_LOCAL"

# Restore original libopentui.so
if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then
    echo ">>> Restoring original x86_64 libopentui.so..."
    mv "$BACKUP_FILE" "$OPENTUI_NODE_MODULE"
fi

# Clean up synthetic @opentui/core-linux-arm64
if [ -n "${OPENTUI_ARM64_DIR:-}" ] && [ -d "$OPENTUI_ARM64_DIR" ]; then
    echo ">>> Cleaning up synthetic @opentui/core-linux-arm64..."
    rm -rf "$OPENTUI_ARM64_DIR"
fi
if [ -n "${OPENTUI_ARM64_LINK:-}" ] && [ -L "$OPENTUI_ARM64_LINK" ]; then
    echo ">>> Removing symlink: $OPENTUI_ARM64_LINK..."
    rm -f "$OPENTUI_ARM64_LINK"
fi

# Verify output
OPENCODE_BINARY="$DIST_DIR/opencode"
if [ ! -f "$OPENCODE_BINARY" ]; then
    echo "ERROR: OpenCode binary not found at $OPENCODE_BINARY"
    exit 1
fi

echo ""
echo "=== OpenCode build complete ==="
echo "Binary: $OPENCODE_BINARY"
echo "Size: $(du -h "$OPENCODE_BINARY" | cut -f1)"
file "$OPENCODE_BINARY"
