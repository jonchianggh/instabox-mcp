/**
 * Single-user OAuth 2.1 authorization server for MCP clients (Claude.ai, ChatGPT, etc.).
 *
 * Fully stateless: client registrations, authorization codes and tokens are HMAC-signed
 * blobs, so restarts and redeploys never log you out. Rotate TOKEN_SECRET to revoke everything.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.js";

type Kind = "client" | "code" | "access" | "refresh" | "secret";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (kind: Kind, data: string) => createHmac("sha256", config.tokenSecret).update(`${kind}.${data}`).digest("base64url");

function sign(kind: Kind, payload: object): string {
  const data = b64(JSON.stringify(payload));
  return `${data}.${mac(kind, data)}`;
}

function verify<T extends { exp?: number }>(kind: Kind, token: string): T | null {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = Buffer.from(mac(kind, data));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as T;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function passwordMatches(input: string): boolean {
  const a = createHmac("sha256", "pw").update(input).digest();
  const b = createHmac("sha256", "pw").update(config.authPassword).digest();
  return timingSafeEqual(a, b);
}

const now = () => Math.floor(Date.now() / 1000);

// ---------- Clients (dynamic client registration, stored inside the client_id)
const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId) {
    const meta = verify<Omit<OAuthClientInformationFull, "client_id"> & { exp?: number }>("client", clientId);
    if (!meta) return undefined;
    const client: OAuthClientInformationFull = { ...meta, client_id: clientId };
    if (meta.token_endpoint_auth_method !== "none") client.client_secret = mac("secret", clientId);
    return client;
  },
  registerClient(client) {
    const { client_secret, client_secret_expires_at, ...meta } = client;
    const stored = { ...meta, client_id_issued_at: now() };
    const client_id = sign("client", stored);
    const full: OAuthClientInformationFull = { ...stored, client_id };
    if (stored.token_endpoint_auth_method !== "none") {
      full.client_secret = mac("secret", client_id);
      full.client_secret_expires_at = 0;
    }
    return full;
  },
};

// ---------- Authorization codes: signed, short-lived, single use (per process)
interface CodePayload {
  cid: string; // hash of client_id
  ch: string; // PKCE code_challenge
  ru: string; // redirect_uri
  sc: string[];
  res?: string;
  exp: number;
  n: string;
}
const usedCodes = new Map<string, number>();
const cidHash = (clientId: string) => mac("client", clientId).slice(0, 22);

export function issueAuthorizationCode(clientId: string, params: AuthorizationParams): string {
  return sign("code", {
    cid: cidHash(clientId),
    ch: params.codeChallenge,
    ru: params.redirectUri,
    sc: params.scopes ?? [],
    res: params.resource?.href,
    exp: now() + 300,
    n: randomBytes(8).toString("hex"),
  } satisfies CodePayload);
}

function readCode(clientId: string, code: string): CodePayload {
  const p = verify<CodePayload>("code", code);
  if (!p || p.cid !== cidHash(clientId)) throw new InvalidGrantError("Invalid or expired authorization code");
  return p;
}

// ---------- Tokens
interface TokenPayload {
  cid: string;
  sc: string[];
  res?: string;
  exp: number;
}

function issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
  const base = { cid: clientId.length > 64 ? cidHash(clientId) : clientId, sc: scopes, res: resource };
  return {
    access_token: sign("access", { ...base, exp: now() + config.accessTokenTtl }),
    refresh_token: sign("refresh", { ...base, exp: now() + config.refreshTokenTtl }),
    token_type: "bearer",
    expires_in: config.accessTokenTtl,
    scope: scopes.join(" ") || undefined,
  };
}

// ---------- Login page
/** CSP for the login page. Browsers apply form-action to the redirect that follows the POST,
 *  so the client's redirect_uri origin must be allowed or the browser silently drops it. */
export function loginCsp(redirectUri?: string): string {
  let origin = "";
  try {
    if (redirectUri) origin = " " + new URL(redirectUri).origin;
  } catch {}
  return `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${origin}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function loginPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>InstaBox MCP · Sign in</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0c;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#18181b;padding:2rem;border-radius:12px;width:min(340px,90vw)}h1{font-size:1.1rem;margin:0 0 .25rem}
p{color:#a1a1aa;font-size:.85rem;margin:0 0 1.25rem}input[type=password]{width:100%;box-sizing:border-box;padding:.7rem;border-radius:8px;border:1px solid #3f3f46;background:#09090b;color:#eee;font-size:1rem}
button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#fafafa;color:#09090b;font-weight:600;font-size:1rem;cursor:pointer}
.err{color:#f87171;margin-top:.75rem;font-size:.85rem}</style></head>
<body><form method="post" action="/authorize/login">
<h1>InstaBox MCP</h1><p>${esc(fields.client_name || "An MCP client")} wants to control your InstaBox machines.</p>
${hidden}<input type="password" name="password" placeholder="Password" autofocus required>
<button type="submit">Allow</button>${error ? `<div class="err">${esc(error)}</div>` : ""}</form></body></html>`;
}

// ---------- Provider
export const provider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", loginCsp(params.redirectUri));
    res.type("html").send(
      loginPage({
        client_id: client.client_id,
        client_name: client.client_name ?? "",
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? "",
        scope: (params.scopes ?? []).join(" "),
        resource: params.resource?.href ?? "",
      }),
    );
  },

  async challengeForAuthorizationCode(client, code) {
    return readCode(client.client_id, code).ch;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const p = readCode(client.client_id, code);
    if (redirectUri && redirectUri !== p.ru) throw new InvalidGrantError("redirect_uri mismatch");
    if (usedCodes.has(p.n)) throw new InvalidGrantError("Authorization code already used");
    usedCodes.set(p.n, p.exp);
    for (const [n, exp] of usedCodes) if (exp < now()) usedCodes.delete(n);
    return issueTokens(client.client_id, p.sc, p.res);
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const p = verify<TokenPayload>("refresh", refreshToken);
    const cid = client.client_id.length > 64 ? cidHash(client.client_id) : client.client_id;
    if (!p || p.cid !== cid) throw new InvalidGrantError("Invalid or expired refresh token");
    return issueTokens(client.client_id, scopes?.length ? scopes : p.sc, p.res);
  },

  async verifyAccessToken(token): Promise<AuthInfo> {
    const p = verify<TokenPayload>("access", token);
    if (!p) throw new InvalidTokenError("Invalid or expired access token");
    return { token, clientId: p.cid, scopes: p.sc, expiresAt: p.exp, resource: p.res ? new URL(p.res) : undefined };
  },
};
