import keytar from "keytar";
import { ProviderId } from "../shared/types";

const SERVICE = "sncode.providers";

export async function setProviderCredential(providerId: ProviderId, credential: string) {
  await keytar.setPassword(SERVICE, providerId, credential);
}

export async function getProviderCredential(providerId: ProviderId) {
  return keytar.getPassword(SERVICE, providerId);
}

export async function deleteProviderCredential(providerId: ProviderId) {
  return keytar.deletePassword(SERVICE, providerId);
}

/** Remove all stored provider credentials */
export async function clearAllCredentials() {
  const providerIds: ProviderId[] = ["anthropic", "codex"];
  for (const id of providerIds) {
    try { await keytar.deletePassword(SERVICE, id); } catch { /* ignore */ }
  }
}
