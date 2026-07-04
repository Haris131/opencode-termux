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

const VERSION = process.env.OPENCODE_VERSION || "1.17.13"
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

// Step 4: Embed module graph as a separate PT_LOAD segment
//
// Instead of extending the existing RW PT_LOAD (which the kernel splits,
// causing SIGBUS), we add a new PT_LOAD segment for the module graph data.
// The program header table is relocated to a gap within the first LOAD segment
// to accommodate the extra PHT entry.
console.log("\n=== Step 4: Embedding module graph as separate PT_LOAD ===");

const androidBunBytes = new Uint8Array(await Bun.file(ANDROID_BUN).arrayBuffer());
console.log(`Android bun size: ${androidBunBytes.length}`);

const data = androidBunBytes.slice();
const dv = new DataView(data.buffer);

// --- ELF constants ---
const SHT_ENTRY = 64;
const PHT_ENTRY = 56;
const PT_LOAD = 1;
const PF_W = 2;

// --- Parse ELF header ---
const e_machine = dv.getUint16(0x12, true);
const e_phoff = Number(dv.getBigUint64(0x20, true));
const e_phnum = dv.getUint16(0x38, true);
const e_shoff = Number(dv.getBigUint64(0x28, true));
const e_shnum = dv.getUint16(0x3C, true);
const e_shstrndx = dv.getUint16(0x3E, true);
const page_size = e_machine === 0xB7 ? 0x10000 : 0x1000; // AARCH64 => 64KB

console.log(`ELF: e_phoff=0x${e_phoff.toString(16)} e_phnum=${e_phnum} e_shoff=0x${e_shoff.toString(16)} page_size=0x${page_size.toString(16)}`);

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
    console.log(`Found .bun section: file_offset=0x${bunSectionFileOffset.toString(16)}, index=${i}`);
    break;
  }
}
if (bunSectionIndex < 0) throw new Error(".bun section not found");

// Parse program headers: find max_vaddr_end
let rwIdx = -1;
let maxVaddrEnd = 0;
for (let i = 0; i < e_phnum; i++) {
  const po = e_phoff + i * PHT_ENTRY;
  const p_type = dv.getUint32(po, true);
  if (p_type !== PT_LOAD) continue;
  const p_flags = dv.getUint32(po + 4, true);
  const p_vaddr = Number(dv.getBigUint64(po + 0x10, true));
  const p_memsz = Number(dv.getBigUint64(po + 0x28, true));
  const vend = p_vaddr + p_memsz;
  if (vend > maxVaddrEnd) maxVaddrEnd = vend;
  if ((p_flags & PF_W) && rwIdx < 0) {
    rwIdx = i;
    console.log(`RW PT_LOAD[${i}]: va=0x${p_vaddr.toString(16)} memsz=0x${p_memsz.toString(16)}`);
  }
}
if (rwIdx < 0) throw new Error("No writable PT_LOAD found");
console.log(`max_vaddr_end = 0x${maxVaddrEnd.toString(16)}`);

// --- Discover ELF layout: scan sections for .rela.dyn and .dynamic ---
let relaDynOff = 0, relaDynSize = 0;
let dynamicOff = 0;
const sections2: Array<{name: string, offset: number, size: number, addr: number}> = [];
for (let i = 0; i < e_shnum; i++) {
  const off = e_shoff + i * SHT_ENTRY;
  const nameOff = dv.getUint32(off, true);
  let name = "";
  for (let j = shstrOff + nameOff; j < shstrOff + shstrSz && data[j] !== 0; j++)
    name += String.fromCharCode(data[j]);
  const secOff = Number(dv.getBigUint64(off + 0x18, true));
  const secSz = Number(dv.getBigUint64(off + 0x20, true));
  const secAddr = Number(dv.getBigUint64(off + 0x10, true));
  sections2.push({name, offset: secOff, size: secSz, addr: secAddr});
  if (name === ".rela.dyn") { relaDynOff = secOff; relaDynSize = secSz; }
  if (name === ".dynamic") { dynamicOff = secOff; }
}
if (!relaDynOff) throw new Error(".rela.dyn section not found");
if (!dynamicOff) throw new Error(".dynamic section not found");
console.log(`  .rela.dyn: offset=0x${relaDynOff.toString(16)} size=0x${relaDynSize.toString(16)}`);
console.log(`  .dynamic:  offset=0x${dynamicOff.toString(16)}`);

// --- Calculate new segment location ---
// Segment layout: [RELA table] [padding] [u64 header] [module graph data] [padding to page]
const headerSize = 8;
const R_AARCH64_RELATIVE = 1027;
const RELA_ENTRY_SIZE = 24;

