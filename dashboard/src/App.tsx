import { HashRing } from "./components/HashRing";
import { EventLog } from "./components/EventLog";
import { StatsBar } from "./components/StatsBar";
import { ChaosControls } from "./components/ChaosControls";
import { useVulcanEvents } from "./hooks/useVulcanEvents";

export default function App() {
  const { events, clusterState, failureModes, stats, connected, lastEvent, sendChaos } =
    useVulcanEvents();

  return (
    <div className="app">
      <StatsBar
        clusterState={clusterState}
        stats={stats}
        connected={connected}
      />

      <main className="app-main">
        <HashRing clusterState={clusterState} lastEvent={lastEvent} />
        <EventLog events={events} />
      </main>

      <ChaosControls failureModes={failureModes} sendChaos={sendChaos} />
    </div>
  );
}
