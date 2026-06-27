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

const VERSION = process.env.OPENCODE_VERSION || "1.17.10"
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

// Worker path updated for v1.17.10: moved from src/cli/cmd/tui/worker.ts to src/cli/tui/worker.ts
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

// Step 2: Extract module graph from host binary (ELF .bun section)
// Bun v1.3.x on Linux embeds the module graph as an ELF .bun section (not appended at EOF).
console.log("\n=== Step 2: Extracting module graph from ELF .bun section ===")

const hostBinary = await Bun.file(hostBinaryPath).arrayBuffer()
const hostBytes = new Uint8Array(hostBinary)

// ELF64 section header reader: yields {name, offset, size}
function* readElf64Sections(data: Uint8Array) {
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46)
    throw new Error("Not a valid ELF file")
  if (data[4] !== 2) throw new Error("Only 64-bit ELF supported")

  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const e_shoff = Number(v.getBigUint64(0x28, true))
  const e_shentsize = v.getUint16(0x3A, true)
  const e_shnum = v.getUint16(0x3C, true)
  const e_shstrndx = v.getUint16(0x3E, true)

  // Read section name string table (.shstrtab)
  const shstrHdr = e_shoff + e_shstrndx * e_shentsize
  const shstrOff = Number(v.getBigUint64(shstrHdr + 0x18, true))
  const shstrSz  = Number(v.getBigUint64(shstrHdr + 0x20, true))

  for (let i = 0; i < e_shnum; i++) {
    const off = e_shoff + i * e_shentsize
    const nameOff = v.getUint32(off, true)
    let name = ""
    for (let j = shstrOff + nameOff; j < shstrOff + shstrSz && data[j] !== 0; j++) name += String.fromCharCode(data[j])
    yield {
      name,
      offset: Number(v.getBigUint64(off + 0x18, true)),
      size:   Number(v.getBigUint64(off + 0x20, true)),
    }
  }
}

// Find .bun section
let moduleGraphBytes: Uint8Array | null = null
for (const sec of readElf64Sections(hostBytes)) {
  if (sec.name === ".bun") {
    // Format: [u64 payload_len][payload bytes]
    const view = new DataView(hostBytes.buffer, hostBytes.byteOffset + sec.offset, 8)
    const payloadLen = Number(view.getBigUint64(0, true))
    moduleGraphBytes = hostBytes.slice(sec.offset + 8, sec.offset + 8 + payloadLen)
    console.log(`Found .bun section at file offset ${sec.offset}: ${payloadLen} bytes payload`)
    break
  }
}
if (!moduleGraphBytes) throw new Error(".bun section not found in host binary")
console.log(`Module graph extracted: ${moduleGraphBytes.length} bytes`)

// Step 3: Patch the module graph for Android
console.log("\n=== Step 3: Patching module graph for Android ===")

const mgTrailer = "\n---- Bun! ----\n"
const mgTrailerBuf = Buffer.from(mgTrailer)
// Bun v1.3.x Offsets struct is 32 bytes (was 40 in v1.2.x).
// Fields: byte_count(8) + modules_ptr(8) + entry_point_id(4) +
//         compile_exec_argv_ptr(8) + flags(4) = 32.
const OFFSETS_SIZE = 32

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

function alignUp(v: number, a: number): number {
  const mask = a - 1;
  return (v + mask) & ~mask;
}

// Step 4: Embed module graph into Android Bun ELF .bun section
// Full implementation of Bun's elf.zig:writeBunSection() algorithm:
//  1. Extend writable PT_LOAD to cover new data (kernel mmaps at exec)
//  2. Write payload at page-aligned VA past all existing mappings
//  3. Store new_vaddr at original BUN_COMPILED location for runtime deref
//  4. Relocate section headers and non-ALLOC sections out of the way
//  5. Update e_shoff, section headers, and PT_LOAD p_filesz/p_memsz
console.log("\n=== Step 4: Embedding module graph into ELF .bun section ===");

const androidBunBytes = new Uint8Array(await Bun.file(ANDROID_BUN).arrayBuffer());
console.log(`Android bun size: ${androidBunBytes.length}`);

const data = androidBunBytes.slice();
const dv = new DataView(data.buffer);

// --- ELF constants ---
const SHT_ENTRY = 64;
const PHT_ENTRY = 56;
const PT_LOAD = 1;
const PF_W = 2;
const SHT_NOBITS = 8;

