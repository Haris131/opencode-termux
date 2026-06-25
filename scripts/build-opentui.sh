#!/usr/bin/env bash
# Build libopentui.so for Android aarch64
#
# Usage: ./scripts/build-opentui.sh
#
# OpenCode's TUI renderer (@opentui/core) uses a native Zig library.
# The upstream build targets aarch64-linux (musl), which fails on Android
# because getauxval cannot be resolved. We build for aarch64-linux-android.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

# Use Bun's vendored Zig if available, otherwise fall back to PATH
if [ -z "${ZIG_BIN:-}" ] && [ -f "$BUN_SRC/vendor/zig/zig" ]; then
  ZIG_BIN="$BUN_SRC/vendor/zig/zig"
elif [ -z "${ZIG_BIN:-}" ]; then
  ZIG_BIN="zig"
fi

echo "=== Building libopentui.so for Android aarch64 ==="

# Clone opentui if needed
if [ ! -d "$OPENTUI_SRC/.git" ]; then
    echo ">>> Cloning opentui at commit ${OPENTUI_COMMIT}..."
    mkdir -p "$OPENTUI_SRC"
    cd "$OPENTUI_SRC"
    git init
    git remote add origin https://github.com/anomalyco/opentui.git
    git fetch --depth=1 origin "${OPENTUI_COMMIT}"
    git checkout FETCH_HEAD
else
    echo ">>> opentui source exists at $OPENTUI_SRC"
fi

# Apply Android patches:
#   1. android-libc-link.patch: skips linkLibC/linkLibCpp for Android,
#      provides NDK paths and links system libs manually instead.
#   2. yoga-page-allocator.patch: replaces c_allocator with page_allocator
#      to remove the only direct c_allocator reference in Zig source.
echo ">>> Resetting opentui source files to pristine state..."
cd "$OPENTUI_SRC"
git checkout -- packages/core/src/zig/ 2>/dev/null || true

for patch in \
    "$REPO_ROOT/patches/opentui/android-libc-link.patch" \
    "$REPO_ROOT/patches/opentui/yoga-page-allocator.patch"
do
    if [ -f "$patch" ]; then
        patch_name=$(basename "$patch")
        echo ">>> Applying opentui patch: $patch_name..."
        if git apply --check "$patch" 2>/dev/null; then
            git apply "$patch"
            echo "    $patch_name applied successfully"
        else
            echo "    ERROR: $patch_name does not apply cleanly"
            exit 1
        fi
    fi
done

OPENTUI_ZIG_DIR="$OPENTUI_SRC/packages/core/src/zig"

if [ ! -f "$OPENTUI_ZIG_DIR/build.zig" ]; then
    echo "ERROR: build.zig not found at $OPENTUI_ZIG_DIR"
    exit 1
fi

echo ">>> Building with Zig (target: aarch64-linux-android)..."

# Ensure both NDK env vars are set for Zig's native NDK auto-detection
export ANDROID_NDK_ROOT="${ANDROID_NDK_HOME}"

cd "$OPENTUI_ZIG_DIR"

"$ZIG_BIN" build \
    -Dtarget=aarch64-linux-android \
    -Doptimize=ReleaseFast \
    --prefix . 2>&1

# The build.zig installs to dest_dir="../lib/{output_name}" relative to
# the --prefix dir.  With --prefix=. (= OPENTUI_ZIG_DIR), the .so ends
# up one directory above: packages/core/src/lib/aarch64-linux-android/
LIBOPENTUI="$OPENTUI_ZIG_DIR/../lib/aarch64-linux-android/libopentui.so"
if [ ! -f "$LIBOPENTUI" ]; then
    echo "ERROR: libopentui.so not found"
    echo "  Expected at: $LIBOPENTUI"
    echo "  Searching for any libopentui.so under opentui-src..."
    find "$OPENTUI_SRC" -name "libopentui.so" -type f 2>/dev/null || true
    exit 1
fi

echo ""
echo "=== libopentui.so build complete ==="
echo "Output: $LIBOPENTUI"
echo "Size: $(du -h "$LIBOPENTUI" | cut -f1)"
file "$LIBOPENTUI"

# Verify the .so has NEEDED: libc.so (required for Android dlopen)
if readelf -d "$LIBOPENTUI" 2>/dev/null | grep -q "NEEDED.*libc.so"; then
    echo "OK: libopentui.so has NEEDED: libc.so (required for Android)"
else
    echo "ERROR: libopentui.so is missing NEEDED: libc.so dependency"
    echo "       Android dlopen() will fail without this."
    echo "       Ensure ANDROID_NDK_HOME is set and the opentui patch was applied."
    readelf -d "$LIBOPENTUI" 2>/dev/null | grep NEEDED || echo "       (no NEEDED entries found)"
    exit 1
fi
