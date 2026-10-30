import marketing from "../../../docs/MARKETING_ROADMAP.md?raw";
import sales from "../../../docs/SALES_DESK_ROADMAP.md?raw";
import stock from "../../../docs/SMART_STOCK_CONTROL_ROADMAP.md?raw";
import returns from "../../../docs/RETURNS_CLAIMS_ROADMAP.md?raw";
// Explicitly allowlist the documents that ship in the browser bundle.
export const roadmapDocuments = { marketing, sales, stock, returns };
export type RoadmapDocument = keyof typeof roadmapDocuments;
