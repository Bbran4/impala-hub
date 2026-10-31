import { requireSupabase } from "./supabase";
import {
  validateMilestones,
  type SalesMilestoneSettings,
} from "./milestoneSettings";
export async function loadSalesMilestones(): Promise<SalesMilestoneSettings> {
  const result = await requireSupabase().rpc("get_sales_desk_milestones");
  if (result.error) throw new Error(result.error.message);
  if (!result.data)
    throw new Error("Sales milestone settings are unavailable.");
  return result.data as SalesMilestoneSettings;
}
export async function saveSalesMilestones(
  settings: SalesMilestoneSettings,
): Promise<SalesMilestoneSettings> {
  const result = await requireSupabase().rpc("save_sales_desk_milestones", {
    p_sales: validateMilestones(settings.sales, "sales"),
    p_gp: validateMilestones(settings.gp, "gp"),
    p_expected_version: settings.version,
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data)
    throw new Error("The saved milestone settings were not returned.");
  return result.data as SalesMilestoneSettings;
}
