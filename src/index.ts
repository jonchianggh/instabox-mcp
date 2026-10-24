import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { config } from "./config.js";
import { provider, passwordMatches, issueAuthorizationCode, loginPage } from "./auth.js";
import { registerTools } from "./tools.js";

const VERSION = process.env.APP_VERSION || "0.1.0";
const issuerUrl = new URL(config.publicUrl);
const mcpUrl = new URL("/mcp", config.publicUrl);

const app = express();
app.set("trust proxy", 1); // behind Railway / Caddy

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, version: VERSION });
});

// OAuth: metadata, dynamic client registration, /authorize, /token, /revoke
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "InstaBox MCP",
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, clientIdGeneration: false },
  }),
);

// Password form posts here; on success, redirect back to the client with a code.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
app.post("/authorize/login", loginLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  const f = req.body as Record<string, string>;
  const client = f.client_id ? await provider.clientsStore.getClient(f.client_id) : undefined;
  if (!client || !f.redirect_uri || !client.redirect_uris.includes(f.redirect_uri) || !f.code_challenge) {
    res.status(400).send("Invalid authorization request");
    return;
  }
  const { password, ...fields } = f;
  if (!passwordMatches(password ?? "")) {
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
});
