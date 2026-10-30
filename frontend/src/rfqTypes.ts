export type MetricCategory =
  | "other"
  | "in_progress"
  | "completed"
  | "dropped"
  | "scrapped"
  | "irrelevant";
export type SalesDeskUser = {
  id: string;
  display_name: string;
  role: "administrator" | "management" | "manager" | "salesperson";
  sales_code: string | null;
};
export type ConfigOption = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  rfq_count: number;
};
export type RfqStatus = ConfigOption & {
  is_closed: boolean;
  metric_category: MetricCategory;
};
export type SalesCode = {
  id: string;
  code: string;
  is_active: boolean;
  display_name?: string;
  consultant_name?: string;
  rfq_count: number;
};
export type RfqConfig = {
  media_platforms: ConfigOption[];
  statuses: RfqStatus[];
  sales_codes: SalesCode[];
};
export type ConfigKind = "media-platforms" | "statuses" | "sales-codes";
export type ConfigPatch = {
  name?: string;
  is_active?: boolean;
  is_closed?: boolean;
  metric_category?: MetricCategory;
};
export type FieldChange = { from?: unknown; to?: unknown };
export type RfqAuditChanges = {
  actor_name?: string;
  changed?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  rfq_no?: string;
  sales_code?: string;
  from_sales_code?: string;
  to_sales_code?: string;
  from_rfq_no?: string;
  to_rfq_no?: string;
  file?: string;
} & Record<string, unknown>;
export type RfqAudit = {
  id: number;
  action: string;
  created_at: string;
  actor_user_id: string | null;
  actor_name: string;
  changes: RfqAuditChanges;
};
export type RfqAttachment = {
  id: string;
  original_name: string;
  storage_path: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  uploaded_by_name?: string;
  created_at: string;
};
export type RfqValues = {
  media_platform_id: string;
  customer_name: string;
  contact_number: string;
  email_address: string;
  query_information: string;
  received_at: string;
  claimed_at: string | null;
  sales_code_id: string | null;
  status_id: string;
  remarks: string;
  document_number: string;
};
export type RfqCreate = Pick<
  RfqValues,
  "media_platform_id" | "customer_name" | "received_at"
> &
  Partial<RfqValues>;
export type Rfq = RfqValues & {
  id: string;
  rfq_no: string;
  attachment_count?: number;
  rfq_type: "quotation" | "invoice";
  original_rfq_no: string | null;
  media_platform: string | null;
  status: string | null;
  status_name: string | null;
  status_is_closed: boolean;
  sales_code: string | null;
  attachments?: RfqAttachment[];
  audit_history?: RfqAudit[];
};
export type RawRfq = Omit<Rfq, "media_platform" | "status" | "sales_code"> & {
  media_platform: { name: string } | null;
  status: { name: string; is_closed: boolean } | null;
  sales_code: { code: string } | null;
};
export type RfqList = {
  items: Rfq[];
  total: number;
  limit: number;
  offset: number;
};
export type DailySales = {
  sales_person: string;
  total_sales: number;
  total_credits: number;
  gross_sales: number;
  gp_percent: number;
};
export type RfqPerformance = {
  id: string;
  sales_person: string;
  in_progress: number;
  complete: number;
  dropped: number;
  scrapped: number;
  irrelevant: number;
  total: number;
  bonus_points?: number;
  response_time?: string;
  score?: number;
};
export type RfqDashboard = {
  business_date?: string;
  unclaimed: number;
  claimed: number;
  received_today: number;
  open: number;
  monthly_sales?: {
    has_data: boolean;
    gross_sales: number;
    gp_percent: number;
  };
  daily_sales?: DailySales[];
  rfq_performance?: RfqPerformance[];
};
export type AnalyticsCounts = {
  claimed: number;
  scrapped: number;
  dropped: number;
  completed: number;
  invoiced: number;
};
export type RfqAnalytics = {
  period?: string;
  year?: number;
  start_date?: string;
  end_date?: string;
  totals: Partial<AnalyticsCounts>;
  series: (AnalyticsCounts & { date: string; label: string })[];
};
export type AnalyticsFilters = {
  period: "year" | "month" | "week";
  year: number;
  month: number;
  week: number;
};
