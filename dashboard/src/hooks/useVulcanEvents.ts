import { useEffect, useRef, useState, useCallback } from "react";
import type { VulcanEvent, ClusterState, FailureModeState, Stats, NodeId } from "../types";

const WS_URL = "ws://localhost:4000";
const CHAOS_BASE = "http://localhost:4000";
const MAX_LOG = 20;

export function useVulcanEvents() {
  const [events, setEvents] = useState<VulcanEvent[]>([]);
  const [clusterState, setClusterState] = useState<ClusterState>({
    node1: "UNKNOWN",
    node2: "UNKNOWN",
    node3: "UNKNOWN",
  });
  const [failureModes, setFailureModes] = useState<FailureModeState>({
    node1: "none",
    node2: "none",
    node3: "none",
  });
  const [stats, setStats] = useState<Stats>({
    totalOps: 0,
    sets: 0,
    gets: 0,
    replications: 0,
    failedReplications: 0,
  });
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<VulcanEvent | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < 2) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); };

    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as VulcanEvent;
        setLastEvent(event);

        // ── Cluster state ──────────────────────────────────────────────
        if (event.type === "heartbeat" && event.peerId && event.status) {
          setClusterState((prev) => ({
            ...prev,
            [event.peerId as NodeId]: event.status!,
          }));
        }
        if (event.type === "cluster") {
          if (event.nodeStatuses) {
            setClusterState((prev) => ({
              ...prev,
              ...(event.nodeStatuses as Partial<ClusterState>),
            }));
          }
          if (event.nodeFailureModes) {
            setFailureModes((prev) => ({
              ...prev,
              ...(event.nodeFailureModes as Partial<FailureModeState>),
            }));
          }
        }

        // ── Stats ──────────────────────────────────────────────────────
        setStats((prev) => {
          if (event.type === "op:set")
            return { ...prev, totalOps: prev.totalOps + 1, sets: prev.sets + 1 };
          if (event.type === "op:get")
            return { ...prev, totalOps: prev.totalOps + 1, gets: prev.gets + 1 };
          if (event.type === "replication")
            return {
              ...prev,
              replications: prev.replications + 1,
              failedReplications: event.success === false
                ? prev.failedReplications + 1
                : prev.failedReplications,
            };
          return prev;
        });

        // ── Rolling event log (skip pure cluster-status snapshots) ─────
        if (event.type !== "cluster") {
          setEvents((prev) => [event, ...prev].slice(0, MAX_LOG));
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setTimeout(connect, 2_000);
    };

    ws.onerror = () => { ws.close(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  /**
   * Send a chaos command to the aggregator and await confirmation.
   * The button calling this must stay disabled until this resolves —
   * the aggregator awaits the docker command inline before responding.
   */
  const sendChaos = useCallback(
    async (path: string): Promise<{ ok: boolean; message: string }> => {
      try {
        const r = await fetch(`${CHAOS_BASE}${path}`, { method: "POST" });
        return (await r.json()) as { ok: boolean; message: string };
      } catch (e) {
        return { ok: false, message: String(e) };
      }
    },
    []
  );

  return { events, clusterState, failureModes, stats, connected, lastEvent, sendChaos };
}
