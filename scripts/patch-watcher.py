"""Patch watcher.ts to use inotify-based shim on ARM64.

Replaces the dynamic require('@parcel/watcher-...') with a direct import
of the fs.watch shim on ARM64 platforms (including Android/Termux where
process.platform is android, not linux).
"""

import sys
import os

watcher_ts = sys.argv[1]
shim_path = sys.argv[2]

with open(watcher_ts, 'r') as f:
    content = f.read()

# Step 1: Add static import for the shim alongside existing imports
old_import = 'import { createWrapper } from "@parcel/watcher/wrapper"'
shim_relative = os.path.relpath(shim_path, os.path.dirname(watcher_ts)).replace('\\', '/')

new_import = f'''import {{ createWrapper }} from "@parcel/watcher/wrapper"
import * as PACKAGE_PARCEL_WATCHER from "./{shim_relative}"'''

if old_import in content:
    content = content.replace(old_import, new_import, 1)
    print(f"    Added shim import: ./{shim_relative}")
else:
    print(f"    WARNING: could not find '{old_import}'")

# Step 2: Modify the watcher() lazy function for ARM64 (including Android)
old_lazy = '''const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})'''

new_lazy = '''const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    // On ARM64 (including Android/Termux), use the fs.watch-based shim.
    // The native @parcel/watcher .node addon uses libstdc++ (glibc) which
    // is unavailable on Android/Bionic. The shim uses Bun's built-in fs.watch
    // which uses inotify under the hood.
    if (process.arch === "arm64" || process.arch === "aarch64") {
      return PACKAGE_PARCEL_WATCHER as typeof import("@parcel/watcher")
    }
    const libc = typeof OPENCODE_LIBC === "undefined" ? undefined : OPENCODE_LIBC
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${libc || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch {
    return
  }
})'''

if old_lazy in content:
    content = content.replace(old_lazy, new_lazy, 1)
    print("    Replaced watcher() lazy initializer with ARM64 shim support")
else:
    print("    WARNING: could not find old watcher() pattern")

with open(watcher_ts, 'w') as f:
    f.write(content)

print("    watcher.ts patched successfully")
