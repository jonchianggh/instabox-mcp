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
};
