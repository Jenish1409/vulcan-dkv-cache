// Shared event type emitted by Vulcan nodes → aggregator → browser.

export interface VulcanEvent {
  id: string;
  ts: number;
  source: "node1" | "node2" | "node3" | "aggregator";
  type: "op:set" | "op:get" | "replication" | "heartbeat" | "cluster";
  // op fields
  key?: string;
  handledBy?: string;
  forwarded?: boolean;
  forwardedTo?: string;
  // replication fields
  replicaId?: string;
  success?: boolean;
  // heartbeat fields
  peerId?: string;
  status?: "ALIVE" | "DEAD";
  // aggregator/cluster fields
  nodeStatuses?: Partial<Record<NodeId, NodeStatus>>;
  nodeFailureModes?: Partial<Record<NodeId, FailureMode>>;
  sseConnected?: Partial<Record<NodeId, boolean>>;
  chaosAction?: boolean;
  message?: string;
  ok?: boolean;
}

export type NodeId = "node1" | "node2" | "node3";
export type NodeStatus = "ALIVE" | "DEAD" | "UNKNOWN";
/** Which chaos failure was applied to a node — determines the correct remedy. */
export type FailureMode = "none" | "killed" | "isolated";

export type ClusterState = Record<NodeId, NodeStatus>;
export type FailureModeState = Record<NodeId, FailureMode>;

export interface Stats {
  totalOps: number;
  sets: number;
  gets: number;
  replications: number;
  failedReplications: number;
}

export const NODE_IDS: NodeId[] = ["node1", "node2", "node3"];
