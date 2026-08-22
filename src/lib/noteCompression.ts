import { COMPRESSION_PROFILE_VERSION, benchmarkTextCompression, compressText, decompressText, type CompressionCodec } from "./compression";
import type { CompressionMetadata } from "../types/vault";

interface CompressedEnvelope { format: "vault-note-compressed-v1"; payload: string }
let selectedCodec: CompressionCodec = "lzma2-ultra";
export function restoreSelectedCodec(vaultId: string): void { const saved = localStorage.getItem(`vault-notes:compression-codec:${vaultId}`) as CompressionCodec | null; if (saved) selectedCodec = saved; }
export async function selectCompressionCodec(vaultId: string, payloads: string[]): Promise<CompressionCodec> { if (!payloads.length) return selectedCodec; const result = await benchmarkTextCompression(payloads); selectedCodec = result.selectedCodec; localStorage.setItem(`vault-notes:compression-codec:${vaultId}`, selectedCodec); localStorage.setItem(`vault-notes:compression-benchmark:${vaultId}`, JSON.stringify(result)); return selectedCodec; }

function bytesToHex(bytes: Uint8Array): string { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function sha256(value: string): Promise<string> { return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }

export async function packNote(plaintext: string, codec: CompressionCodec = selectedCodec): Promise<{ plaintext: string; metadata?: CompressionMetadata }> {
  const compressed = await compressText(plaintext, codec);
  if (compressed.codec === "none") return { plaintext };
  const envelope = JSON.stringify({ format: "vault-note-compressed-v1", payload: compressed.dataB64 } satisfies CompressedEnvelope);
  if (new TextEncoder().encode(envelope).length >= new TextEncoder().encode(plaintext).length) return { plaintext };
  return {
    plaintext: envelope,
    metadata: {
      codec: compressed.codec,
      profileVersion: COMPRESSION_PROFILE_VERSION,
      sourceHash: await sha256(plaintext),
      outputHash: await sha256(envelope),
      sourceSize: new TextEncoder().encode(plaintext).length,
      outputSize: new TextEncoder().encode(envelope).length,
    },
  };
}

export async function unpackNote(value: string): Promise<string> {
  let envelope: Partial<CompressedEnvelope>;
  try { envelope = JSON.parse(value); } catch { return value; }
  if (envelope.format !== "vault-note-compressed-v1" || typeof envelope.payload !== "string") return value;
  return decompressText(envelope.payload);
}
