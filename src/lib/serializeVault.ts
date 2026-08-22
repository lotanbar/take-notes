import type { VaultFile, VaultHeaderV4 } from "../types/vault";
import { encryptToB64 } from "../crypto/crypto";

export async function serializeVault(vault: VaultFile, key?: CryptoKey): Promise<string> {
  if (vault.version >= 4) {
    if (!key) throw new Error("A master key is required to encrypt a v4 vault manifest.");
    const header: VaultHeaderV4 = {
      version: 4,
      salt: vault.salt,
      kdf: { algorithm: "PBKDF2-SHA256", iterations: 250_000 },
      encryptedManifest: await encryptToB64(key, JSON.stringify(vault)),
    };
    return JSON.stringify(header);
  }
  return JSON.stringify(vault);
}
