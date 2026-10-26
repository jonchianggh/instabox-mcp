/**
 * Org Secrets: encrypted credentials stored in your InstaBox org and delivered to machines.
 *
 * Two delivery modes:
 *   - proxy: the machine only ever sees a placeholder; InstaBox's egress proxy swaps in the real
 *            value on HTTPS requests to the allowed hosts. The value never enters the machine.
 *   - env:   the real value is installed as an environment variable in machines that select it.
 *
 * Reads return metadata only, never values. Writing or deleting values needs the org owner/admin
 * key (workspace:admin); a personal org key gets 403 missing_scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "./instabox.js";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
    }
  };
}

let cachedOrgId: string | undefined;
async function orgId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (!cachedOrgId) {
    const me = await api<{ orgId?: string }>("GET", "/v1/me");
    if (!me.orgId) throw new Error("Could not determine your org ID from /v1/me; pass orgId.");
    cachedOrgId = me.orgId;
  }
  return cachedOrgId;
}

const o = async (id?: string) => `/v1/orgs/${encodeURIComponent(await orgId(id))}/secrets`;
const m = (id: string) => `/v1/machines/${encodeURIComponent(id)}/secrets`;

export const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).describe("Environment-variable style name, e.g. OPENAI_API_KEY");
const orgArg = z.string().optional().describe("Org ID; defaults to the API key's org");
const delivery = z.enum(["proxy", "env"]).describe(
  "proxy: machine sees only a placeholder and the real value is injected on HTTPS requests to `hosts` (safest). env: real value as an environment variable in machines that select it.",
);
const hosts = z.array(z.string()).max(32).optional().describe(
  'Proxy only: exact hostnames the credential may be sent to (e.g. ["api.openai.com"]), or ["*"] for any public HTTPS host. Omit for env.',
);
export const proxySelection = z.union([z.literal("all"), z.array(secretName)]).describe('Proxy Secrets for this machine: "all" (current and future) or a list of names; [] selects none');
export const envSelection = z.array(secretName).describe("Env Secrets to install as environment variables; [] clears");

const VALUE_WARNING =
  "The value passes through this chat, so prefer the InstaBox dashboard or CLI for high-value credentials. The value is never returned.";
const readOnly = { readOnlyHint: true, openWorldHint: true };
const destructive = { destructiveHint: true, openWorldHint: true };

export function registerSecretTools(server: McpServer) {
  server.registerTool("list_secrets", {
    description: "List your org's Secrets: names, delivery mode, allowed hosts, size and version. Never values.",
    inputSchema: { orgId: orgArg },
    annotations: readOnly,
  }, handler(async ({ orgId: id }) => api("GET", await o(id))));

  server.registerTool("set_secret", {
    description: `Create or replace an org Secret (owner/admin API key required). ${VALUE_WARNING}`,
    inputSchema: { name: secretName, value: z.string().min(1).max(65536), delivery, hosts, orgId: orgArg },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, handler(async ({ name, value, delivery, hosts, orgId: id }) =>
    api("PUT", `${await o(id)}/${encodeURIComponent(name)}`, {
      body: { value, delivery, ...(delivery === "proxy" && hosts?.length ? { hosts } : {}) },
    })));

  server.registerTool("import_secrets", {
    description: `Create or replace several org Secrets at once, atomically, all with the same delivery mode and hosts (owner/admin key required). Names not listed stay unchanged. ${VALUE_WARNING}`,
    inputSchema: {
      values: z.record(secretName, z.string().min(1)).describe("Map of NAME to value"),
      delivery,
      hosts,
      orgId: orgArg,
    },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, handler(async ({ values, delivery, hosts, orgId: id }) =>
    api("POST", `${await o(id)}/import`, {
      body: { values, delivery, ...(delivery === "proxy" && hosts?.length ? { hosts } : {}) },
    })));

  server.registerTool("delete_secret", {
    description: "Delete an org Secret and its machine grants (owner/admin key required). Proxy access stops within 60s; env copies already in machines, files or snapshots remain.",
    inputSchema: { name: secretName, orgId: orgArg },
    annotations: destructive,
  }, handler(async ({ name, orgId: id }) => {
    await api("DELETE", `${await o(id)}/${encodeURIComponent(name)}`);
    return `Secret ${name} deleted.`;
  }));

  server.registerTool("get_machine_secrets", {
    description: "Which Secrets a machine has selected, and whether the proxy and the machine have applied them.",
    inputSchema: { id: z.string().describe("Machine ID (m_...) or name") },
    annotations: readOnly,
  }, handler(({ id }) => api("GET", m(id))));

  server.registerTool("set_machine_secrets", {
    description: "Choose which existing org Secrets a machine gets. Each field you pass replaces that whole list; omit a field to keep it. Then call refresh_machine_secrets on a running machine.",
    inputSchema: {
      id: z.string().describe("Machine ID (m_...) or name"),
      secrets: proxySelection.optional(),
      envSecrets: envSelection.optional(),
    },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, handler(({ id, secrets, envSecrets }) => {
    if (secrets === undefined && envSecrets === undefined) throw new Error("Pass secrets and/or envSecrets.");
    return api("PATCH", m(id), { body: { ...(secrets !== undefined ? { secrets } : {}), ...(envSecrets !== undefined ? { envSecrets } : {}) } });
  }));

  server.registerTool("refresh_machine_secrets", {
    description: "Push the current Secret selections into a running machine (env values, proxy placeholders, CA). Already running processes must restart to see new env values.",
    inputSchema: { id: z.string().describe("Machine ID (m_...) or name") },
    annotations: { openWorldHint: true },
  }, handler(({ id }) => api("POST", m(id))));
}