// --- Parse ELF header ---
const e_machine = dv.getUint16(0x12, true);
const e_phoff = Number(dv.getBigUint64(0x20, true));
const e_phnum = dv.getUint16(0x38, true);
const e_shoff = Number(dv.getBigUint64(0x28, true));
const e_shnum = dv.getUint16(0x3C, true);
const e_shstrndx = dv.getUint16(0x3E, true);
const page_size = e_machine === 0xB7 ? 0x10000 : 0x1000; // AARCH64 => 64KB

// Parse .shstrtab to find .bun section by name
const shstrHdr = e_shoff + e_shstrndx * SHT_ENTRY;
const shstrOff = Number(dv.getBigUint64(shstrHdr + 0x18, true));
const shstrSz = Number(dv.getBigUint64(shstrHdr + 0x20, true));

let bunSectionFileOffset = 0;
let bunSectionIndex = -1;
for (let i = 0; i < e_shnum; i++) {
  const off = e_shoff + i * SHT_ENTRY;
  const nameOff = dv.getUint32(off, true);
  let name = "";
  for (let j = shstrOff + nameOff; j < shstrOff + shstrSz && data[j] !== 0; j++)
    name += String.fromCharCode(data[j]);
  if (name === ".bun") {
    bunSectionFileOffset = Number(dv.getBigUint64(off + 0x18, true));
    bunSectionIndex = i;
    console.log(`Found .bun section: offset=0x${bunSectionFileOffset.toString(16)}, index=${i}`);
    break;
  }
}
if (bunSectionIndex < 0) throw new Error(".bun section not found");

// Parse program headers: find writable PT_LOAD and max_vaddr_end
let rwIdx = -1, rwOff = 0, rwVA = 0, rwFilesz = 0, rwMemsz = 0;
let maxVaddrEnd = 0;
for (let i = 0; i < e_phnum; i++) {
  const po = e_phoff + i * PHT_ENTRY;
  const p_type = dv.getUint32(po, true);
  if (p_type !== PT_LOAD) continue;
  const p_flags = dv.getUint32(po + 4, true);
  const p_offset = Number(dv.getBigUint64(po + 8, true));
  const p_vaddr = Number(dv.getBigUint64(po + 0x10, true));
  const p_memsz = Number(dv.getBigUint64(po + 0x28, true));
  const vend = p_vaddr + p_memsz;
  if (vend > maxVaddrEnd) maxVaddrEnd = vend;
  if ((p_flags & PF_W) && rwIdx < 0) {
    rwIdx = i;
    rwOff = p_offset;
    rwVA = p_vaddr;
    rwFilesz = Number(dv.getBigUint64(po + 0x20, true));
    rwMemsz = p_memsz;
    console.log(`RW PT_LOAD[${i}]: off=0x${p_offset.toString(16)} va=0x${p_vaddr.toString(16)} filesz=0x${rwFilesz.toString(16)} memsz=0x${p_memsz.toString(16)}`);
  }
}
if (rwIdx < 0) throw new Error("No writable PT_LOAD found");
console.log(`max_vaddr_end = 0x${maxVaddrEnd.toString(16)}`);

// --- Calculate new data location ---
const headerSize = 8;
const newContentSize = headerSize + finalModuleGraph.length;
const alignedNewSize = alignUp(newContentSize, page_size);
const newVaddr = alignUp(maxVaddrEnd, page_size);
const offsetInSeg = newVaddr - rwVA;
const newFileOffset = rwOff + offsetInSeg;
console.log(`new_vaddr=0x${newVaddr.toString(16)} new_file_offset=0x${newFileOffset.toString(16)} aligned_size=0x${alignedNewSize.toString(16)}`);

// --- File boundaries ---
const oldRwFileEnd = rwOff + rwFilesz;
const oldFileSize = data.length;
const moveSrcStart = oldRwFileEnd;
const moveSrcEnd = oldFileSize;
const movedTailSize = moveSrcEnd - moveSrcStart;
const moveDstStart = newFileOffset + alignedNewSize;
const moveDstEnd = moveDstStart + movedTailSize;
const totalNewSize = moveDstEnd;

if (movedTailSize === 0) throw new Error("No tail to move — ELF has nothing past PT_LOAD filesz (broken binary)");

