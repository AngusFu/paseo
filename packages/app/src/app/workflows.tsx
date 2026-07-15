import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { WorkflowScreen } from "@/screens/workflow-screen";

export default function WorkflowsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <WorkflowScreen />
    </HostRouteBootstrapBoundary>
  );
}
