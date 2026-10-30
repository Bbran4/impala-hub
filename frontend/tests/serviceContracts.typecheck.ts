import type { ClaimInput } from "../src/returnsTypes";
import type { RfqService } from "../src/rfqService";
import type { createReturnsService } from "../src/returnsService";
import type { createPostsService } from "../src/postsService";
import type { createCampaignsService } from "../src/campaignsService";
// Compiled by serviceModules.test.mjs; never executed.
export function verifyContracts(
  rfqs: RfqService,
  returns: ReturnType<typeof createReturnsService>,
  posts: ReturnType<typeof createPostsService>,
  campaigns: ReturnType<typeof createCampaignsService>,
) {
  rfqs.update("id", { remarks: "Changed", sales_code_id: null });
  rfqs.create({
    customer_name: "Customer",
    media_platform_id: "email",
    received_at: "date",
    // @ts-expect-error RFQ numbers belong to the database.
    rfq_no: "forged",
  });
  // @ts-expect-error Actors belong to the authenticated session.
  rfqs.update("id", { updated_by: "forged" });
  // @ts-expect-error Invalid category cannot be used for analytics.
  rfqs.updateOption("statuses", "id", { metric_category: "guess-from-name" });
  // @ts-expect-error Analytics year is numeric.
  rfqs.analytics({ period: "year", year: "2026", month: 1, week: 1 });
  posts.update("id", { campaign_id: null });
  // @ts-expect-error Provider identifiers are server-owned.
  posts.update("id", { provider_ids: { facebook: "forged" } });
  // @ts-expect-error Published state is server-owned.
  posts.update("id", { status: "published" });
  // @ts-expect-error Reach is server-owned.
  posts.update("id", { reach: 100 });
  // @ts-expect-error Filters accept a numeric offset.
  posts.list({ offset: "100" });
  const claim = {} as ClaimInput;
  // @ts-expect-error Claim IDs are not write inputs.
  returns.create({ ...claim, id: "forged" });
  // @ts-expect-error Campaign stage has a defined lifecycle.
  campaigns.update("id", { stage: "arbitrary" });
}
