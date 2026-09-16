import { useEffect, useRef, useState } from "react";
import type { VulcanEvent, ClusterState } from "../types";

// ── Ring geometry ────────────────────────────────────────────────────────────
const CX = 220;
const CY = 220;
const RING_R = 135;
const NODE_R = 26;

// node1 at top (−90°), node2 at bottom-right (30°), node3 at bottom-left (150°)
const NODES = {
  node1: { angle: -90, label: "N1", name: "node1" },
  node2: { angle: 30,  label: "N2", name: "node2" },
  node3: { angle: 150, label: "N3", name: "node3" },
} as const;

function polar(angle: number): { x: number; y: number } {
  const r = (angle * Math.PI) / 180;
  return { x: CX + RING_R * Math.cos(r), y: CY + RING_R * Math.sin(r) };
}

// ── Packet animation ─────────────────────────────────────────────────────────
interface Packet {
  id: string;
  nodeId: string;
  color: string;
  startMs: number;
}

const EVENT_COLORS: Record<string, string> = {
  "op:set":      "#4a9eff",
  "op:get":      "#00d4c8",
  replication:   "#b44aff",
  replication_fail: "#ff4444",
};

// ── Component ────────────────────────────────────────────────────────────────
interface HashRingProps {
  clusterState: ClusterState;
  lastEvent: VulcanEvent | null;
}

export function HashRing({ clusterState, lastEvent }: HashRingProps) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const rafRef = useRef<number | null>(null);
  const [tick, setTick] = useState(0); // triggers re-render for animation

  // Spawn a packet dot when a relevant event fires.
  useEffect(() => {
    if (!lastEvent) return;
    let nodeId: string | undefined;
    let color: string | undefined;

    if (lastEvent.type === "op:set") {
      nodeId = lastEvent.forwarded ? lastEvent.forwardedTo : lastEvent.handledBy;
      color = EVENT_COLORS["op:set"];
    } else if (lastEvent.type === "op:get") {
      nodeId = lastEvent.handledBy;
      color = EVENT_COLORS["op:get"];
    } else if (lastEvent.type === "replication") {
      nodeId = lastEvent.replicaId;
      color = lastEvent.success === false
        ? EVENT_COLORS["replication_fail"]
        : EVENT_COLORS["replication"];
    }

    if (!nodeId || !color || !NODES[nodeId as keyof typeof NODES]) return;

    const pkt: Packet = {
      id: lastEvent.id + Math.random(),
      nodeId,
      color,
      startMs: performance.now(),
    };
    setPackets((p) => [...p.slice(-12), pkt]);
  }, [lastEvent]);

  // Animation loop — cleans up expired packets and drives re-renders.
  useEffect(() => {
    const loop = () => {
      const now = performance.now();
      setPackets((p) => p.filter((pk) => now - pk.startMs < 900));
      setTick((t) => t + 1);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const now = performance.now();
  void tick; // consumed to trigger re-render

  return (
    <div className="ring-panel">
      <div className="panel-title">Hash Ring</div>
      <svg
        viewBox="0 0 440 440"
        className="ring-svg"
        aria-label="Vulcan distributed hash ring — 3 nodes at 120° intervals"
      >
        <defs>
          <filter id="glow-green" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-red" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="glow-dim" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* Dashed ring track */}
        <circle
          cx={CX} cy={CY} r={RING_R}
          fill="none"
          stroke="#1e2d4a"
          strokeWidth="1.5"
          strokeDasharray="6 5"
        />

        {/* Animated packet ripples */}
        {packets.map((pkt) => {
          const nd = NODES[pkt.nodeId as keyof typeof NODES];
          if (!nd) return null;
          const { x, y } = polar(nd.angle);
          const elapsed = now - pkt.startMs;
          const t = Math.min(elapsed / 900, 1);
          // Ease-out cubic
          const eased = 1 - Math.pow(1 - t, 3);
          return (
            <circle
              key={pkt.id}
              cx={x} cy={y}
              r={NODE_R + eased * 55}
              fill="none"
              stroke={pkt.color}
              strokeWidth="1.8"
              opacity={(1 - t) * 0.85}
            />
          );
        })}

        {/* Nodes */}
        {(Object.entries(NODES) as [keyof typeof NODES, (typeof NODES)[keyof typeof NODES]][]).map(
          ([id, { angle, label, name }]) => {
            const { x, y } = polar(angle);
            const status = clusterState[id];
            const alive = status === "ALIVE";
            const dead  = status === "DEAD";
            const filterId = dead ? "url(#glow-red)" : alive ? "url(#glow-green)" : "url(#glow-dim)";
            const strokeColor = dead ? "#ff4444" : alive ? "#00e87a" : "#3a5570";
            const fillColor   = dead ? "#2a0d0d"  : alive ? "#0a2018" : "#0c1526";
            const textColor   = dead ? "#ff6666"  : alive ? "#00e87a" : "#4a6a8a";

            // Label anchor: node1 is at top so its name goes above; others go below.
            const nameY = angle === -90 ? y - NODE_R - 14 : y + NODE_R + 15;
            const nameAnchor = "middle";

            return (
              <g key={id} className={alive ? "node-alive" : dead ? "node-dead" : "node-unknown"}>
                {/* Outer glow ring */}
                <circle
                  cx={x} cy={y}
                  r={NODE_R + 8}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={dead ? 2 : 1.5}
                  opacity={dead ? 0.7 : alive ? 0.4 : 0.2}
                  filter={filterId}
                  className={alive ? "pulse-ring" : ""}
                />
                {/* Node body */}
                <circle
                  cx={x} cy={y} r={NODE_R}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth="2"
                />
                {/* Node abbreviation */}
                <text
                  x={x} y={y - 5}
                  textAnchor="middle" dominantBaseline="middle"
                  fill={textColor}
                  fontSize="13" fontWeight="700"
                  fontFamily="'JetBrains Mono', monospace"
                >
                  {label}
                </text>
                {/* Status line */}
                <text
                  x={x} y={y + 9}
                  textAnchor="middle" dominantBaseline="middle"
                  fill={textColor}
                  fontSize="7" fontFamily="Inter, sans-serif" letterSpacing="0.05em"
                >
                  {status}
                </text>
                {/* Full node name label outside the ring */}
                <text
                  x={x} y={nameY}
                  textAnchor={nameAnchor}
                  fill="#4a6a8a"
                  fontSize="11" fontFamily="Inter, sans-serif"
                >
                  {name}
                </text>
              </g>
            );
          }
        )}

        {/* Centre label */}
        <text x={CX} y={CY - 7} textAnchor="middle" fill="#263d5a"
          fontSize="11" fontFamily="Inter, sans-serif" fontWeight="600" letterSpacing="0.15em">
          VULCAN
        </text>
        <text x={CX} y={CY + 8} textAnchor="middle" fill="#1e3048"
          fontSize="9" fontFamily="'JetBrains Mono', monospace">
          RF = 2
        </text>
      </svg>
    </div>
  );
}
