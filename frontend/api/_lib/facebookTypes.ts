export type FacebookPageChoice = {
  id: string;
  name: string;
  tasks?: string[];
  token: string;
};
export type FacebookPageToken = {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
};
export type FacebookGraphPost = {
  id?: string;
  from?: { id?: string };
  message?: string;
  created_time?: string;
  permalink_url?: string;
};
export type FacebookGraphRead = FacebookGraphPost & {
  error?: unknown;
  data?: FacebookGraphPost[];
  paging?: { next?: string };
};
export type FacebookPublishPost = {
  id: string;
  caption?: string;
  title?: string;
  media?: unknown;
  provider_ids?: Record<string, string>;
};
export type FacebookConnection = {
  page_id?: string;
  token_ciphertext?: string;
};
export type StoredFacebookMedia = Record<string, unknown> & { url: string };
