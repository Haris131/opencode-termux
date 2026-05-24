// Polyfill for CompressionStream/DecompressionStream
// Bun v1.2.13 doesn't have native CompressionStream support
// Uses node:zlib sync APIs for the actual compression

if (!globalThis.CompressionStream) {
  const { gzipSync, gunzipSync, deflateSync, inflateSync } = require("node:zlib");
  const { Buffer } = require("node:buffer");

  globalThis.CompressionStream = class CompressionStream extends TransformStream {
    constructor(format) {
      const fmt = typeof format === "string" ? format : format?.type;
      const chunks = [];
      super({
        transform(chunk, controller) {
          chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        },
        flush(controller) {
          const input = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          let output;
          if (fmt === "gzip") output = gzipSync(input);
          else if (fmt === "deflate") output = deflateSync(input);
          else throw new Error(`CompressionStream: unsupported format "${fmt}"`);
          controller.enqueue(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
        },
      });
    }
  };

  globalThis.DecompressionStream = class DecompressionStream extends TransformStream {
    constructor(format) {
      const fmt = typeof format === "string" ? format : format?.type;
      const chunks = [];
      super({
        transform(chunk, controller) {
          chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
        },
        flush(controller) {
          const input = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
          let output;
          if (fmt === "gzip") output = gunzipSync(input);
          else if (fmt === "deflate") output = inflateSync(input);
          else throw new Error(`DecompressionStream: unsupported format "${fmt}"`);
          controller.enqueue(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
        },
      });
    }
  };
}