console.log(`old_rw_file_end=0x${oldRwFileEnd.toString(16)} tail=[0x${moveSrcStart.toString(16)},0x${moveSrcEnd.toString(16)})->[0x${moveDstStart.toString(16)},0x${moveDstEnd.toString(16)})`);

// --- Build output ---
const output = new Uint8Array(totalNewSize);
output.set(data, 0);

// 1. Move tail (non-ALLOC sections + section header table) — uses memmove semantics
output.copyWithin(moveDstStart, moveSrcStart, moveSrcEnd);

// 2. Zero-fill the region that becomes file-backed inside the extended PT_LOAD
output.fill(0, moveSrcStart, newFileOffset);

// 3. Write payload: [u64 LE size][data]
new DataView(output.buffer, output.byteOffset + newFileOffset, 8)
  .setBigUint64(0, BigInt(finalModuleGraph.length), true);
output.set(
  new Uint8Array(finalModuleGraph.buffer, finalModuleGraph.byteOffset, finalModuleGraph.length),
  newFileOffset + 8,
);

// 4. Zero-fill padding between payload end and relocated tail
const payloadEnd = newFileOffset + newContentSize;
if (moveDstStart > payloadEnd) output.fill(0, payloadEnd, moveDstStart);

// 5. Add R_AARCH64_RELATIVE relocation for BUN_COMPILED.size (PIE fixup)
// The Android Bun binary is PIE (ET_DYN). At runtime, load_base is random.
// The dynamic linker processes this RELATIVE relocation to write:
//   BUN_COMPILED.size = load_base + new_vaddr
// The runtime reads BUN_COMPILED.size as an absolute pointer → correct for PIE.
//
// We copy the original .rela.dyn table (52 entries) + our new entry into the
// zero-filled gap (which is in the extended RW PT_LOAD), then update DT_RELA
// and DT_RELASZ in the dynamic section to point to the new table.
const R_AARCH64_RELATIVE = 1027;
const RELA_ENTRY_SIZE = 24;

// Read original RELA table from first PT_LOAD
const origRelaOff = 0xd350;
const origRelaCount = 52; // 1248 / 24
const relaBytes = new Uint8Array((origRelaCount + 1) * RELA_ENTRY_SIZE);
const origRelaView = new DataView(data.buffer, data.byteOffset + origRelaOff);
for (let i = 0; i < origRelaCount; i++) {
  const srcOff = i * RELA_ENTRY_SIZE;
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff, RELA_ENTRY_SIZE)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff, true), true);
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff + 8, RELA_ENTRY_SIZE - 8)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff + 8, true), true);
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff + 16, RELA_ENTRY_SIZE - 16)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff + 16, true), true);
}
// Append new RELATIVE entry: r_offset=original_sh_addr, r_info=RELATIVE, r_addend=new_vaddr
const newEntryOff = origRelaCount * RELA_ENTRY_SIZE;
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff, 8)
  .setBigUint64(0, BigInt(bunSectionFileOffset), true);
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff + 8, 8)
  .setBigUint64(0, BigInt(R_AARCH64_RELATIVE), true);
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff + 16, 8)
  .setBigUint64(0, BigInt(newVaddr), true);

// Place new RELA table in the zero-filled gap (between oldRwFileEnd and newFileOffset)
// Align to 8 bytes within the gap
const relaTableFileOff = Math.min(
  Math.ceil(oldRwFileEnd / 8) * 8,
  newFileOffset - relaBytes.length,
);
if (relaTableFileOff + relaBytes.length > newFileOffset) {
  throw new Error("Zero-filled gap too small for RELA table — need " + relaBytes.length + " bytes, gap is " + (newFileOffset - oldRwFileEnd));
}
output.set(relaBytes, relaTableFileOff);
const relaTableVaddr = relaTableFileOff; // p_offset == p_vaddr for RW PT_LOAD
console.log(`RELA table: ${origRelaCount}+1 entries at file offset 0x${relaTableFileOff.toString(16)} (vaddr 0x${relaTableVaddr.toString(16)})`);

