import crypto from "node:crypto";
import { shell } from "electron";
import { getProviderCredential, setProviderCredential } from "./credentials";
import { ProviderId } from "../shared/types";

/* ── Anthropic OAuth (Claude Max/Pro subscription) ── */

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

/* ── OpenAI/Codex OAuth (ChatGPT Plus/Pro subscription) ── */

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";

/* ── PKCE helpers ── */

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

async function generateChallenge(verifier: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

/* ── Stored OAuth data shape ── */

export interface OAuthData {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;           // timestamp ms
  accountId?: string;        // for codex
}

const OAUTH_KEY_PREFIX = "oauth:";

export async function getOAuthData(providerId: ProviderId): Promise<OAuthData | null> {
  const raw = await getProviderCredential(providerId);
  if (!raw?.startsWith(OAUTH_KEY_PREFIX)) return null;
  try {
    return JSON.parse(raw.slice(OAUTH_KEY_PREFIX.length)) as OAuthData;
  } catch {
    return null;
  }
}

export async function setOAuthData(providerId: ProviderId, data: OAuthData): Promise<void> {
  await setProviderCredential(providerId, OAUTH_KEY_PREFIX + JSON.stringify(data));
}

export function isOAuthCredential(credential: string): boolean {
  return credential.startsWith(OAUTH_KEY_PREFIX);
}

export function parseOAuthCredential(credential: string): OAuthData | null {
  if (!credential.startsWith(OAUTH_KEY_PREFIX)) return null;
  try {
    return JSON.parse(credential.slice(OAUTH_KEY_PREFIX.length)) as OAuthData;
  } catch {
    return null;
  }
}

/* ── Anthropic OAuth flow ── */

// Active PKCE verifiers keyed by provider
const pendingVerifiers = new Map<string, string>();

export async function startAnthropicOAuth(): Promise<{ url: string }> {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  pendingVerifiers.set("anthropic", verifier);

  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: "org:create_api_key user:profile user:inference",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  const url = `https://claude.ai/oauth/authorize?${params.toString()}`;
  await shell.openExternal(url);
  return { url };
}

export async function exchangeAnthropicCode(code: string): Promise<OAuthData> {
  const verifier = pendingVerifiers.get("anthropic");
  if (!verifier) throw new Error("No pending OAuth flow for Anthropic");
  pendingVerifiers.delete("anthropic");

  const splits = code.split("#");
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic token exchange failed (${response.status}): ${text}`);
  }

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const data: OAuthData = {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };

  await setOAuthData("anthropic", data);
  return data;
}

export async function refreshAnthropicToken(current: OAuthData): Promise<OAuthData> {
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic token refresh failed: ${response.status}`);
  }

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
  const data: OAuthData = {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };

  await setOAuthData("anthropic", data);
  return data;
}

/* ── Codex (OpenAI) device code flow ── */

export async function startCodexDeviceFlow(): Promise<{ url: string; userCode: string; deviceAuthId: string; interval: number }> {
  const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });

  if (!response.ok) throw new Error("Failed to initiate Codex device authorization");

  const data = await response.json() as {
    device_auth_id: string;
    user_code: string;
    interval: string;
  };

  const url = `${CODEX_ISSUER}/codex/device`;
  await shell.openExternal(url);

  return {
    url,
    userCode: data.user_code,
    deviceAuthId: data.device_auth_id,
    interval: Math.max(parseInt(data.interval) || 5, 1) * 1000,
  };
}

export async function pollCodexDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  signal?: AbortSignal
): Promise<OAuthData> {
  const interval = 6000; // poll every 6s

  for (let i = 0; i < 50; i++) { // 5 min max
    if (signal?.aborted) throw new Error("Codex auth cancelled");

    await new Promise((resolve) => setTimeout(resolve, interval));

    const response = await fetch(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });

    if (response.ok) {
      const tokenData = await response.json() as {
        authorization_code: string;
        code_verifier: string;
      };

      // Exchange for tokens
      const tokenResponse = await fetch(`${CODEX_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: tokenData.authorization_code,
          redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
          client_id: CODEX_CLIENT_ID,
          code_verifier: tokenData.code_verifier,
        }).toString(),
      });

      if (!tokenResponse.ok) throw new Error(`Codex token exchange failed: ${tokenResponse.status}`);

      const tokens = await tokenResponse.json() as {
        access_token: string;
        refresh_token: string;
        expires_in?: number;
        id_token?: string;
      };

      const data: OAuthData = {
        type: "oauth",
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };

      await setOAuthData("codex", data);
      return data;
    }

    // 403/404 = not yet authorized, keep polling
    if (response.status !== 403 && response.status !== 404) {
      throw new Error("Codex device auth failed");
    }
  }

  throw new Error("Codex device auth timed out");
}

export async function refreshCodexToken(current: OAuthData): Promise<OAuthData> {
  const response = await fetch(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) throw new Error(`Codex token refresh failed: ${response.status}`);

  const json = await response.json() as { access_token: string; refresh_token: string; expires_in?: number };
  const data: OAuthData = {
    type: "oauth",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000,
  };

  await setOAuthData("codex", data);
  return data;
}
