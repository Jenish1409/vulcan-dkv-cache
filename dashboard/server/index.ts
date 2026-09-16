/**
 * dashboard/server/index.ts — Vulcan Dashboard Aggregator (Phase 9)
 *
 * Responsibilities:
 *   1. Connect to all 3 Vulcan node SSE streams (GET /events) and merge
 *      them into a single WebSocket broadcast for the browser dashboard.
 *   2. Expose a REST chaos-command API so the browser can trigger docker
 *      operations without needing docker access in the browser.
 *
 * Restore strategy (discovered empirically on Docker Desktop / Windows):
 *   - KILLED nodes  → `docker compose start <service>` restores both the
 *     container and its port-to-host binding.
 *   - ISOLATED nodes → `docker network connect` alone does NOT restore the
 *     host port binding lost during `docker network disconnect`.
 *     `docker compose restart <service>` is the only reliable remedy.
 *   The aggregator tracks which failure mode was applied to each node so
 *   Restore All (and per-node fix buttons) apply exactly the right command.
 *
 * Run with:  npx tsx server/index.ts   (from the dashboard/ directory)
 */

import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { execSync } from "child_process";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 4000;

const NODES = [
  { id: "node1", serviceId: "node1", host: "localhost", port: 5001 },
  { id: "node2", serviceId: "node2", host: "localhost", port: 5002 },
  { id: "node3", serviceId: "node3", host: "localhost", port: 5003 },
] as const;

type NodeId = (typeof NODES)[number]["id"];

// ---------------------------------------------------------------------------
// WebSocket server + browser client registry
// ---------------------------------------------------------------------------

const httpServer = http.createServer(handleHttpRequest);
const wss = new WebSocketServer({ server: httpServer });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[aggregator] Browser connected (${clients.size} total)`);

  // Send a snapshot of current cluster status on initial connect.
  ws.send(JSON.stringify(makeClusterSnapshot()));

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[aggregator] Browser disconnected (${clients.size} remaining)`);
  });

  ws.on("error", () => { clients.delete(ws); });
});

