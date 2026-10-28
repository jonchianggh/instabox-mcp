/**
 * OAuth Client ID Metadata Documents (CIMD, MCP SEP-991 / draft-ietf-oauth-client-id-metadata-document).
 *
 * A client uses an HTTPS URL as its client_id; we fetch that URL to learn its name and
 * redirect_uris instead of asking it to register. Claude.ai, Claude Desktop/mobile and Claude
 * Code use this when the server advertises `client_id_metadata_document_supported`.
 *
 * The fetch is SSRF-guarded: https only, standard port, every resolved address must be public
 * (the connection is pinned to the address we checked, so DNS rebinding can't swap it),
 * no redirects, application/json only, small size and time limits.
 */
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import type { LookupFunction } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { config } from "./config.js";

const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5000;
const MIN_TTL = 300; // 5 min
const MAX_TTL = 86400; // 24 h
const DEFAULT_TTL = 3600;
const STALE_IF_ERROR = 7 * 86400; // keep serving a known-good document if a refetch fails
const NEGATIVE_TTL = 60;
const MAX_ENTRIES = 200;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when a client_id looks like a metadata document URL. */
export const isCimdClientId = (clientId: string) => clientId.startsWith("https://");

// ---------- Address checks
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false; // hex-form IPv4-mapped: refuse rather than decode
    // Note: no ::ffff:0:0/96 rule in the BlockList, since Node matches IPv4 lookups against it.
    return !blocked.check(address, "ipv6");
  }
  return false;
}

