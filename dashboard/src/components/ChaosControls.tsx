import { useState } from "react";
import type { FailureModeState, NodeId } from "../types";
import { NODE_IDS } from "../types";

interface ChaosControlsProps {
  failureModes: FailureModeState;
  sendChaos: (path: string) => Promise<{ ok: boolean; message: string }>;
}

interface BtnState {
  loading: boolean;
  result: { ok: boolean; message: string } | null;
}

const INJECT_BUTTONS: { id: string; label: string; path: string }[] = [
  { id: "kill-node2",    label: "Kill node2",    path: "/chaos/kill/node2"    },
  { id: "kill-node3",    label: "Kill node3",    path: "/chaos/kill/node3"    },
  { id: "isolate-node1", label: "Isolate node1", path: "/chaos/isolate/node1" },
  { id: "isolate-node2", label: "Isolate node2", path: "/chaos/isolate/node2" },
];

const NODE_LABELS: Record<NodeId, string> = {
  node1: "node1",
  node2: "node2",
  node3: "node3",
};

function initBtnStates(ids: string[]): Record<string, BtnState> {
  return Object.fromEntries(ids.map((id) => [id, { loading: false, result: null }]));
}

export function ChaosControls({ failureModes, sendChaos }: ChaosControlsProps) {
  const injectIds = INJECT_BUTTONS.map((b) => b.id);
  const restoreIds = ["restore-all", ...NODE_IDS.flatMap((id) => [`revive-${id}`, `reconnect-${id}`])];

  const [btnStates, setBtnStates] = useState<Record<string, BtnState>>(() =>
    initBtnStates([...injectIds, ...restoreIds])
  );

  async function handleClick(btnId: string, path: string) {
    setBtnStates((prev) => ({ ...prev, [btnId]: { loading: true, result: null } }));
    const result = await sendChaos(path);
    setBtnStates((prev) => ({ ...prev, [btnId]: { loading: false, result } }));
    setTimeout(() => {
      setBtnStates((prev) => ({ ...prev, [btnId]: { loading: false, result: null } }));
    }, 5_000);
  }

  // Determine which per-node fix buttons are active based on tracked failure mode
  const failedNodes = NODE_IDS.filter((id) => failureModes[id] !== "none");

  return (
    <div className="chaos-panel">
      {/* ── Inject faults ─────────────────────────────────────────────── */}
      <div className="chaos-section">
        <div className="panel-title">
          Chaos Controls
          <span className="chaos-note">⚠ runs real docker commands on your host</span>
        </div>
        <div className="chaos-buttons">
          {INJECT_BUTTONS.map((btn) => (
            <ChaosBtn
              key={btn.id}
              id={`chaos-${btn.id}`}
              label={btn.label}
              state={btnStates[btn.id]!}
              danger
              onClick={() => void handleClick(btn.id, btn.path)}
            />
          ))}
        </div>
      </div>

      {/* ── Per-node targeted fixes ────────────────────────────────────── */}
      {failedNodes.length > 0 && (
        <div className="chaos-section chaos-section-fix">
          <div className="chaos-section-label">Targeted fixes</div>
          <div className="chaos-buttons">
            {failedNodes.map((nodeId) => {
              const mode = failureModes[nodeId];
              const isKilled   = mode === "killed";
              const btnId      = isKilled ? `revive-${nodeId}` : `reconnect-${nodeId}`;
              const path       = isKilled ? `/chaos/revive/${nodeId}` : `/chaos/reconnect/${nodeId}`;
              const label      = isKilled
                ? `Revive ${NODE_LABELS[nodeId]}`
                : `Reconnect ${NODE_LABELS[nodeId]}`;
              const modeTag    = isKilled ? "killed" : "isolated";

              return (
                <div key={nodeId} className="chaos-btn-wrap">
                  <div className="chaos-mode-tag">
                    <span className={`mode-pill mode-${modeTag}`}>{modeTag}</span>
                    {nodeId}
                  </div>
                  <ChaosBtn
                    id={`chaos-${btnId}`}
                    label={label}
                    state={btnStates[btnId]!}
                    danger={false}
                    restore
                    onClick={() => void handleClick(btnId, path)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Restore all ───────────────────────────────────────────────── */}
      <div className="chaos-section">
        <div className="chaos-buttons">
          <ChaosBtn
            id="chaos-restore-all"
            label="Restore All ↺"
            state={btnStates["restore-all"]!}
            danger={false}
            restore
            onClick={() => void handleClick("restore-all", "/chaos/restore")}
          />
          <div className="chaos-restore-note">
            Applies correct fix per node: any failure mode → docker compose up -d (recreates container, restores port binding)
          </div>
        </div>
      </div>

      <p className="chaos-limitation">
        Known limitation: concurrent commands from two browser tabs may race.
        Acceptable for single-user demo use.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable button
// ---------------------------------------------------------------------------

interface ChaosBtnProps {
  id: string;
  label: string;
  state: BtnState;
  danger: boolean;
  restore?: boolean;
  onClick: () => void;
}

function ChaosBtn({ id, label, state, danger, restore, onClick }: ChaosBtnProps) {
  const cls = [
    "chaos-btn",
    danger   ? "chaos-btn-danger"  : "",
    restore  ? "chaos-btn-restore" : "",
    state.loading ? "chaos-btn-loading" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="chaos-btn-wrap">
      <button
        id={id}
        className={cls}
        disabled={state.loading}
        onClick={onClick}
        aria-busy={state.loading}
      >
        {state.loading && <span className="chaos-spinner" aria-hidden="true" />}
        {label}
      </button>
      {state.result && (
        <div
          className={`chaos-result ${state.result.ok ? "chaos-result-ok" : "chaos-result-err"}`}
          role="status"
        >
          {state.result.ok ? "✓" : "✗"} {state.result.message}
        </div>
      )}
    </div>
  );
}
