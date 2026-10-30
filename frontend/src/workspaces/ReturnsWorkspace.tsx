import ReturnsClaims from "../ReturnsClaims";
import RoadmapPage from "./WorkspaceRoadmap";
import type { WorkspaceProps } from "./types";
export default function ReturnsWorkspace({ page, ...props }: WorkspaceProps) {
  return page === "Returns & Claims Roadmap" ? (
    <RoadmapPage document="returns" />
  ) : (
    <ReturnsClaims {...props} />
  );
}
