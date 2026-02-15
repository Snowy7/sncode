import keytar from "keytar";
import { ProviderId } from "../shared/types";

const SERVICE = "sncode.providers";

export async function setProviderCredential(providerId: ProviderId, credential: string) {
  await keytar.setPassword(SERVICE, providerId, credential);
}

export async function getProviderCredential(providerId: ProviderId) {
  return keytar.getPassword(SERVICE, providerId);
}
