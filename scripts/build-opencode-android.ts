#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const OPENCODE_DIR = process.env.OPENCODE_DIR || (() => { throw new Error("OPENCODE_DIR env var not set") })()
const ANDROID_BUN = process.env.ANDROID_BUN || (() => { throw new Error("ANDROID_BUN env var not set") })()
const OUTPUT_DIR = process.env.OUTPUT_DIR || (() => { throw new Error("OUTPUT_DIR env var not set") })()

if (!fs.existsSync(ANDROID_BUN)) {
  console.error("Android bun binary not found at:", ANDROID_BUN)
  process.exit(1)
}

process.chdir(OPENCODE_DIR)

const VERSION = process.env.OPENCODE_VERSION || "1.17.9"
const CHANNEL = process.env.OPENCODE_CHANNEL || "latest"

console.log(`Building OpenCode v${VERSION} (channel: ${CHANNEL}) for Android aarch64`)

// Step 1: Build with Bun.build() --compile for the HOST platform
// This creates a standalone binary for the host, from which we extract the module graph
console.log("\n=== Step 1: Bundling OpenCode ===")

const plugin = createSolidTransformPlugin()

// Find parser.worker.js
const localPath = path.resolve(OPENCODE_DIR, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(OPENCODE_DIR, "../../node_modules/@opentui/core/parser.worker.js")
let parserWorkerResolved: string
try {
  parserWorkerResolved = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
} catch {
  parserWorkerResolved = require.resolve("@opentui/core/parser.worker.js")
}
console.log(`Parser worker: ${parserWorkerResolved}`)

// Worker path updated for v1.17.9: moved from src/cli/cmd/tui/worker.ts to src/cli/tui/worker.ts
const workerPath = "./src/cli/tui/worker.ts"

const bunfsRoot = "/$bunfs/root/"
const workerRelativePath = path.relative(OPENCODE_DIR, parserWorkerResolved).replaceAll("\\", "/")

await $`rm -rf ${OUTPUT_DIR}`
await $`mkdir -p ${OUTPUT_DIR}`

const hostBinaryPath = path.join(OUTPUT_DIR, "opencode-host")

console.log("Building standalone binary for host platform...")
const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    outfile: hostBinaryPath,
    execArgv: [`--user-agent=opencode/${VERSION}`, "--use-system-ca", "--"],
  },
  entrypoints: ["./src/index.ts", parserWorkerResolved, workerPath],
  define: {
    OPENCODE_VERSION: `'${VERSION}'`,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    OPENCODE_WORKER_PATH: workerPath,
    OPENCODE_CHANNEL: `'${CHANNEL}'`,
    OPENCODE_LIBC: "",
  },
})

if (!result.success) {
  console.error("Build failed:")
  for (const msg of result.logs) {
    console.error(msg)
  }
  process.exit(1)
}

console.log(`Host standalone binary: ${hostBinaryPath}`)

// Step 2: Extract module graph from host binary
console.log("\n=== Step 2: Extracting module graph ===")

const hostBinary = await Bun.file(hostBinaryPath).arrayBuffer()
const hostBytes = new Uint8Array(hostBinary)

const TRAILER_STR = "\n---- Bun! ----\n"
const TRAILER_LEN = TRAILER_STR.length
const OFFSETS_SIZE_CONST = 40

// DEBUG: dump last 100 bytes
const debugEnd = hostBytes.length
const debugStart = Math.max(0, debugEnd - 100)
console.log(`\n=== DEBUG: last 100 bytes of host binary ===`)
console.log(`File size: ${debugEnd}`)
const debugSlice = Buffer.from(hostBytes.buffer, debugStart, debugEnd - debugStart)
for (let i = 0; i < debugSlice.length; i += 16) {
  const hex = Array.from(debugSlice.slice(i, Math.min(i+16, debugSlice.length)))
    .map(b => b.toString(16).padStart(2, '0')).join(' ')
  const ascii = Array.from(debugSlice.slice(i, Math.min(i+16, debugSlice.length)))
    .map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('')
  console.log(`  [${debugStart + i}] ${hex.padEnd(48)} ${ascii}`)
}

const trailerBuf = Buffer.from(TRAILER_STR)
const searchBuf = Buffer.from(hostBytes.buffer, hostBytes.byteOffset, hostBytes.length)

// Search for trailer dynamically (Bun v1.3.x may have extra padding after it)
const trailerPos = searchBuf.lastIndexOf(trailerBuf)
if (trailerPos < 0) {
  console.error("ERROR: Bun standalone trailer not found")
  process.exit(1)
}
const actualTrailerStart = trailerPos
const offsetsStart = actualTrailerStart - OFFSETS_SIZE_CONST

console.log(`\n=== DEBUG: trailer found at ${actualTrailerStart}, offsets start: ${offsetsStart} ===`)
const dumpStart = Math.max(0, offsetsStart - 8)
const dumpSlice = Buffer.from(hostBytes.buffer, dumpStart, actualTrailerStart + TRAILER_LEN - dumpStart)
console.log(`Trailer text: ${searchBuf.toString('utf8', actualTrailerStart, actualTrailerStart + TRAILER_LEN)}`)
console.log(`Last 8 bytes (total_size u64): ${Array.from(searchBuf.slice(debugEnd-8, debugEnd)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`)
console.log(`Total size as u64: ${Number(searchBuf.readBigUInt64LE(debugEnd-8))}`)

