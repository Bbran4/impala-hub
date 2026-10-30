import { lazy, Suspense } from "react";
import type { RoadmapDocument } from "../roadmaps/roadmapDocuments";
const RoadmapPage = lazy(() => import("../roadmaps/RoadmapPage"));
export default function WorkspaceRoadmap({
  document,
}: {
  document: RoadmapDocument;
}) {
  return (
    <Suspense fallback={<p role="status">Loading roadmap...</p>}>
      <RoadmapPage document={document} />
    </Suspense>
  );
}
