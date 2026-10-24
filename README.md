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

Lifecycle tools wait up to ~45s (web clients time out around a minute) and otherwise return the
operation ID to follow with `get_operation`. Long commands should use `run_command` with
`background: true`, which logs to `~/.mcp-jobs/<job>.log` in the machine.

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

## Connect a client

- **Claude.ai**: Settings → Connectors → Add custom connector → `https://<your-domain>/mcp`.
- **ChatGPT**: turn on developer mode, then add a custom connector with the same URL and OAuth auth.

Both pop up the login page; enter `AUTH_PASSWORD`.

## Local development

    npm install
    cp .env.example .env   # PUBLIC_URL=http://localhost:3000
    npm run build && node --env-file=.env dist/index.js

Test with `npx @modelcontextprotocol/inspector` against `http://localhost:3000/mcp`.

## Security notes

- Anyone who logs in can run commands on your machines, so use a long password.
  The login form is rate limited (10 tries per 15 min per IP).
- OAuth state is stateless (HMAC-signed with `TOKEN_SECRET`), so redeploys never sign you out.
- Requires HTTPS in production; the OAuth library refuses a non-HTTPS issuer except on localhost.
