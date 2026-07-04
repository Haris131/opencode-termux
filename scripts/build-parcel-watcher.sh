#!/usr/bin/env bash
# Cross-compile @parcel/watcher for Android aarch64 using NDK clang++
#
# This builds a .node native addon (N-API) that provides inotify-based
# file watching for Android/Termux. The npm prebuilt package uses libstdc++
# (glibc), but Android/Bionic only has libc++. Building from source with
# NDK clang++ produces a compatible binary.
#
# Requirements: Android NDK, node-addon-api headers

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

WATCHER_SRC="$WORK_DIR/watcher-src"
WATCHER_VERSION="v2.5.1"
WATCHER_OUT="$WORK_DIR/watcher-build"
NDK_CC="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android${ANDROID_API}-clang"
NDK_CXX="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android${ANDROID_API}-clang++"
NDK_STRIP="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
SYSROOT="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/sysroot"

echo "=== Building @parcel/watcher ${WATCHER_VERSION} for Android aarch64 ==="

# Clone watcher if needed
if [ ! -d "$WATCHER_SRC/.git" ]; then
    echo ">>> Cloning @parcel/watcher..."
    git clone --depth 1 --branch "$WATCHER_VERSION" https://github.com/parcel-bundler/watcher.git "$WATCHER_SRC"
else
    echo ">>> Watcher source exists at $WATCHER_SRC"
fi

cd "$WATCHER_SRC"

# Install node-addon-api for N-API headers
NAPI_DIR="$WATCHER_SRC/node_modules/node-addon-api"
if [ ! -d "$NAPI_DIR" ]; then
    echo ">>> Installing node-addon-api..."
    npm install node-addon-api 2>/dev/null || {
        mkdir -p "$NAPI_DIR"
        curl -fsSL "https://registry.npmjs.org/node-addon-api/-/node-addon-api-7.0.0.tgz" | tar xz --strip-components=1 -C "$NAPI_DIR"
    }
fi
NAPI_INCLUDE=$(cd "$NAPI_DIR" && pwd)
echo "    N-API headers: $NAPI_INCLUDE"

# Find node_api.h - check system node headers, node-addon-api, and bun include
NODE_API_DIR=""
for candidate in \
    "/usr/include/node" \
    "$NAPI_INCLUDE" \
    "$(dirname "$(which bun 2>/dev/null || echo /usr/local/bin/bun)")/../include/node" \
    "$(bun --revision 2>/dev/null && echo /usr/include/node || echo)"
do
    if [ -d "$candidate" ] && [ -f "$candidate/node_api.h" ]; then
        NODE_API_DIR="$candidate"
        break
    fi
done

# If not found, download from Node.js
if [ -z "$NODE_API_DIR" ]; then
    echo ">>> Downloading N-API headers from Node.js..."
    NODE_API_DIR="$WATCHER_SRC/napi-headers"
    mkdir -p "$NODE_API_DIR"
    NODE_VERSION="v20.11.0"
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-headers.tar.gz" | tar xz --strip-components=2 -C "$NODE_API_DIR"
    # Also check nested path if strip-components didn't work as expected
    if [ ! -f "$NODE_API_DIR/node_api.h" ]; then
        NESTED=$(find "$NODE_API_DIR" -name "node_api.h" -type f 2>/dev/null | head -1)
        if [ -n "$NESTED" ]; then
            cp "$NESTED" "$NODE_API_DIR/node_api.h"
            cp "$(dirname "$NESTED")/node_api_types.h" "$NODE_API_DIR/node_api_types.h" 2>/dev/null || true
            cp "$(dirname "$NESTED")/js_native_api.h" "$NODE_API_DIR/js_native_api.h" 2>/dev/null || true
            cp "$(dirname "$NESTED")/js_native_api_types.h" "$NODE_API_DIR/js_native_api_types.h" 2>/dev/null || true
        fi
    fi
fi
echo "    node_api.h dir: $NODE_API_DIR"

# Setup build output
mkdir -p "$WATCHER_OUT"

# Source files for Linux/Android
SOURCES=(
    src/binding.cc
    src/Watcher.cc
    src/Backend.cc
    src/DirTree.cc
    src/Glob.cc
    src/Debounce.cc
    src/watchman/BSER.cc
    src/watchman/WatchmanBackend.cc
    src/shared/BruteForceBackend.cc
    src/linux/InotifyBackend.cc
    src/unix/legacy.cc
)

# Compiler flags
COMMON_CFLAGS="-std=c++17 -O2 -fPIC -DNAPI_DISABLE_CPP_EXCEPTIONS -DINOTIFY -DBRUTE_FORCE -DWATCHMAN"
INCLUDES="-I$NAPI_INCLUDE -I$NODE_API_DIR -Isrc -Isrc/linux -Isrc/shared -Isrc/watchman -Isrc/unix"
SYSROOT_FLAG="--sysroot=$SYSROOT -target aarch64-linux-android${ANDROID_API}"

echo ">>> Compiling ${#SOURCES[@]} source files..."

OBJECTS=()
for src in "${SOURCES[@]}"; do
    obj="$WATCHER_OUT/$(basename "$src" .cc).o"
    echo "    CC: $src"
    "$NDK_CXX" $COMMON_CFLAGS $INCLUDES $SYSROOT_FLAG -c "$src" -o "$obj" 2>&1
    OBJECTS+=("$obj")
done

echo ">>> Linking watcher.node..."
"$NDK_CXX" -shared -static-libstdc++ -o "$WATCHER_OUT/watcher.node" "${OBJECTS[@]}" $SYSROOT_FLAG -llog 2>&1

echo ">>> Stripping..."
"$NDK_STRIP" --strip-all "$WATCHER_OUT/watcher.node" 2>/dev/null || true

# Verify
echo ">>> Verifying..."
file "$WATCHER_OUT/watcher.node"
ls -lh "$WATCHER_OUT/watcher.node"

echo ""
echo "=== Build complete ==="
echo "Output: $WATCHER_OUT/watcher.node"