const origRelaCount = relaDynSize / RELA_ENTRY_SIZE;
const newRelaCount = origRelaCount + 1;
const relaBytes = new Uint8Array(newRelaCount * RELA_ENTRY_SIZE);
const origRelaView = new DataView(data.buffer, data.byteOffset + relaDynOff);
for (let i = 0; i < origRelaCount; i++) {
  const srcOff = i * RELA_ENTRY_SIZE;
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff, 8)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff, true), true);
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff + 8, 8)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff + 8, true), true);
  new DataView(relaBytes.buffer, relaBytes.byteOffset + srcOff + 16, 8)
    .setBigUint64(0, origRelaView.getBigUint64(srcOff + 16, true), true);
}

const mgPayloadOff = alignUp(relaBytes.length, 8);
const bunSectionSize = headerSize + finalModuleGraph.length;
const segContentSize = mgPayloadOff + bunSectionSize;
const alignedSegSize = alignUp(segContentSize, page_size);
const newVaddr = alignUp(maxVaddrEnd, page_size);
const newFileOffset = alignUp(data.length, page_size);
console.log(`New segment: vaddr=0x${newVaddr.toString(16)} file_offset=0x${newFileOffset.toString(16)} seg_size=0x${alignedSegSize.toString(16)}`);

// Append new RELATIVE entry: r_offset=bunSectionFileOffset, r_info=RELATIVE, r_addend=newVaddr+mgPayloadOff
const newEntryOff = origRelaCount * RELA_ENTRY_SIZE;
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff, 8)
  .setBigUint64(0, BigInt(bunSectionFileOffset), true);
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff + 8, 8)
  .setBigUint64(0, BigInt(R_AARCH64_RELATIVE), true);
new DataView(relaBytes.buffer, relaBytes.byteOffset + newEntryOff + 16, 8)
  .setBigUint64(0, BigInt(newVaddr + mgPayloadOff), true);

const segBuf = new Uint8Array(alignedSegSize);
segBuf.set(relaBytes, 0);
new DataView(segBuf.buffer, segBuf.byteOffset + mgPayloadOff, 8)
  .setBigUint64(0, BigInt(finalModuleGraph.length), true);
segBuf.set(
  new Uint8Array(finalModuleGraph.buffer, finalModuleGraph.byteOffset, finalModuleGraph.length),
  mgPayloadOff + 8,
);
console.log(`Segment: RELA at +0x0 (${relaBytes.length}B), payload at +0x${mgPayloadOff.toString(16)} (${bunSectionSize}B), total=${alignedSegSize}B`);

// --- Build output file ---
const totalNewSize = newFileOffset + alignedSegSize;
const output = new Uint8Array(totalNewSize);
output.set(data, 0);
output.set(segBuf, newFileOffset);

// --- Find a gap within the first LOAD segment for PHT relocation ---
// Sort sections by offset to find gaps between consecutive sections
const sortedSects = sections2
  .filter(s => s.size > 0 && s.offset > 0)
  .sort((a, b) => a.offset - b.offset);
let newPhtOff = page_size; // default fallback
const phtNeeded = (e_phnum + 1) * PHT_ENTRY;
for (let i = 0; i < sortedSects.length - 1; i++) {
  const gapStart = sortedSects[i].offset + sortedSects[i].size;
  const gapEnd = sortedSects[i + 1].offset;
  const gapSize = gapEnd - gapStart;
  if (gapSize >= phtNeeded && gapEnd <= maxVaddrEnd) {
    newPhtOff = gapStart;
    console.log(`  Found gap: 0x${gapStart.toString(16)}-0x${gapEnd.toString(16)} (${gapSize} bytes) for PHT`);
    break;
  }
}
if (!newPhtOff || newPhtOff === page_size) {
  // Fallback: place PHT after last section in first LOAD
  console.log("  WARNING: No suitable gap found, appending PHT at end of first LOAD");
  newPhtOff = sortedSects.filter(s => s.offset < maxVaddrEnd).pop()!.offset +
              sortedSects.filter(s => s.offset < maxVaddrEnd).pop()!.size;
  newPhtOff = alignUp(newPhtOff, 8);
}

const newPhtEntryCount = e_phnum + 1;
for (let i = 0; i < e_phnum; i++) {
  const srcOff = e_phoff + i * PHT_ENTRY;
  output.set(data.slice(srcOff, srcOff + PHT_ENTRY), newPhtOff + i * PHT_ENTRY);
}
// Add new PT_LOAD entry
const newPhtDV = new DataView(output.buffer, output.byteOffset + newPhtOff + e_phnum * PHT_ENTRY, PHT_ENTRY);
newPhtDV.setUint32(0, PT_LOAD, true);
newPhtDV.setUint32(4, 6, true); // PF_R | PF_W
newPhtDV.setBigUint64(8, BigInt(newFileOffset), true);
newPhtDV.setBigUint64(0x10, BigInt(newVaddr), true);
newPhtDV.setBigUint64(0x18, BigInt(newVaddr), true);
newPhtDV.setBigUint64(0x20, BigInt(alignedSegSize), true);
newPhtDV.setBigUint64(0x28, BigInt(alignedSegSize), true);
newPhtDV.setBigUint64(0x30, BigInt(page_size), true);

