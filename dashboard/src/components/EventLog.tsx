import type { VulcanEvent } from "../types";

const TYPE_META: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  "op:set":    { label: "SET",   color: "#4a9eff", bg: "rgba(74,158,255,0.08)" },
  "op:get":    { label: "GET",   color: "#00d4c8", bg: "rgba(0,212,200,0.08)"  },
  replication: { label: "REPL",  color: "#b44aff", bg: "rgba(180,74,255,0.08)" },
  heartbeat:   { label: "HB",    color: "#ff9f43", bg: "rgba(255,159,67,0.08)" },
  cluster:     { label: "SYS",   color: "#7a9ab8", bg: "rgba(122,154,184,0.06)"},
};

function formatEvent(e: VulcanEvent): string {
  switch (e.type) {
    case "op:set":
      return e.forwarded
        ? `key=${e.key} → forwarded to ${e.forwardedTo}`
        : `key=${e.key} → stored on ${e.handledBy}`;
    case "op:get":
      return `key=${e.key} ← served by ${e.handledBy}`;
    case "replication":
      return `key=${e.key} → replica ${e.replicaId} ${e.success ? "✓" : "✗ failed"}`;
    case "heartbeat":
      return `${e.source}: ${e.peerId} → ${e.status}`;
    case "cluster":
      return (e as { message?: string }).message ?? "cluster status update";
    default:
      return JSON.stringify(e);
  }
}

function timeStr(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

interface EventLogProps {
  events: VulcanEvent[];
}

export function EventLog({ events }: EventLogProps) {
  return (
    <div className="log-panel">
      <div className="panel-title">
        Live Events
        <span className="log-count">{events.length} / 20</span>
      </div>
      <div className="log-list" role="log" aria-live="polite" aria-label="Live event log">
        {events.length === 0 && (
          <div className="log-empty">Waiting for events…</div>
        )}
        {events.map((e) => {
          const meta = TYPE_META[e.type] ?? TYPE_META["cluster"]!;
          const isFail = e.type === "replication" && e.success === false;
          const isHbDead = e.type === "heartbeat" && e.status === "DEAD";
          const accentColor = isFail || isHbDead ? "#ff4444" : meta.color;

          return (
            <div
              key={e.id}
              className="log-entry"
              style={{ borderLeftColor: accentColor, background: meta.bg }}
            >
              <span className="log-badge" style={{ color: accentColor }}>
                {meta.label}
              </span>
              <span className="log-text">{formatEvent(e)}</span>
              <span className="log-source">{e.source}</span>
              <span className="log-time">{timeStr(e.ts)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