function broadcast(event: Record<string, unknown>): void {
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Node status + failure-mode tracking
// ---------------------------------------------------------------------------

type NodeStatus = "ALIVE" | "DEAD" | "UNKNOWN";
/** Which failure was applied by the dashboard. Determines the correct remedy. */
type FailureMode = "none" | "killed" | "isolated";

const nodeStatuses: Record<NodeId, NodeStatus> = {
  node1: "UNKNOWN",
  node2: "UNKNOWN",
  node3: "UNKNOWN",
};

/**
 * Tracks which chaos failure mode is currently active for each node.
 * Updated immediately when a chaos command is issued and cleared on success.
 *
 * Restore strategy per mode (determined empirically on Docker Desktop/Windows):
 *   - killed   → docker compose start <service>
 *   - isolated → docker compose restart <service>
 *                (docker network connect alone does NOT restore host port binding)
 */
const nodeFailureModes: Record<NodeId, FailureMode> = {
  node1: "none",
  node2: "none",
  node3: "none",
};

const sseConnected: Record<NodeId, boolean> = {
  node1: false,
  node2: false,
  node3: false,
};

function makeClusterSnapshot(): Record<string, unknown> {
  return {
    id: randomUUID(),
    ts: Date.now(),
    source: "aggregator",
    type: "cluster",
    nodeStatuses: { ...nodeStatuses },
    nodeFailureModes: { ...nodeFailureModes },
    sseConnected: { ...sseConnected },
  };
}

function broadcastClusterStatus(): void {
  broadcast(makeClusterSnapshot());
}

// ---------------------------------------------------------------------------
// SSE client — connect to one node's /events stream with auto-reconnect
// ---------------------------------------------------------------------------

function connectToNodeSSE(nodeId: NodeId, host: string, port: number): void {
  const req = http.request(
    { hostname: host, port, path: "/events", method: "GET", headers: { Accept: "text/event-stream" } },
    (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[aggregator] ${nodeId}: SSE returned HTTP ${res.statusCode} — retrying in 3s`);
        res.resume();
        setTimeout(() => connectToNodeSSE(nodeId, host, port), 3_000);
        return;
      }

      console.log(`[aggregator] ${nodeId}: SSE stream connected`);
      sseConnected[nodeId] = true;
      if (nodeFailureModes[nodeId] === "none") {
        nodeStatuses[nodeId] = "ALIVE";
      }
      broadcastClusterStatus();

      let buffer = "";
      res.setEncoding("utf8");

      res.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const raw = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            if (!raw["id"]) raw["id"] = randomUUID();

            // Keep aggregator's own status map in sync from heartbeat events.
            if (raw["type"] === "heartbeat" && typeof raw["peerId"] === "string") {
              const peerId = raw["peerId"] as string;
              if (peerId in nodeStatuses && nodeFailureModes[peerId as NodeId] === "none") {
                nodeStatuses[peerId as NodeId] = raw["status"] as NodeStatus;
              }
            }

            broadcast(raw);
          } catch {
            // Malformed JSON — skip silently.
          }
        }
      });

      const reconnect = () => {
        if (sseConnected[nodeId]) {
          console.warn(`[aggregator] ${nodeId}: SSE stream lost — reconnecting in 2s`);
          sseConnected[nodeId] = false;
          broadcastClusterStatus();
        }
        setTimeout(() => connectToNodeSSE(nodeId, host, port), 2_000);
      };

      res.on("end", reconnect);
      res.on("error", reconnect);
    }
  );

  req.on("error", () => {
    if (sseConnected[nodeId]) {
      console.warn(`[aggregator] ${nodeId}: cannot reach ${host}:${port} — retrying in 3s`);
      sseConnected[nodeId] = false;
      broadcastClusterStatus();
    }
    setTimeout(() => connectToNodeSSE(nodeId, host, port), 3_000);
  });

  req.end();
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodeStatuses, nodeFailureModes, sseConnected }));
    return;
  }

  if (req.method === "POST" && url.startsWith("/chaos/")) {
    req.resume();
    req.on("end", () => {
      try { handleChaosCommand(url, res); }
      catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        respond(res, false, `Internal error: ${msg}`, 500);
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function runDocker(args: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`docker ${args}`, { stdio: "pipe", encoding: "utf8", timeout: 20_000 });
    return { ok: true, output: out.trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const txt = (err.stderr?.toString() ?? err.stdout?.toString() ?? String(e)).trim();
    return { ok: false, output: txt };
  }
}

function runDockerCompose(args: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`docker compose ${args}`, {
      stdio: "pipe", encoding: "utf8", timeout: 30_000,
      // Run from the Vulcan project root (one level up from dashboard/)
      cwd: require("path").resolve(__dirname, "../../"),
    });
    return { ok: true, output: out.trim() };
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    const txt = (err.stderr?.toString() ?? err.stdout?.toString() ?? String(e)).trim();
    return { ok: false, output: txt };
  }
}

function respond(
  res: http.ServerResponse,
  ok: boolean,
  message: string,
  status = 200
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok, message }));
  broadcast({
    id: randomUUID(), ts: Date.now(), source: "aggregator",
    type: "cluster", chaosAction: true, ok, message,
  });
}

// ---------------------------------------------------------------------------
// Chaos command router
// ---------------------------------------------------------------------------

function handleChaosCommand(url: string, res: http.ServerResponse): void {

  // POST /chaos/kill/:nodeId  ─────────────────────────────────────────────
  const killMatch = url.match(/^\/chaos\/kill\/(node\d+)$/);
  if (killMatch) {
    const nodeId = killMatch[1]! as NodeId;
    const r = runDocker(`stop vulcan-${nodeId}`);
    if (r.ok) {
      nodeStatuses[nodeId] = "DEAD";
      nodeFailureModes[nodeId] = "killed";
      broadcastClusterStatus();
      respond(res, true, `vulcan-${nodeId} stopped`);
    } else if (/already stopped|No such container|is not running/i.test(r.output)) {
      respond(res, false, `${nodeId} is already stopped`);
    } else {
      respond(res, false, `docker stop failed: ${r.output}`, 500);
    }
    return;
  }

  // POST /chaos/isolate/:nodeId  ──────────────────────────────────────────
  const isolateMatch = url.match(/^\/chaos\/isolate\/(node\d+)$/);
  if (isolateMatch) {
    const nodeId = isolateMatch[1]! as NodeId;
    const r = runDocker(`network disconnect vulcan_default vulcan-${nodeId}`);
    if (r.ok) {
      nodeStatuses[nodeId] = "DEAD";
      nodeFailureModes[nodeId] = "isolated";
      broadcastClusterStatus();
      respond(res, true, `vulcan-${nodeId} isolated from cluster network`);
    } else if (/not running|not connected|is not in network|No such container/i.test(r.output)) {
      respond(res, false, `${nodeId} is already stopped or not connected — isolate has no effect`);
    } else {
      respond(res, false, `docker network disconnect failed: ${r.output}`, 500);
    }
    return;
  }

  // POST /chaos/revive/:nodeId  ───────────────────────────────────────────
  // Per-node fix for KILLED nodes.
  const reviveMatch = url.match(/^\/chaos\/revive\/(node\d+)$/);
  if (reviveMatch) {
    const nodeId = reviveMatch[1]! as NodeId;
    const node = NODES.find((n) => n.id === nodeId);
    if (!node) { respond(res, false, `Unknown node: ${nodeId}`); return; }

    // `docker compose up -d` recreates the container if needed and restores
    // all port bindings. Equivalent to docker compose start for a stopped
    // container but also handles the case where the container was recreated.
    const r = runDockerCompose(`up -d ${node.serviceId}`);
    if (r.ok) {
      nodeFailureModes[nodeId] = "none";
      nodeStatuses[nodeId] = "ALIVE";
      broadcastClusterStatus();
      respond(res, true, `vulcan-${nodeId} started — container and port binding restored`);
    } else {
      respond(res, false, `docker compose up failed: ${r.output}`, 500);
    }
    return;
  }

  // POST /chaos/reconnect/:nodeId  ────────────────────────────────────────
  // Per-node fix for ISOLATED nodes — `docker compose restart <service>`.
  // Note: `docker network connect` alone does NOT restore the host port binding
  // on Docker Desktop/Windows when the container was disconnected via
  // `docker network disconnect`. Only a compose restart reliably restores both
  // the network membership and the port-to-host binding.
  const reconnectMatch = url.match(/^\/chaos\/reconnect\/(node\d+)$/);
  if (reconnectMatch) {
    const nodeId = reconnectMatch[1]! as NodeId;
    const node = NODES.find((n) => n.id === nodeId);
    if (!node) { respond(res, false, `Unknown node: ${nodeId}`); return; }

    const r = runDockerCompose(`up -d ${node.serviceId}`);
    if (r.ok) {
      nodeFailureModes[nodeId] = "none";
      nodeStatuses[nodeId] = "ALIVE";
      broadcastClusterStatus();
      respond(res, true, `vulcan-${nodeId} recreated — network isolation cleared, port binding restored`);
    } else {
      respond(res, false, `docker compose up failed: ${r.output}`, 500);
    }
    return;
  }

  // POST /chaos/restore  ──────────────────────────────────────────────────
  // Restore ALL nodes using the correct remedy per tracked failure mode.
  if (url === "/chaos/restore") {
    const results: string[] = [];
    let anyError = false;

    for (const node of NODES) {
      const mode = nodeFailureModes[node.id];

      if (mode === "killed") {
        // Start the stopped container — also restores its port bindings.
        const r = runDockerCompose(`up -d ${node.serviceId}`);
        if (r.ok || /already started|already running/i.test(r.output)) {
          nodeFailureModes[node.id] = "none";
          nodeStatuses[node.id] = "ALIVE";
          results.push(`${node.id}: started (was killed)`);
        } else {
          results.push(`${node.id}: start FAILED — ${r.output}`);
          anyError = true;
        }

      } else if (mode === "isolated") {
        // Recreate the container — the only reliable way to restore the host
        // port binding that docker network disconnect drops on Docker Desktop.
        const r = runDockerCompose(`up -d ${node.serviceId}`);
        if (r.ok) {
          nodeFailureModes[node.id] = "none";
          nodeStatuses[node.id] = "ALIVE";
          results.push(`${node.id}: recreated (was isolated)`);
        } else {
          results.push(`${node.id}: up FAILED — ${r.output}`);
          anyError = true;
        }

      } else {
        // Already healthy — no-op.
        results.push(`${node.id}: already healthy, skipped`);
      }
    }

    broadcastClusterStatus();
    respond(
      res,
      !anyError,
      anyError
        ? `Restore completed with errors: ${results.join("; ")}`
        : results.join("; ")
    );
    return;
  }

  res.writeHead(404); res.end("Unknown chaos command");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`\n[aggregator] Vulcan Dashboard Aggregator running`);
  console.log(`[aggregator]   WebSocket  : ws://localhost:${PORT}`);
  console.log(`[aggregator]   Chaos API  : http://localhost:${PORT}/chaos/*`);
  console.log(`[aggregator]   Status     : http://localhost:${PORT}/status`);
  console.log(`\n[aggregator] Connecting to Vulcan nodes...`);

  for (const node of NODES) {
    connectToNodeSSE(node.id, node.host, node.port);
  }
});
