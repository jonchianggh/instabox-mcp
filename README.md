# instabox-mcp

A remote MCP server for [InstaBox](https://instabox.sh) cloud machines, made for web clients
(Claude.ai, ChatGPT) that can't run the InstaBox CLI. It speaks Streamable HTTP and has its own
single-user OAuth login, so connecting a client is: paste the URL → enter your password → done.

## Tools

| Area | Tools |
|---|---|
| Account | `whoami`, `get_usage`, `list_templates` |
| Machines | `list_machines`, `get_machine`, `create_machine`, `update_machine`, `delete_machine` |
| Lifecycle | `start_machine`, `stop_machine`, `pause_machine`, `resume_machine`, `get_operation` |
| Commands & files | `run_command` (with `background` mode), `read_file`, `write_file` |
| Snapshots | `list_snapshots`, `create_snapshot`, `delete_snapshot` |
| Public ports | `publish_port`, `list_ports`, `unpublish_port` |
| Secrets | `list_secrets`, `set_secret`, `import_secrets`, `delete_secret`, `get_machine_secrets`, `set_machine_secrets`, `refresh_machine_secrets` |
| Desktop (computer use) | `desktop_start`, `desktop_status`, `desktop_screenshot`, `desktop_action`, `desktop_cursor_position`, `desktop_stream_url`, `desktop_revoke_streams`, `desktop_takeover`, `desktop_handback` |

Lifecycle tools wait up to ~45s (web clients time out around a minute) and otherwise return the
operation ID to follow with `get_operation`. Long commands should use `run_command` with
`background: true`, which logs to `~/.mcp-jobs/<job>.log` in the machine.

## Computer use

Machines have an optional Linux desktop (Xfce + Chromium). The model can see and drive it:

1. `desktop_start`: installs the desktop on first use (~30s, once) and starts it.
2. `desktop_action` with `open_url`, `click`, `double_click`, `right_click`, `move`, `drag`,
   `scroll`, `type` or `key` (e.g. `ctrl+l`). It returns a screenshot afterwards by default,
   so each step is one round trip.
3. `desktop_screenshot` any time. Images are JPEG by default (`format: "png"` for sharp text).

`desktop_stream_url` gives you a live link to watch along in your own browser (view-only by
default). Input runs through `xdotool` on display `:1`, the same way the official SDK does it.

## Secrets

Org Secrets keep API keys out of your machines' files. Two delivery modes:

- **proxy** (recommended): the machine only sees a placeholder. InstaBox's egress proxy swaps in
  the real value on HTTPS requests to the hosts you allow (e.g. `api.openai.com`), so the key
  never enters the machine.
- **env**: the real value is installed as an environment variable in machines that select it.

Pick Secrets for a new machine with `secrets` / `envSecrets` on `create_machine`, or later with
`set_machine_secrets` followed by `refresh_machine_secrets`. Reads never return values.

Writing or deleting values (`set_secret`, `import_secrets`, `delete_secret`) needs the org
owner/admin API key (`workspace:admin`); a personal org key gets `403 missing_scope`, while the
read and selection tools work with any key. A value you hand to `set_secret` passes through the
chat, so for high-value credentials prefer the InstaBox dashboard or CLI and let the model only
select them.

## Configuration

| Variable | Required | |
|---|---|---|
| `PUBLIC_URL` | yes | Public HTTPS URL, no trailing slash. MCP endpoint is `$PUBLIC_URL/mcp` |
| `INSTABOX_API_KEY` | yes | From the InstaBox dashboard → API keys |
| `AUTH_PASSWORD` | yes | What you type on the login page |
| `TOKEN_SECRET` | yes | ≥32 chars, `openssl rand -hex 32`. Rotating it signs out every client |
| `PORT` | no | Default 3000 (Railway sets it) |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | no | Default 1h / 30d |
| `MAX_WAIT_SECONDS` | no | Default 45 |
| `MCP_BEARER_TOKEN` | no | Static bearer (≥32 chars) that `/mcp` also accepts, for Claude Code, scripts and curl. Unset = OAuth only |
| `CIMD_ENABLED` | no | Default `true`. Set `false` to stop advertising Client ID Metadata Documents, so clients use dynamic registration |
| `CIMD_ALLOWED_HOSTS` | no | Comma-separated hosts allowed to serve client metadata (e.g. `claude.ai`, `*.example.com`). Empty = any public host |

## Deploy

Every push to `main` builds `ghcr.io/<owner>/instabox-mcp:latest` (amd64 + arm64) plus a
`sha-xxxxxxx` tag; a `v1.2.3` git tag also publishes `1.2.3` and `1.2`.
If the repo is private, the GHCR package is private too: either make the package public
(GitHub → Packages → instabox-mcp → Package settings) or give your host registry credentials.

**Railway**: New project → Deploy from GitHub repo (it builds the Dockerfile), or Docker image
`ghcr.io/<owner>/instabox-mcp:latest`. Add the env vars, generate a domain, set `PUBLIC_URL` to it,
health check path `/healthz`.

**VPS**: `cp .env.example .env`, fill it in, then `DOMAIN=mcp.example.com docker compose up -d`.
Caddy gets the HTTPS certificate automatically.

Already running nginx, Traefik or another proxy? Delete the `caddy` service and its volume, publish
the app on localhost only (`ports: ["127.0.0.1:3000:3000"]`) and proxy your domain to it. Give the
proxy a read timeout above 60s (lifecycle waits run up to ~45s) and keep it to one proxy hop,
since the app trusts exactly one `X-Forwarded-For` hop for the login rate limit.

## Connect a client

The MCP URL is `https://<your-domain>/mcp`. Clients identify themselves automatically and pop up
this server's login page, where you enter `AUTH_PASSWORD`. The page shows the client's name and
where it will send you back to, so check that before you type the password.

Two ways of identifying are supported:

- **Client ID Metadata Documents (CIMD)**, which Claude prefers: the client's `client_id` is an
  HTTPS URL (e.g. `https://claude.ai/oauth/mcp-oauth-client-metadata`). The server fetches that
  JSON once and caches it (5 min to 24 h, following `Cache-Control`). If a later refetch fails,
  it keeps using the last good copy for up to 7 days. The fetch is
  SSRF-guarded: https only, public IPs only (pinned against DNS rebinding), no redirects,
  `application/json` only, 16 KB and 5 s limits. Claude Code's loopback callbacks
  (`http://localhost:<any port>/callback`, `http://127.0.0.1:<any port>/callback`) match without the port.
- **Dynamic client registration (DCR)**, the fallback, used by ChatGPT and older clients.

If Claude's sign-in fails with `invalid_client ... Could not load client metadata document`, look
for a `[cimd]` line in the server log. Cloudflare sometimes answers `403` to requests for
claude.ai's metadata that come from datacenter IPs
([anthropics/claude-ai-mcp#650](https://github.com/anthropics/claude-ai-mcp/issues/650)). Set
`CIMD_ENABLED=false` and reconnect: Claude then falls back to DCR.

**Claude.ai**: Settings → Connectors → Add custom connector → paste the URL. If asked, choose
**Sign in now** and the **Register** auth client (not Claude identity, not an API key).

**ChatGPT** (Plugins, no developer mode needed):

1. Open [chatgpt.com/plugins](https://chatgpt.com/plugins), select **+**, then **Add custom MCP server**.
2. Name it (e.g. InstaBox) and paste the URL under **Connection**.
3. Authentication: **OAuth**. Leave the client ID and secret empty so ChatGPT registers itself.
4. Tick **I understand and want to continue**, select **Create as a plugin**, and sign in.
5. In a chat, type `@` and pick the plugin. Selection lasts one message, so @mention it again
   for follow-ups that need the machines.

Write tools (create, run, delete...) need a ChatGPT Business or Enterprise/Edu workspace, where
only admins/owners (or RBAC-granted members) can add servers. Pro accounts get read/fetch only,
which leaves this server of little use there. ChatGPT freezes the tool list when the plugin is
created, so after upgrading the server, refresh the tools in workspace app settings (or recreate
the plugin) to pick up new ones.

**Claude Code**: OAuth works as-is (`claude mcp add --transport http instabox https://<your-domain>/mcp`,
then `/mcp` to sign in). If you'd rather skip the browser, set `MCP_BEARER_TOKEN` and pass it as a header:

    claude mcp add --transport http instabox https://<your-domain>/mcp \
      --header "Authorization: Bearer $MCP_BEARER_TOKEN"

**Scripts / curl** (needs `MCP_BEARER_TOKEN`):

    curl -s https://<your-domain>/mcp \
      -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

## Local development

    npm install
    cp .env.example .env   # PUBLIC_URL=http://localhost:3000
    npm run build && node --env-file=.env dist/index.js

Test with `npx @modelcontextprotocol/inspector` against `http://localhost:3000/mcp`.

## Security notes

- Anyone who logs in can run commands on your machines, so use a long password.
  The login form is rate limited (10 tries per 15 min per IP).
- `MCP_BEARER_TOKEN` never expires and skips the login page, so treat it like the password:
  long, random, and rotated if it leaks (change the env var and restart). It is compared in
  constant time. OAuth tokens keep working alongside it.
- OAuth state is stateless (HMAC-signed with `TOKEN_SECRET`), so redeploys never sign you out.
- Requires HTTPS in production; the OAuth library refuses a non-HTTPS issuer except on localhost.
