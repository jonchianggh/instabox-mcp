/**
 * Desktop / computer-use tools. InstaBox exposes desktop lifecycle and stream links over HTTP;
 * input and screenshots run inside the machine (xdotool, scrot/ImageMagick on display :1),
 * the same way the official SDK does it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api } from "./instabox.js";
import { config } from "./config.js";

const DISPLAY = ":1";
const m = (id: string) => `/v1/machines/${encodeURIComponent(id)}`;
const idArg = z.string().describe("Machine ID (m_...) or name");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface ExecResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean; truncated: boolean }
interface DesktopState { installed?: boolean; installing?: boolean; running?: boolean; failed?: boolean; log?: string; [k: string]: unknown }

async function run(id: string, cmd: string, stdin?: string, timeoutSeconds = 30): Promise<ExecResult> {
  const r = await api<ExecResult>("POST", `${m(id)}/exec`, {
    body: { cmd: `export DISPLAY=${DISPLAY}; ${cmd}`, stdin, timeoutSeconds },
  });
  if (r.exitCode !== 0) throw new Error(`Desktop command failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r;
}

const desktop = (id: string, body: Record<string, unknown>) => api<DesktopState>("POST", `${m(id)}/desktop`, { body });

const KEYS: Record<string, string> = {
  enter: "Return", return: "Return", esc: "Escape", escape: "Escape", tab: "Tab", space: "space",
  backspace: "BackSpace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "Prior", pagedown: "Next", up: "Up", down: "Down", left: "Left", right: "Right",
  ctrl: "ctrl", control: "ctrl", alt: "alt", shift: "shift", meta: "super", cmd: "super", command: "super",
  super: "super", win: "super",
};
function keysym(key: string): string {
  const k = key.trim();
  if (!k || /\s/.test(k)) throw new Error(`Invalid key ${JSON.stringify(key)}`);
  const lower = k.toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
  return k;
}
/** "ctrl+l", "Enter", or ["ctrl","shift","t"] → xdotool chord */
function chord(keys: string | string[]): string {
  const list = Array.isArray(keys) ? keys : keys.length > 1 && keys.includes("+") ? keys.split("+") : [keys];
  return list.map(keysym).join("+");
}

async function screenshot(id: string, format: "jpeg" | "png", quality: number) {
  const ext = format === "png" ? "png" : "jpg";
  const shot =
    format === "png"
      ? `if command -v scrot >/dev/null; then scrot -o "$f"; elif command -v import >/dev/null; then import -window root "png:$f"; else echo 'no screenshot tool (scrot or ImageMagick)' >&2; exit 127; fi`
      : `if command -v scrot >/dev/null; then scrot -o -q ${quality} "$f"; elif command -v import >/dev/null; then import -window root -quality ${quality} "jpg:$f"; else echo 'no screenshot tool (scrot or ImageMagick)' >&2; exit 127; fi`;
  const r = await run(id, `f=/tmp/mcp-shot-$$.${ext}; ${shot} && base64 -w0 "$f"; rc=$?; rm -f "$f"; exit $rc`);
  if (r.truncated) throw new Error("Screenshot too large to return; use format=jpeg or a lower quality");
  return { type: "image" as const, data: r.stdout.trim(), mimeType: format === "png" ? "image/png" : "image/jpeg" };
}

const ok = (data: unknown) => ({ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) });
function handler<A>(fn: (args: A) => Promise<Array<ReturnType<typeof ok> | Awaited<ReturnType<typeof screenshot>>>>) {
  return async (args: A) => {
    try {
      return { content: await fn(args) };
    } catch (err) {
      return { isError: true, content: [ok(err instanceof Error ? err.message : String(err))] };
    }
  };
}

const shotArgs = {
  format: z.enum(["jpeg", "png"]).default("jpeg").describe("jpeg is ~5x smaller; png is pixel-sharp"),
  quality: z.number().int().min(10).max(100).default(70).describe("JPEG quality"),
};

