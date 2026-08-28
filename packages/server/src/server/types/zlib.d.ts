declare module "node:zlib" {
  export function zstdDecompressSync(buffer: Buffer): Buffer;
  export function zstdCompressSync(buffer: Buffer): Buffer;
}
