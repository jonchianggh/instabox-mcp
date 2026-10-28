import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { config } from "./config.js";
import { provider, passwordMatches, issueAuthorizationCode, loginPage, loginCsp } from "./auth.js";
import { registerTools } from "./tools.js";
import { registerSecretTools } from "./secrets.js";
import { registerDesktopTools } from "./desktop.js";

const VERSION = process.env.APP_VERSION || "0.4.0";
const issuerUrl = new URL(config.publicUrl);
const mcpUrl = new URL("/mcp", config.publicUrl);

const app = express();
app.set("trust proxy", 1); // behind Railway / Caddy

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

const authOptions = {
  provider,
  issuerUrl,
  resourceServerUrl: mcpUrl,
  resourceName: "InstaBox MCP",
  scopesSupported: ["mcp", "offline_access"], // ChatGPT wants offline_access advertised to keep refresh tokens
  clientRegistrationOptions: { clientSecretExpirySeconds: 0, clientIdGeneration: false },
};

// Authorization server metadata, plus the CIMD flag. Claude only uses CIMD when this flag AND
// "none" in token_endpoint_auth_methods_supported are both present; otherwise it falls back to DCR.
const asMetadata = {
  ...createOAuthMetadata(authOptions),
  ...(config.cimdEnabled ? { client_id_metadata_document_supported: true } : {}),
};
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(asMetadata);
});

// OAuth: protected resource metadata, dynamic client registration, /authorize, /token, /revoke
app.use(mcpAuthRouter(authOptions));

// Password form posts here; on success, redirect back to the client with a code.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post("/authorize/login", loginLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  const f = req.body as Record<string, string>;
  const client = f.client_id ? await Promise.resolve(provider.clientsStore.getClient(f.client_id)).catch(() => undefined) : undefined;
  const redirectOk = !!f.redirect_uri && !!client?.redirect_uris.some((r) => redirectUriMatches(f.redirect_uri, r));
  if (!client || !redirectOk || !f.code_challenge) {
    res.status(400).send("Invalid authorization request");
    return;
  }
  const { password, ...fields } = f;
  if (!passwordMatches(password ?? "")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", loginCsp(f.redirect_uri));
    res.status(401).type("html").send(loginPage(fields, "Wrong password"));
    return;
  }
  const code = issueAuthorizationCode(client.client_id, {
    codeChallenge: f.code_challenge,
    redirectUri: f.redirect_uri,
    state: f.state || undefined,
    scopes: f.scope ? f.scope.split(" ") : [],
    resource: f.resource ? new URL(f.resource) : undefined,
  });
  const target = new URL(f.redirect_uri);
  target.searchParams.set("code", code);
  if (f.state) target.searchParams.set("state", f.state);
  res.redirect(302, target.href);
});

// MCP endpoint (stateless Streamable HTTP: a fresh server per request)
const auth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

app.post("/mcp", auth, express.json({ limit: "4mb" }), async (req, res) => {
  const server = new McpServer({ name: "instabox", version: VERSION });
  registerTools(server);
  registerSecretTools(server);
  registerDesktopTools(server);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", auth, methodNotAllowed);
app.delete("/mcp", auth, methodNotAllowed);

app.listen(config.port, () => {
  console.log(`InstaBox MCP ${VERSION} listening on :${config.port}, public URL ${mcpUrl.href}`);
  console.log(
    `Auth: OAuth (DCR${config.cimdEnabled ? ` + CIMD${config.cimdAllowedHosts.length ? ` for ${config.cimdAllowedHosts.join(", ")}` : ""}` : ""})` +
      (config.mcpBearerToken ? " + static bearer (MCP_BEARER_TOKEN)" : ""),
  );
});