export function registerDesktopTools(server: McpServer) {
  server.registerTool("desktop_start", {
    description:
      "Start the machine's graphical desktop (Xfce + Chromium), installing it first if needed (~30s, once, ~1.4 GiB). " +
      "Safe to call again: a running desktop is left as is. Call this before any other desktop tool.",
    inputSchema: {
      id: idArg,
      width: z.number().int().min(800).max(2560).optional().describe("Default 1280"),
      height: z.number().int().min(600).max(1600).optional().describe("Default 800"),
    },
    annotations: { openWorldHint: true },
  }, handler(async ({ id, width, height }) => {
    const size = { ...(width ? { width } : {}), ...(height ? { height } : {}) };
    let s = await desktop(id, { action: "start", ...size });
    if (!s.installed) {
      if (!s.installing) s = await desktop(id, { action: "install" });
      const deadline = Date.now() + config.maxWaitSeconds * 1000;
      while (!s.installed) {
        if (s.failed) throw new Error(`Desktop install failed: ${s.log ?? "see /tmp/instabox-desktop-install.log"}`);
        if (Date.now() > deadline) return [ok("The desktop is still installing. Call desktop_start again in about 20 seconds.")];
        await sleep(4000);
        s = await desktop(id, { action: "status" });
      }
      s = await desktop(id, { action: "start", ...size });
    }
    if (!s.running) throw new Error("The desktop did not start");
    const geo = await run(id, "xdotool getdisplaygeometry").then((r) => r.stdout.trim()).catch(() => "");
    return [ok({ ...s, screen: geo || undefined })];
  }));

  server.registerTool("desktop_status", {
    description: "Whether the desktop is installed and running, its screen size, and who controls it.",
    inputSchema: { id: idArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, handler(async ({ id }) => [ok(await desktop(id, { action: "status" }))]));

  server.registerTool("desktop_screenshot", {
    description: "Take a screenshot of the whole desktop and return it as an image. Coordinates for desktop_action are pixels from the top left of this image.",
    inputSchema: { id: idArg, ...shotArgs },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, handler(async ({ id, format, quality }) => [await screenshot(id, format, quality)]));

  server.registerTool("desktop_action", {
    description:
      "Drive the desktop: click, double_click, right_click, move, drag, scroll, type, key or open_url. " +
      "By default returns a fresh screenshot afterwards so you can see the result.\n" +
      "- click/double_click/right_click/move: x, y\n- drag: x, y → to_x, to_y\n" +
      "- scroll: direction (up/down/left/right), amount (notches, default 3), optional x, y to move there first\n" +
      "- type: text (typed as is into the focused window)\n- key: keys, e.g. \"Enter\", \"ctrl+l\", [\"ctrl\",\"shift\",\"t\"]\n" +
      "- open_url: url (opens in Chromium)",
    inputSchema: {
      id: idArg,
      action: z.enum(["click", "double_click", "right_click", "move", "drag", "scroll", "type", "key", "open_url"]),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      to_x: z.number().int().min(0).optional(),
      to_y: z.number().int().min(0).optional(),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().int().min(1).max(100).optional(),
      text: z.string().optional(),
      keys: z.union([z.string(), z.array(z.string())]).optional(),
      url: z.string().url().optional(),
      screenshot_after: z.boolean().default(true),
      wait_ms: z.number().int().min(0).max(10000).default(800).describe("Pause before the screenshot so the screen can update"),
      ...shotArgs,
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, handler(async (a) => {
    const need = (...keys: (keyof typeof a)[]) => {
      for (const k of keys) if (a[k] === undefined) throw new Error(`${a.action} needs ${keys.join(", ")}`);
    };
    let done: string;
    switch (a.action) {
      case "click":
      case "double_click":
      case "right_click": {
        need("x", "y");
        const btn = a.action === "right_click" ? 3 : 1;
        const rep = a.action === "double_click" ? " --repeat 2 --delay 80" : "";
        await run(a.id, `xdotool mousemove ${a.x} ${a.y} click${rep} ${btn}`);
        done = `${a.action} at (${a.x}, ${a.y})`;
        break;
      }
      case "move":
        need("x", "y");
        await run(a.id, `xdotool mousemove ${a.x} ${a.y}`);
        done = `moved to (${a.x}, ${a.y})`;
        break;
      case "drag":
        need("x", "y", "to_x", "to_y");
        await run(a.id, `xdotool mousemove ${a.x} ${a.y} mousedown 1 sleep 0.1 mousemove ${a.to_x} ${a.to_y} sleep 0.1 mouseup 1`);
        done = `dragged (${a.x}, ${a.y}) → (${a.to_x}, ${a.to_y})`;
        break;
      case "scroll": {
        need("direction");
        const wheel = { up: 4, down: 5, left: 6, right: 7 }[a.direction!];
        const n = a.amount ?? 3;
        const pre = a.x !== undefined && a.y !== undefined ? `mousemove ${a.x} ${a.y} ` : "";
        await run(a.id, `xdotool ${pre}click --repeat ${n} --delay 30 ${wheel}`);
        done = `scrolled ${a.direction} ${n}`;
        break;
      }
      case "type":
        need("text");
        if (a.text) await run(a.id, "xdotool type --delay 12 --file -", a.text, 120);
        done = `typed ${a.text!.length} characters`;
        break;
      case "key":
        need("keys");
        await run(a.id, `xdotool key -- ${q(chord(a.keys!))}`);
        done = `pressed ${chord(a.keys!)}`;
        break;
      case "open_url": {
        need("url");
        const u = new URL(a.url!);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https URLs can be opened");
        await run(
          a.id,
          `b=$(command -v chromium || command -v chromium-browser || command -v google-chrome) || { echo 'no browser on the desktop; call desktop_start first' >&2; exit 127; }; ` +
            `setsid nohup "$b" --no-first-run --no-default-browser-check --password-store=basic ${q(u.href)} >/dev/null 2>&1 </dev/null &`,
        );
        done = `opened ${u.href}`;
        break;
      }
    }
    if (!a.screenshot_after) return [ok(done)];
    await sleep(a.action === "open_url" ? Math.max(a.wait_ms, 2500) : a.wait_ms);
    return [ok(done), await screenshot(a.id, a.format, a.quality)];
  }));

  server.registerTool("desktop_cursor_position", {
    description: "Where the mouse pointer is.",
    inputSchema: { id: idArg },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, handler(async ({ id }) => {
    const out = (await run(id, "xdotool getmouselocation --shell")).stdout;
    return [ok({ x: Number(/^X=(\d+)/m.exec(out)?.[1]), y: Number(/^Y=(\d+)/m.exec(out)?.[1]) })];
  }));

  server.registerTool("desktop_stream_url", {
    description:
      "Make a link that shows the desktop live in any browser, no InstaBox account needed. View-only by default; " +
      "view_only=false lets whoever opens it type and click. Share it only with people you trust.",
    inputSchema: {
      id: idArg,
      view_only: z.boolean().default(true),
      ttl_seconds: z.number().int().min(60).max(86400).default(3600),
    },
    annotations: { openWorldHint: true },
  }, handler(async ({ id, view_only, ttl_seconds }) => [
    ok(await api("POST", `${m(id)}/desktop/stream`, { body: { viewOnly: view_only, ttlSeconds: ttl_seconds } })),
  ]));

  server.registerTool("desktop_revoke_streams", {
    description: "Invalidate every stream link for this machine and disconnect open viewers within a few seconds.",
    inputSchema: { id: idArg },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, handler(async ({ id }) => {
    await api("DELETE", `${m(id)}/desktop/stream`);
    return [ok("All stream links revoked.")];
  }));

  server.registerTool("desktop_takeover", {
    description: "Mark the desktop as human-controlled (you take over from the agent). Use desktop_handback to return control.",
    inputSchema: { id: idArg },
    annotations: { openWorldHint: true },
  }, handler(async ({ id }) => [ok(await desktop(id, { action: "takeover" }))]));

  server.registerTool("desktop_handback", {
    description: "Hand desktop control back to the agent after a takeover.",
    inputSchema: { id: idArg },
    annotations: { openWorldHint: true },
  }, handler(async ({ id }) => [ok(await desktop(id, { action: "handback" }))]));
}
