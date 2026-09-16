import type { ClusterState, Stats } from "../types";
import { NODE_IDS } from "../types";

interface StatsBarProps {
  clusterState: ClusterState;
  stats: Stats;
  connected: boolean;
}

export function StatsBar({ clusterState, stats, connected }: StatsBarProps) {
  const aliveCount = NODE_IDS.filter((id) => clusterState[id] === "ALIVE").length;
  const totalNodes = NODE_IDS.length;
  const healthColor =
    aliveCount === totalNodes ? "#00e87a" :
    aliveCount > 0           ? "#ff9f43" :
                               "#ff4444";

  return (
    <header className="stats-bar" role="banner">
      {/* Left: brand */}
      <div className="stats-brand">
        <span className="stats-logo">⬡</span>
        <span className="stats-name">Vulcan</span>
        <span className="stats-phase">Live Dashboard</span>
      </div>

      {/* Centre: cluster health */}
      <div className="stats-cluster">
        <div
          className="stats-health-dot"
          style={{ background: healthColor, boxShadow: `0 0 8px ${healthColor}` }}
          aria-hidden="true"
        />
        <span className="stats-health-label" style={{ color: healthColor }}>
          {aliveCount}/{totalNodes} nodes healthy
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item">RF <b>2</b></span>
        <span className="stats-sep">·</span>
        <span className="stats-item">
          Total ops <b>{stats.totalOps.toLocaleString()}</b>
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item" style={{ color: "#4a9eff" }}>
          SETs <b>{stats.sets.toLocaleString()}</b>
        </span>
        <span className="stats-sep">·</span>
        <span className="stats-item" style={{ color: "#00d4c8" }}>
          GETs <b>{stats.gets.toLocaleString()}</b>
        </span>
        {stats.failedReplications > 0 && (
          <>
            <span className="stats-sep">·</span>
            <span className="stats-item" style={{ color: "#ff4444" }}>
              Repl. failures <b>{stats.failedReplications}</b>
            </span>
          </>
        )}
      </div>

      {/* Right: aggregator connection status */}
      <div className="stats-conn">
        <div
          className={`stats-conn-dot ${connected ? "conn-ok" : "conn-lost"}`}
          aria-label={connected ? "Connected to aggregator" : "Disconnected from aggregator"}
        />
        <span className="stats-conn-label">
          {connected ? "Aggregator connected" : "Reconnecting…"}
        </span>
      </div>
    </header>
  );
}
