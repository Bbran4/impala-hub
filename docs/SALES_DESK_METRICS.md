# Sales Desk metrics contract

Migration `0095_sales_desk_metrics.sql` adds database aggregation and explicit status categories. Confirm the connected Supabase production project has successfully applied 0095 before using this frontend. The Supabase GitHub integration may apply it separately from Vercel; a successful Vercel build alone does not confirm database rollout.

- Both RPCs run with invoker security: application view permission is checked, existing RFQ RLS still applies, and archived rows are always excluded. Aggregation returns one JSON object, independent of PostgREST row limits.
- Claimed means currently assigned (`sales_code_id is not null`). A status or a historic claim timestamp alone does not count as ownership.
- Today, calendar years/months and chart buckets use `Africa/Johannesburg`. Analytics selects RFQs by `received_at`, including the lower boundary and excluding the upper boundary.
- ISO weeks run Monday–Sunday and use an ISO year. Week 1 can start in the preceding calendar year; week 53 is rejected for ISO years without it. Historical years can be selected.
- Cards and charts use the same selected cohort. These are current outcomes of received RFQs, not a count of historical status-change events. Invoice copies are counted as separate records. Completed analytics excludes invoice copies.
- Each status has an administrator-editable `metric_category`. Renaming a status never changes its category. Known seed statuses get exact initial mappings; custom statuses start Unclassified and should be reviewed under Sales Desk Configuration. Quotation Issued remains unclassified rather than being assumed to be a completed sale.
- RFQ performance is grouped by active sales codes owned by active profiles visible to the caller. Old seeded performance figures are not used. Daily/monthly monetary figures use only non-temporary sales records whose salesperson key matches an active profile sales code. Monthly GP% is weighted by gross sales; missing verified data is labelled explicitly.

Database regression tests cover more than 1,000 rows, archives, assignment, Johannesburg midnight, prior years, ISO year boundaries, leap years, invalid periods, renames, chart totals and salesperson/inactive/signed-out access. Hosted checks should also confirm the intended mappings for custom statuses and the production permission configuration.
