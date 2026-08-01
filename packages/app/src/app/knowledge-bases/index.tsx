import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KnowledgeBasesScreen } from "@/screens/knowledge-bases-screen";

export default function KnowledgeBasesRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <KnowledgeBasesScreen />
    </HostRouteBootstrapBoundary>
  );
}