/** dns.lookup that refuses non-public answers. The socket connects to the address we approved. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (!list.length || bad) {
      const e = Object.assign(new Error(`${hostname} resolves to a non-public address (${bad?.address ?? "none"})`), { code: "ESSRF" });
      return (callback as any)(e);
    }
    if ((options as dns.LookupOptions).all) (callback as any)(null, list);
    else (callback as any)(null, list[0].address, list[0].family);
  });
};

// ---------- URL rules
function hostAllowed(host: string): boolean {
  if (!config.cimdAllowedHosts.length) return true;
  return config.cimdAllowedHosts.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h));
}

function checkClientIdUrl(clientId: string): URL {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    throw new Error("client_id is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("client_id URL must use https");
  if (u.username || u.password) throw new Error("client_id URL must not contain credentials");
  if (u.hash || clientId.includes("#")) throw new Error("client_id URL must not contain a fragment");
  if (u.pathname === "/" || !u.pathname) throw new Error("client_id URL must have a path");
  if (/(^|\/)\.\.?(\/|$)/.test(clientId.replace(/^https:\/\/[^/]+/, ""))) throw new Error("client_id URL must not contain dot segments");
  if (u.port && u.port !== "443") throw new Error("client_id URL must use the default https port");
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
    if (!isPublicAddress(u.hostname.replace(/^\[|\]$/g, ""))) throw new Error("client_id URL points at a non-public address");
  } else if (!u.hostname.includes(".") || u.hostname.endsWith(".local") || u.hostname.endsWith(".internal") || u.hostname === "localhost") {
    throw new Error("client_id URL host is not a public domain");
  }
  if (!hostAllowed(u.hostname)) throw new Error(`client_id host ${u.hostname} is not in CIMD_ALLOWED_HOSTS`);
  return u;
}

// ---------- Fetch
interface Fetched {
  body: unknown;
  maxAge?: number;
}

class FetchError extends Error {
  constructor(message: string, readonly hint = "") {
    super(message);
  }
}

function fetchDocument(url: URL): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: { accept: "application/json", "user-agent": "instabox-mcp (OAuth client metadata fetch)" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const cloudflare = /cloudflare/i.test(String(res.headers.server ?? "")) || !!res.headers["cf-ray"];
        if (status !== 200) {
          res.resume();
          const hint =
            status >= 300 && status < 400
              ? "redirects are not followed for client metadata documents"
              : cloudflare && (status === 403 || status === 503)
                ? "Cloudflare blocked the fetch from this server's IP (seen with claude.ai from datacenter IPs). Set CIMD_ENABLED=false so clients fall back to dynamic registration"
                : "";
          return reject(new FetchError(`HTTP ${status}`, hint));
        }
        const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json") {
          res.resume();
          return reject(new FetchError(`content-type ${type || "(none)"}, expected application/json`));
        }
        if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) {
          res.destroy();
          return reject(new FetchError(`document larger than ${MAX_BYTES} bytes`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new FetchError(`document larger than ${MAX_BYTES} bytes`));
          } else chunks.push(c);
        });
        res.on("end", () => {
          try {
            resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), maxAge: parseMaxAge(res.headers["cache-control"]) });
          } catch {
            reject(new FetchError("document is not valid JSON"));
          }
        });
        res.on("error", (e) => reject(new FetchError(e.message)));
      },
    );
    req.on("timeout", () => req.destroy(new FetchError(`timed out after ${TIMEOUT_MS}ms`)));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(e.message)));
    req.end();
  });
}

function parseMaxAge(header: string | undefined): number | undefined {
  if (!header) return undefined;
  if (/no-store|no-cache/i.test(header)) return MIN_TTL;
  const m = header.match(/max-age=(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

// ---------- Validation
function isLoopbackHttp(u: URL) {
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

function toClient(clientId: string, doc: unknown): OAuthClientInformationFull {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new FetchError("document is not a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new FetchError(`document client_id ${JSON.stringify(d.client_id)} does not match the URL`);
  if ("client_secret" in d || "client_secret_expires_at" in d) throw new FetchError("document must not contain a client_secret");
  const method = d.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new FetchError(`token_endpoint_auth_method ${JSON.stringify(method)} is not supported (public clients only)`);
  if (!Array.isArray(d.redirect_uris) || !d.redirect_uris.length) throw new FetchError("redirect_uris must be a non-empty array");
  const redirect_uris = d.redirect_uris.map((r) => {
    if (typeof r !== "string") throw new FetchError("redirect_uris must be strings");
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      throw new FetchError(`invalid redirect_uri ${r}`);
    }
    if (u.hash) throw new FetchError(`redirect_uri ${r} has a fragment`);
    if (u.protocol !== "https:" && !isLoopbackHttp(u)) throw new FetchError(`redirect_uri ${r} must be https or http loopback`);
    return r;
  });
  const strings = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
  const grant_types = strings(d.grant_types);
  if (grant_types && !grant_types.includes("authorization_code")) throw new FetchError("grant_types must include authorization_code");
  const response_types = strings(d.response_types);
  if (response_types && !response_types.includes("code")) throw new FetchError("response_types must include code");
  const str = (v: unknown) => (typeof v === "string" && v.length <= 200 ? v : undefined);
  return {
    client_id: clientId,
    redirect_uris,
    client_name: str(d.client_name),
    client_uri: str(d.client_uri),
    logo_uri: str(d.logo_uri),
    grant_types: grant_types?.filter((g) => g === "authorization_code" || g === "refresh_token") ?? ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: str(d.scope),
  } as OAuthClientInformationFull;
}

// ---------- Cache
interface Entry {
  client?: OAuthClientInformationFull;
  error?: string;
  freshUntil: number;
  staleUntil: number;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<OAuthClientInformationFull>>();
const nowS = () => Math.floor(Date.now() / 1000);

function remember(key: string, entry: Entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

async function load(clientId: string, url: URL, previous?: Entry): Promise<OAuthClientInformationFull> {
  try {
    const { body, maxAge } = await fetchDocument(url);
    const client = toClient(clientId, body);
    const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, maxAge ?? DEFAULT_TTL));
    remember(clientId, { client, freshUntil: nowS() + ttl, staleUntil: nowS() + ttl + STALE_IF_ERROR });
    console.log(`[cimd] loaded client metadata ${clientId} (${client.client_name ?? "unnamed"}), cached ${ttl}s`);
    return client;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = e instanceof FetchError && e.hint ? ` (${e.hint})` : "";
    if (previous?.client && previous.staleUntil > nowS()) {
      console.warn(`[cimd] refetch of ${clientId} failed: ${msg}${hint}. Serving the cached copy.`);
      return previous.client;
    }
    console.warn(`[cimd] could not load client metadata ${clientId}: ${msg}${hint}`);
    remember(clientId, { error: msg, freshUntil: nowS() + NEGATIVE_TTL, staleUntil: nowS() + NEGATIVE_TTL });
    throw new InvalidClientError(`Could not load client metadata document: ${msg}`);
  }
}

/** Resolve a URL client_id to client information. Throws InvalidClientError with a reason on failure. */
export async function getCimdClient(clientId: string): Promise<OAuthClientInformationFull> {
  let url: URL;
  try {
    url = checkClientIdUrl(clientId);
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[cimd] rejected client_id ${clientId}: ${msg}`);
    throw new InvalidClientError(msg);
  }
  const hit = cache.get(clientId);
  if (hit && hit.freshUntil > nowS()) {
    if (hit.client) return hit.client;
    throw new InvalidClientError(`Could not load client metadata document: ${hit.error}`);
  }
  let p = inflight.get(clientId);
  if (!p) {
    p = load(clientId, url, hit).finally(() => inflight.delete(clientId));
    inflight.set(clientId, p);
  }
  return p;
}
