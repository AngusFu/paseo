import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KnowledgeBaseDetailScreen } from "@/screens/knowledge-base-detail-screen";

export default function KnowledgeBaseDetailRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === "string" ? params.id : "";

  return (
    <HostRouteBootstrapBoundary>
      <KnowledgeBaseDetailScreen idOrSlug={id} />
    </HostRouteBootstrapBoundary>
  );
}
