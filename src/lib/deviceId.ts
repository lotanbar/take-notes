// A stable per-device identifier, persisted locally (never synced), stamped
// into a vault's header alongside its generation counter — see VaultFile in
// types/vault.ts. Only used as metadata for now; the generation number alone
// decides which copy of a vault is newer.
const DEVICE_ID_KEY = "vault-notes:deviceId";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