const offsetsByteCount = Number(searchBuf.readBigUInt64LE(offsetsStart))
console.log(`Raw byte_count: ${offsetsByteCount}`)
console.log(`byte_count hex: ${Array.from(searchBuf.slice(offsetsStart, offsetsStart+8)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`)

const moduleGraphSize = offsetsByteCount + OFFSETS_SIZE_CONST + TRAILER_LEN
const hostBunSize = actualTrailerStart - offsetsByteCount - OFFSETS_SIZE_CONST

console.log(`Host standalone size: ${hostBytes.length}`)
console.log(`Derived host bun size: ${hostBunSize}`)
console.log(`Module graph size: ${moduleGraphSize}`)

if (hostBunSize <= 0) {
  console.error(`ERROR: Derived host bun size is ${hostBunSize} — something is wrong`)
  process.exit(1)
}

const moduleGraphBytes = hostBytes.slice(hostBunSize, hostBunSize + moduleGraphSize)
console.log(`Module graph extracted: ${moduleGraphBytes.length} bytes`)
console.log(`Trailer verified: OK`)

// Step 3: Patch the module graph for Android
console.log("\n=== Step 3: Patching module graph for Android ===")

const mgTrailer = "\n---- Bun! ----\n"
const mgTrailerBuf = Buffer.from(mgTrailer)
const OFFSETS_SIZE = 40

const mgBuf = Buffer.from(moduleGraphBytes)
const trailerPosInMg = mgBuf.lastIndexOf(mgTrailerBuf)
if (trailerPosInMg < 0) throw new Error("Trailer not found in module graph!")

const mgOffsetsStart = trailerPosInMg - OFFSETS_SIZE
const byteCount = Number(mgBuf.readBigUInt64LE(mgOffsetsStart))
const modOff = mgBuf.readUInt32LE(mgOffsetsStart + 8)
const modLen = mgBuf.readUInt32LE(mgOffsetsStart + 12)
const entryId = mgBuf.readUInt32LE(mgOffsetsStart + 16)

console.log(`Module graph: trailer at ${trailerPosInMg}, offsets at ${mgOffsetsStart}`)
console.log(`byte_count=${byteCount}, modules_ptr=(${modOff},${modLen}), entry_id=${entryId}`)
console.log(`String data region: [0, ${modOff}), Module list: [${modOff}, ${modOff + modLen})`)

const UNDICI_SEARCH  = Buffer.from('__reExport(exports_Undici, undici)')
const UNDICI_REPLACE = Buffer.from('__reExport(exports_Undici, Undici)')
console.log(`\nPatch 1: Replacing undici->Undici in string data (same size, no offset changes)`)

let undiciPatchCount = 0
let searchPos = 0
const strDataRegion = mgBuf.slice(0, modOff)
while (true) {
  const pos = strDataRegion.indexOf(UNDICI_SEARCH, searchPos)
  if (pos < 0) break
  console.log(`  Found at string data offset ${pos}, replacing...`)
  UNDICI_REPLACE.copy(mgBuf, pos)
  undiciPatchCount++
  searchPos = pos + UNDICI_SEARCH.length
}
if (undiciPatchCount === 0) {
  console.error("WARNING: __reExport(exports_Undici, undici) not found — skipping Patch 1")
} else {
  console.log(`  Patched ${undiciPatchCount} occurrence(s)`)
}

var finalModuleGraph = mgBuf.slice(0, trailerPosInMg + mgTrailerBuf.length)
console.log(`Module graph size: ${finalModuleGraph.length} bytes (unchanged)`)

// Step 4: Create Android standalone binary
console.log("\n=== Step 4: Creating Android standalone binary ===")

const androidBunBytes = new Uint8Array(await Bun.file(ANDROID_BUN).arrayBuffer())
const androidBunSize = androidBunBytes.length
console.log(`Android bun size: ${androidBunSize}`)

const newTotalByteCount = androidBunSize + finalModuleGraph.length + 8

const outputSize = androidBunSize + finalModuleGraph.length + 8
const output = new Uint8Array(outputSize)

output.set(androidBunBytes, 0)
output.set(new Uint8Array(finalModuleGraph.buffer, finalModuleGraph.byteOffset, finalModuleGraph.length), androidBunSize)

const totalView = new DataView(output.buffer, outputSize - 8, 8)
totalView.setUint32(0, newTotalByteCount & 0xFFFFFFFF, true)
totalView.setUint32(4, Math.floor(newTotalByteCount / 0x100000000), true)

const androidOutputPath = path.join(OUTPUT_DIR, "opencode")
await Bun.write(androidOutputPath, output)
fs.chmodSync(androidOutputPath, 0o755)

console.log(`\nAndroid standalone binary: ${androidOutputPath}`)
console.log(`Size: ${(outputSize / 1024 / 1024).toFixed(1)} MB`)

const verifyBytes = new Uint8Array(await Bun.file(androidOutputPath).arrayBuffer())
const verifyView = new DataView(verifyBytes.buffer, verifyBytes.length - 8, 8)
const verifyTotal = verifyView.getUint32(0, true) + verifyView.getUint32(4, true) * 0x100000000
console.log(`Verification: total_byte_count=${verifyTotal}, file_size=${verifyBytes.length}, match=${verifyTotal === verifyBytes.length}`)

const elfMagic = String.fromCharCode(verifyBytes[0], verifyBytes[1], verifyBytes[2], verifyBytes[3])
console.log(`ELF magic: ${elfMagic === "\x7fELF" ? "OK" : "INVALID"}`)

console.log("\n=== Build complete! ===")
console.log(`Output: ${androidOutputPath}`)
