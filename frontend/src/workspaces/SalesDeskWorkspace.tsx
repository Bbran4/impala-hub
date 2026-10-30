import SalesDesk from "../SalesDesk";
import RoadmapPage from "./WorkspaceRoadmap";
import type { WorkspaceProps } from "./types";
export default function SalesDeskWorkspace({
  openRfqId,
  onOpenRfqHandled,
  ...props
}: WorkspaceProps & {
  openRfqId: string | null;
  onOpenRfqHandled: () => void;
}) {
  if (props.page === "RFQ Roadmap") return <RoadmapPage document="sales" />;
  return (
    <SalesDesk
      {...props}
      openRfqId={openRfqId}
      onOpenRfqHandled={onOpenRfqHandled}
    />
  );
}
