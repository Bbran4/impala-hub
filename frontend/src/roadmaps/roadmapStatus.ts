import type { Root, TableCell } from "mdast";
export const roadmapStatuses = [
  "Implemented",
  "Partial",
  "Planned",
  "Deferred",
  "Missing",
  "Retired",
] as const;
export type RoadmapStatus = (typeof roadmapStatuses)[number];
export function roadmapStatus(value: string): RoadmapStatus | null {
  const text = value.trim().toLowerCase();
  if (/^not implemented\b|^missing\b/.test(text)) return "Missing";
  if (/^(correctly )?deferred\b/.test(text)) return "Deferred";
  if (/^retired\b/.test(text)) return "Retired";
  if (/^implemented\b/.test(text)) return "Implemented";
  if (/^partial\b/.test(text)) return "Partial";
  if (/^planned\b/.test(text)) return "Planned";
  return null;
}
function cellText(cell?: TableCell): string {
  if (!cell) return "";
  return cell.children
    .map((child) =>
      "value" in child
        ? child.value
        : "children" in child
          ? child.children
              .map((part) => ("value" in part ? part.value : ""))
              .join("")
          : "",
    )
    .join("");
}
// Apply the status filter to document tables without inventing classifications
// for prose such as "active profile/code membership" or "basic filters".
export function filterRoadmapTables({ status }: { status: string }) {
  return (tree: Root) => {
    for (const node of tree.children) {
      if (node.type !== "table" || !node.children.length) continue;
      const index = node.children[0].children.findIndex((cell) =>
        /^(status|current impala hub status)$/i.test(cellText(cell).trim()),
      );
      if (index < 0) continue;
      const [header, ...rows] = node.children;
      node.children = [
        header,
        ...rows.filter(
          (row) =>
            status === "all" ||
            roadmapStatus(cellText(row.children[index])) === status,
        ),
      ];
      for (const row of node.children.slice(1)) {
        const cell = row.children[index];
        if (!cell) continue;
        const category = roadmapStatus(cellText(cell));
        if (category)
          cell.data = {
            ...cell.data,
            hProperties: {
              ...cell.data?.hProperties,
              "data-roadmap-status": category,
            },
          };
      }
    }
  };
}