// Update ELF header
new DataView(output.buffer, 0x20, 8).setBigUint64(0, BigInt(newPhtOff), true);
new DataView(output.buffer, 0x38, 2).setUint16(0, newPhtEntryCount, true);

// Update PT_PHDR entry (PHT[0]) to reflect new PHT location
const ptPhdrDV = new DataView(output.buffer, output.byteOffset + newPhtOff, PHT_ENTRY);
ptPhdrDV.setBigUint64(8, BigInt(newPhtOff), true);
ptPhdrDV.setBigUint64(0x10, BigInt(newPhtOff), true);
ptPhdrDV.setBigUint64(0x20, BigInt(newPhtEntryCount * PHT_ENTRY), true);

console.log(`PHT relocated: 0x${e_phoff.toString(16)} -> 0x${newPhtOff.toString(16)}, entries: ${e_phnum} -> ${newPhtEntryCount}`);

// --- Update DT_RELA and DT_RELASZ in dynamic section (discovered offset) ---
// Scan the .dynamic section for DT_RELA (tag 7) and DT_RELASZ (tag 8)
const dynCount = 31;
for (let i = 0; i < dynCount; i++) {
  const entryOff = dynamicOff + i * 16;
  const tag = Number(new DataView(output.buffer, output.byteOffset + entryOff, 8).getBigUint64(0, true));
  if (tag === 7) {
    new DataView(output.buffer, output.byteOffset + entryOff + 8, 8)
      .setBigUint64(0, BigInt(newVaddr), true);
    console.log(`DT_RELA: 0x${relaDynOff.toString(16)} -> 0x${newVaddr.toString(16)}`);
  } else if (tag === 8) {
    new DataView(output.buffer, output.byteOffset + entryOff + 8, 8)
      .setBigUint64(0, BigInt(relaBytes.length), true);
    console.log(`DT_RELASZ: 0x${(origRelaCount * RELA_ENTRY_SIZE).toString(16)} -> 0x${relaBytes.length.toString(16)}`);
  }
}

// --- Write new_vaddr at ORIGINAL .bun section location (BUN_COMPILED pointer) ---
// The dynamic linker RELATIVE relocation writes load_base + newVaddr + mgPayloadOff
// to load_base + bunSectionFileOffset. The runtime reads this as an absolute pointer
// to the module graph's u64 byte_count header.
new DataView(output.buffer, output.byteOffset + bunSectionFileOffset, 8)
  .setBigUint64(0, BigInt(newVaddr + mgPayloadOff), true);
console.log(`Wrote new_vaddr at original .bun offset 0x${bunSectionFileOffset.toString(16)}`);

// --- Update .bun section header ---
const bunShdrOff = e_shoff + bunSectionIndex * SHT_ENTRY;
const bunsDV = new DataView(output.buffer, output.byteOffset + bunShdrOff, SHT_ENTRY);
bunsDV.setBigUint64(0x18, BigInt(newFileOffset + mgPayloadOff), true); // sh_offset
bunsDV.setBigUint64(0x20, BigInt(bunSectionSize), true);              // sh_size
bunsDV.setBigUint64(0x10, BigInt(newVaddr + mgPayloadOff), true);    // sh_addr
console.log(`Section .bun: offset=0x${(newFileOffset + mgPayloadOff).toString(16)} addr=0x${(newVaddr + mgPayloadOff).toString(16)} size=0x${bunSectionSize.toString(16)}`);

// --- Write output ---
const androidOutputPath = path.join(OUTPUT_DIR, "opencode");
await Bun.write(androidOutputPath, output);
fs.chmodSync(androidOutputPath, 0o755);

console.log(`\nAndroid standalone binary: ${androidOutputPath}`);
console.log(`Size: ${(output.length / 1024 / 1024).toFixed(1)} MB`);

// --- Verification ---
const elfMagic = String.fromCharCode(output[0], output[1], output[2], output[3]);
console.log(`ELF magic: ${elfMagic === "\x7fELF" ? "OK" : "INVALID"}`);
const verifyLen = Number(new DataView(output.buffer, output.byteOffset + newFileOffset + mgPayloadOff, 8).getBigUint64(0, true));
console.log(`Module graph at new offset: ${verifyLen} bytes (expected: ${finalModuleGraph.length})`);

// Quick PHT sanity check
const verifyPhnum = new DataView(output.buffer, 0x38, 2).getUint16(0, true);
console.log(`e_phnum: ${verifyPhnum} (expected: ${newPhtEntryCount})`);

console.log("\n=== Build complete! ===");
console.log(`Output: ${androidOutputPath}`);
