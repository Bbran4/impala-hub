import { normalizeColor } from "./colorValues.ts";
export type Milestone = { value: number; color: string };
export type MilestoneKind = "sales" | "gp";
export type SalesMilestoneSettings = {
  sales: Milestone[];
  gp: Milestone[];
  version: number;
  configured: boolean;
};

export function validateMilestones(
  items: Milestone[],
  kind: MilestoneKind,
): Milestone[] {
  if (!Array.isArray(items) || items.length > 50)
    throw new Error("Use no more than 50 milestones per group.");
  const seen = new Set<number>();
  return items
    .map((item) => {
      if (
        !Number.isFinite(item.value) ||
        item.value < 0 ||
        (kind === "sales" && item.value === 0) ||
        item.value > (kind === "gp" ? 100 : 999999999999.99) ||
        Math.abs(item.value * 100 - Math.round(item.value * 100)) > 0.0001
      )
        throw new Error(
          kind === "gp"
            ? "GP% milestones must be between 0 and 100, with up to two decimals."
            : "Sales milestones must be positive amounts with up to two decimals.",
        );
      if (seen.has(item.value))
        throw new Error(
          "Each milestone in a group must have a different value.",
        );
      seen.add(item.value);
      const color = normalizeColor(item.color);
      if (!color) throw new Error("Choose a valid milestone colour.");
      return { value: item.value, color };
    })
    .sort((a, b) => a.value - b.value);
}

// Recover old browser-only settings only when an administrator explicitly imports
// them. Never let an old browser silently overwrite the shared database values.
export function readBrowserMilestones(
  storage: Pick<Storage, "getItem">,
): Partial<Pick<SalesMilestoneSettings, MilestoneKind>> | null {
  try {
    const result: Partial<Pick<SalesMilestoneSettings, MilestoneKind>> = {};
    for (const kind of ["sales", "gp"] as const) {
      const raw = storage.getItem(
        kind === "sales"
          ? "sales_desk_gp_milestones"
          : "sales_desk_gp_percent_milestones",
      );
      if (raw === null) continue;
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.some((v) => typeof v !== "number"))
        continue;
      const colors = JSON.parse(
        storage.getItem(
          kind === "sales"
            ? "sales_desk_gp_milestone_colors"
            : "sales_desk_gp_percent_colors",
        ) || "{}",
      );
      const sorted = [...values].sort((a, b) => a - b);
      result[kind] = validateMilestones(
        sorted.map((value, index) => ({
          value,
          color:
            normalizeColor(String(colors?.[String(value)] || "")) ||
            (kind === "gp" || index === sorted.length - 1
              ? "#234e70"
              : index === 0
                ? "#7b8790"
                : "#6ba8d2"),
        })),
        kind,
      );
    }
    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}
