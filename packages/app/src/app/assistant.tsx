import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AssistantScreen } from "@/screens/assistant-screen";

export default function AssistantRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AssistantScreen />
    </HostRouteBootstrapBoundary>
  );
}
