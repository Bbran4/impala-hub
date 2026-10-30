export type PostWriteStatus = "draft" | "awaiting_approval" | "scheduled";
export type Media = {
  id: string;
  name: string;
  url: string;
  content_type?: string;
  size?: number;
};
export type Campaign = {
  id: string;
  name: string;
  objective: string;
  campaign_type: string;
  stage: "new" | "in_progress" | "done";
  start_date?: string | null;
  end_date?: string | null;
};
export type Post = {
  id: string;
  title: string;
  caption: string;
  campaign_id: string | null;
  channels: string[];
  whatsapp_recipient_type?: string | null;
  whatsapp_recipient_id?: string | null;
  whatsapp_recipient_name?: string | null;
  status: string;
  publish_at?: string | null;
  published_at?: string | null;
  media: Media[];
  media_count?: number;
  last_error?: string | null;
  provider_ids?: Record<string, string>;
  clicks?: number | null;
  reach?: number | null;
  impressions?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  reactions?: number | null;
  saves?: number | null;
  views?: number | null;
  metrics_refreshed_at?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type HistoryEntry = {
  id: number;
  action: string;
  created_at: string;
  details: {
    actor_name?: string;
    status?: string;
    channels?: string[];
    changed?: string[];
  };
};
