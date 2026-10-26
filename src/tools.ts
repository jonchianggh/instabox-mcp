import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, waitForOperation, type Operation } from "./instabox.js";
import { proxySelection, envSelection } from "./secrets.js";

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

const m = (id: string) => `/v1/machines/${encodeURIComponent(id)}`;
const idArg = z.string().describe("Machine ID (m_...) or name");
const waitArg = z.boolean().default(true).describe("Wait (up to ~45s) for the operation to finish");
const readOnly = { readOnlyHint: true, openWorldHint: true };
const destructive = { destructiveHint: true, openWorldHint: true };

async function runOp(path: string, wait: boolean, body?: unknown) {
  const op = await api<Operation>("POST", path, { body, idempotent: true });
  return wait ? waitForOperation(op) : op;
}

export function registerTools(server: McpServer) {
  // ---------- Account
  server.registerTool("whoami", { description: "Who the InstaBox API key belongs to, including the machine sizes the plan allows (allowedSpecs).", annotations: readOnly },
    handler(() => api("GET", "/v1/me")));
  server.registerTool("get_usage", { description: "Machine and snapshot counts, stored data, and account limits.", annotations: readOnly },
    handler(() => api("GET", "/v1/usage")));
  server.registerTool("list_templates", { description: "Templates a machine can start from (e.g. universal, agent-browser), with their software.", annotations: readOnly },
    handler(() => api("GET", "/v1/templates")));

  // ---------- Machines
  server.registerTool("list_machines", {
    description: "List your machines, optionally filtered by metadata labels.",
    inputSchema: {
      metadata: z.array(z.string()).optional().describe('Label filters as "key:value"; all must match'),
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
    },
    annotations: readOnly,
  }, handler(({ metadata, limit, cursor }) => api("GET", "/v1/machines", { query: { metadata, limit, cursor } })));

  server.registerTool("get_machine", { description: "Get one machine by ID or name.", inputSchema: { id: idArg }, annotations: readOnly },
    handler(({ id }) => api("GET", m(id))));

  server.registerTool("create_machine", {
    description: "Create a cloud Linux VM from a template (default: universal) or one of your snapshots.",
    inputSchema: {
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("Lowercase letters, digits and -"),
      templateId: z.string().optional().describe("e.g. universal or agent-browser; give this or snapshotId"),
      snapshotId: z.string().optional(),
      guestUser: z.string().optional().describe("Linux user inside (default: user)"),
      autoSuspendAfterSeconds: z.number().int().optional(),
      metadata: z.record(z.string(), z.string()).optional().describe("String labels"),
      desiredState: z.enum(["running", "stopped"]).optional(),
      secrets: proxySelection.optional(),
      envSecrets: envSelection.optional(),
      wait: waitArg,
    },
    annotations: { openWorldHint: true },
  }, handler(async ({ wait, ...body }) => {
    if (!body.templateId && !body.snapshotId) body.templateId = "universal";
    return runOp("/v1/machines", wait, body);
  }));

  server.registerTool("update_machine", {
    description: "Change a machine's idle auto-pause, or replace its labels ({} clears them).",
    inputSchema: { id: idArg, autoSuspendAfterSeconds: z.number().int().optional(), metadata: z.record(z.string(), z.string()).optional() },
    annotations: { idempotentHint: true, openWorldHint: true },
  }, handler(({ id, ...body }) => api("PATCH", m(id), { body, idempotent: true })));

  server.registerTool("delete_machine", {
    description: "Delete a machine and all its files. Snapshots saved from it are kept. Irreversible.",
    inputSchema: { id: idArg, wait: waitArg },
    annotations: destructive,
  }, handler(async ({ id, wait }) => {
    const op = await api<Operation>("DELETE", m(id), { idempotent: true });
    return wait ? waitForOperation(op) : op;
  }));

  // ---------- Lifecycle
  server.registerTool("start_machine", { description: "Boot a stopped machine (or resume a paused one).", inputSchema: { id: idArg, wait: waitArg }, annotations: { openWorldHint: true } },
    handler(({ id, wait }) => runOp(`${m(id)}/start`, wait)));
  server.registerTool("pause_machine", { description: "Pause a running machine, keeping memory and running programs. Paused machines aren't billed for compute.", inputSchema: { id: idArg, wait: waitArg }, annotations: { openWorldHint: true } },
    handler(({ id, wait }) => runOp(`${m(id)}/suspend`, wait)));
  server.registerTool("resume_machine", { description: "Resume a paused machine where it left off.", inputSchema: { id: idArg, wait: waitArg }, annotations: { openWorldHint: true } },
    handler(({ id, wait }) => runOp(`${m(id)}/resume`, wait)));
  server.registerTool("stop_machine", {
    description: "Shut a running machine down: programs end, files are kept. A paused machine can't be stopped.",
    inputSchema: { id: idArg, timeoutSeconds: z.number().int().min(0).max(600).optional().describe("Clean-shutdown grace period (default 60)"), wait: waitArg },
    annotations: { openWorldHint: true },
  }, handler(({ id, wait, timeoutSeconds }) => runOp(`${m(id)}/stop`, wait, timeoutSeconds === undefined ? {} : { timeoutSeconds })));

  server.registerTool("get_operation", {
    description: "Follow a create/start/stop/pause/resume/delete operation. Waits up to 25s for it to change.",
    inputSchema: { operationId: z.string() },
    annotations: readOnly,
  }, handler(({ operationId }) => api("GET", `/v1/operations/${encodeURIComponent(operationId)}`, { query: { wait: "25s" } })));

  // ---------- Commands and files
  server.registerTool("run_command", {
    description:
      "Run a shell command (bash -lc) in a running machine and return stdout, stderr and exit code. " +
      "Output isn't streamed and web clients time out around a minute, so set background=true for anything long " +
      "(installs, builds, servers); it returns a log path to read later with read_file or tail.",
    inputSchema: {
      id: idArg,
      cmd: z.string(),
      cwd: z.string().optional().describe("Working directory (default /data/home)"),
      envs: z.record(z.string(), z.string()).optional(),
      stdin: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(600).default(50).describe("Kill after this long (exit 124)"),
      background: z.boolean().default(false).describe("Detach and log to ~/.mcp-jobs/<id>.log"),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, handler(async ({ id, cmd, background, ...rest }) => {
    if (!background) return api("POST", `${m(id)}/exec`, { body: { cmd, ...rest } });
    const job = `job-${Date.now().toString(36)}`;
    const wrapper =
      `mkdir -p ~/.mcp-jobs; L=~/.mcp-jobs/${job}.log; ` +
      `nohup bash -lc "$MCP_CMD; echo \\"[exit \\$?]\\"" > "$L" 2>&1 < /dev/null & echo "{\\"job\\":\\"${job}\\",\\"pid\\":$!,\\"log\\":\\"$L\\"}"`;
    const r = await api<{ stdout: string; stderr: string; exitCode: number }>("POST", `${m(id)}/exec`, {
      body: { cmd: wrapper, cwd: rest.cwd, envs: { ...(rest.envs ?? {}), MCP_CMD: cmd }, timeoutSeconds: 30 },
    });
    if (r.exitCode !== 0) return r;
    try { return JSON.parse(r.stdout.trim()); } catch { return r; }
  }));

  server.registerTool("read_file", {
    description: "Read a text file (up to 256 KiB) or list a directory (up to 5000 entries) in a running machine.",
    inputSchema: { id: idArg, path: z.string().default("/data/home").describe("Absolute path") },
    annotations: readOnly,
  }, handler(({ id, path }) => api("GET", `${m(id)}/files`, { query: { path } })));

  server.registerTool("write_file", {
    description: "Create or overwrite a text file in a running machine (up to 1 MiB). Parent folders are created.",
    inputSchema: { id: idArg, path: z.string().describe("Absolute path, or relative to home"), content: z.string() },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, handler(({ id, path, content }) =>
    api("POST", `${m(id)}/exec`, {
      body: { cmd: 'mkdir -p "$(dirname "$TARGET")" && cat > "$TARGET" && wc -c < "$TARGET"', envs: { TARGET: path }, stdin: content },
    })));

  // ---------- Snapshots
  server.registerTool("list_snapshots", { description: "List your snapshots.", annotations: readOnly },
    handler(() => api("GET", "/v1/snapshots")));
  server.registerTool("create_snapshot", {
    description: "Save a machine (installed software and /data) as a snapshot to start new machines from.",
    inputSchema: { id: idArg, name: z.string(), description: z.string().optional(), rootOnly: z.boolean().optional().describe("Software only, empty home") },
    annotations: { openWorldHint: true },
  }, handler(({ id, ...body }) => api("POST", `${m(id)}/snapshots`, { body, idempotent: true })));
  server.registerTool("delete_snapshot", { description: "Delete a snapshot. Irreversible.", inputSchema: { snapshotId: z.string() }, annotations: destructive },
    handler(({ snapshotId }) => api("DELETE", `/v1/snapshots/${encodeURIComponent(snapshotId)}`, { idempotent: true })));

  // ---------- Public ports
  server.registerTool("publish_port", {
    description: "Give a port in the machine a public HTTPS URL. Anyone with the URL can reach it until unpublished.",
    inputSchema: { id: idArg, port: z.number().int().min(1).max(65535), name: z.string().optional() },
    annotations: { openWorldHint: true },
  }, handler(({ id, ...body }) => api("POST", `${m(id)}/ports`, { body })));
  server.registerTool("list_ports", {
    description: "List public ports for one machine, or for all machines when no id is given.",
    inputSchema: { id: idArg.optional() },
    annotations: readOnly,
  }, handler(({ id }) => api("GET", id ? `${m(id)}/ports` : "/v1/ports")));
  server.registerTool("unpublish_port", {
    description: "Remove a port's public URL. The server in the machine keeps running.",
    inputSchema: { id: idArg, port: z.number().int() },
    annotations: destructive,
  }, handler(async ({ id, port }) => {
    await api("DELETE", `${m(id)}/ports/${port}`);
    return `Port ${port} unpublished.`;
  }));
}
