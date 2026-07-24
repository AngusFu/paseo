import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ApprovalsScreen } from "@/screens/approvals-screen";

export default function ApprovalsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ApprovalsScreen />
    </HostRouteBootstrapBoundary>
  );
}
