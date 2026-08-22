import { invoke } from "@tauri-apps/api/core";

export type CompressionCodec = "none" | "deflate-9" | "brotli-11" | "zstd-22" | "lzma1-ultra" | "lzma2-ultra";
export const COMPRESSION_PROFILE_VERSION = 1;
export interface CompressionResult { codec: CompressionCodec; dataB64: string; originalSize: number; storedSize: number; savedBytes: number }
export interface CompressionBenchmarkRow { codec: CompressionCodec; originalSize: number; storedSize: number; compressionMs: number; decompressionMs: number; memoryBytes: number }
export interface CompressionBenchmark { selectedCodec: CompressionCodec; rows: CompressionBenchmarkRow[] }

function bytesToB64(bytes: Uint8Array): string { let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }
function b64ToBytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }

export async function compressText(value: string, codec: CompressionCodec): Promise<CompressionResult> {
  if (!("__TAURI_INTERNALS__" in window)) { const bytes = new TextEncoder().encode(value); return { codec: "none", dataB64: bytesToB64(bytes), originalSize: bytes.length, storedSize: bytes.length, savedBytes: 0 }; }
  return invoke<CompressionResult>("compress_note", { dataB64: bytesToB64(new TextEncoder().encode(value)), codec });
}
export async function decompressText(value: string): Promise<string> {
  if (!("__TAURI_INTERNALS__" in window)) return new TextDecoder().decode(b64ToBytes(value));
  return new TextDecoder().decode(b64ToBytes(await invoke<string>("decompress_note", { dataB64: value })));
}
export function benchmarkTextCompression(values: string[]): Promise<CompressionBenchmark> { return invoke<CompressionBenchmark>("benchmark_note_compression", { payloadsB64: values.map((value) => bytesToB64(new TextEncoder().encode(value))) }); }
