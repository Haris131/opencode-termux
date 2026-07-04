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

OPENCODE_PKG="$OPENCODE_SRC/packages/opencode"

# Install OpenCode dependencies
echo ">>> Installing OpenCode dependencies..."
cd "$OPENCODE_SRC"
"$HOST_BUN" install

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
