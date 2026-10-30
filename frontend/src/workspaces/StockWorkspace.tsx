import PartsQueries from "../PartsQueries";
import StockBooking from "../StockBookingSupabase";
import StockImport from "../StockImport";
import StockReordering from "../StockReorderingSupabase";
import RoadmapPage from "./WorkspaceRoadmap";
import type { WorkspaceProps } from "./types";
export default function StockWorkspace({ page, ...props }: WorkspaceProps) {
  switch (page) {
    case "Stock Booking":
      return <StockBooking {...props} />;
    case "Stock Reordering":
      return <StockReordering {...props} />;
    case "Parts Query":
      return <PartsQueries {...props} />;
    case "Stock Data Import":
      return <StockImport {...props} />;
    case "Stock Control Roadmap":
      return <RoadmapPage document="stock" />;
    default:
      return null;
  }
}
