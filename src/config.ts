function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const publicUrl = required("PUBLIC_URL").replace(/\/$/, "");
const tokenSecret = required("TOKEN_SECRET");
if (tokenSecret.length < 32) {
  console.error("TOKEN_SECRET must be at least 32 characters (try: openssl rand -hex 32)");
  process.exit(1);
}

const mcpBearerToken = process.env.MCP_BEARER_TOKEN || "";
if (mcpBearerToken && mcpBearerToken.length < 32) {
  console.error("MCP_BEARER_TOKEN must be at least 32 characters if set (try: openssl rand -hex 32)");
  process.exit(1);
}

const off = (v: string | undefined) => /^(0|false|no|off)$/i.test((v ?? "").trim());

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl,
  instaboxApiKey: required("INSTABOX_API_KEY"),
  instaboxApiUrl: (process.env.INSTABOX_API_URL || "https://api.instabox.sh").replace(/\/$/, ""),
  authPassword: required("AUTH_PASSWORD"),
  tokenSecret,
  accessTokenTtl: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600),
  refreshTokenTtl: Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 30),
  /** Longest a tool waits on an operation before handing back its ID (web clients time out ~60s). */
  maxWaitSeconds: Number(process.env.MAX_WAIT_SECONDS || 45),
  /** Optional static bearer for scripts, curl and Claude Code. Empty = OAuth only. */
  mcpBearerToken,
  /** Accept HTTPS-URL client_ids (Client ID Metadata Documents). On by default. */
  cimdEnabled: !off(process.env.CIMD_ENABLED),
  /** Optional allowlist of metadata document hosts, e.g. "claude.ai,*.example.com". Empty = any public host. */
  cimdAllowedHosts: (process.env.CIMD_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};