// Update DT_RELA (tag=7) and DT_RELASZ (tag=8) in dynamic section at 0x56f0000
const dynSectionOff = 0x56f0000;
const dynCount = 29;
for (let i = 0; i < dynCount; i++) {
  const entryOff = dynSectionOff + i * 16;
  const tag = Number(new DataView(output.buffer, output.byteOffset + entryOff, 8).getBigUint64(0, true));
  if (tag === 7) {
    // DT_RELA: update pointer
    new DataView(output.buffer, output.byteOffset + entryOff + 8, 8)
      .setBigUint64(0, BigInt(relaTableVaddr), true);
    console.log(`DT_RELA: 0xd350 -> 0x${relaTableVaddr.toString(16)}`);
  } else if (tag === 8) {
    // DT_RELASZ: update size (1248 -> 1272)
    new DataView(output.buffer, output.byteOffset + entryOff + 8, 8)
      .setBigUint64(0, BigInt(relaBytes.length), true);
    console.log(`DT_RELASZ: 0x${(origRelaCount * RELA_ENTRY_SIZE).toString(16)} -> 0x${relaBytes.length.toString(16)}`);
  }
}

// 6. Write new_vaddr at ORIGINAL .bun section location (BUN_COMPILED pointer)
// For PIE, the dynamic linker RELATIVE relocation will add load_base at runtime.
// The value we store now serves as the addend (relative vaddr of payload).
new DataView(output.buffer, output.byteOffset + bunSectionFileOffset, 8)
  .setBigUint64(0, BigInt(newVaddr), true);
console.log(`Wrote new_vaddr at original .bun offset 0x${bunSectionFileOffset.toString(16)}`);

// 7. Update e_shoff in ELF header
const oldShdrOff = e_shoff;
const newShdrOff = oldShdrOff + (moveDstStart - moveSrcStart);
new DataView(output.buffer, 0x28, 8).setBigUint64(0, BigInt(newShdrOff), true);
console.log(`e_shoff: 0x${oldShdrOff.toString(16)} -> 0x${newShdrOff.toString(16)}`);

// 8. Update all section headers at their new location
for (let i = 0; i < e_shnum; i++) {
  const shdv = new DataView(output.buffer, output.byteOffset + newShdrOff + i * SHT_ENTRY, SHT_ENTRY);
  const sh_type = shdv.getUint32(4, true);
  const sh_off = Number(shdv.getBigUint64(0x18, true));

  if (i === bunSectionIndex) {
    shdv.setBigUint64(0x18, BigInt(newFileOffset), true); // sh_offset
    shdv.setBigUint64(0x20, BigInt(newContentSize), true); // sh_size
    shdv.setBigUint64(0x10, BigInt(newVaddr), true);      // sh_addr
  } else if (sh_type !== SHT_NOBITS && sh_off >= moveSrcStart && sh_off < moveSrcEnd) {
    shdv.setBigUint64(0x18, BigInt(sh_off + (moveDstStart - moveSrcStart)), true);
  }
}

// 9. Extend writable PT_LOAD: p_filesz and p_memsz
const newSegSize = offsetInSeg + alignedNewSize;
const phdrDV = new DataView(output.buffer, output.byteOffset + e_phoff + rwIdx * PHT_ENTRY, PHT_ENTRY);
phdrDV.setBigUint64(0x20, BigInt(newSegSize), true); // p_filesz
phdrDV.setBigUint64(0x28, BigInt(newSegSize), true); // p_memsz
console.log(`PT_LOAD extended: filesz/memsz = 0x${newSegSize.toString(16)}`);

// --- Write output ---
const androidOutputPath = path.join(OUTPUT_DIR, "opencode");
await Bun.write(androidOutputPath, output);
fs.chmodSync(androidOutputPath, 0o755);

console.log(`\nAndroid standalone binary: ${androidOutputPath}`);
console.log(`Size: ${(output.length / 1024 / 1024).toFixed(1)} MB`);

// --- Verification ---
const elfMagic = String.fromCharCode(output[0], output[1], output[2], output[3]);
console.log(`ELF magic: ${elfMagic === "\x7fELF" ? "OK" : "INVALID"}`);
const verifyLen = Number(new DataView(output.buffer, output.byteOffset + newFileOffset, 8).getBigUint64(0, true));
console.log(`Module graph at new offset: ${verifyLen} bytes (expected: ${finalModuleGraph.length})`);

console.log("\n=== Build complete! ===");
console.log(`Output: ${androidOutputPath}`);
