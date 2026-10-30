import { useEffect, useRef, useState } from "react";
import { campaignsService } from "../campaignsService";
import { integrationsService } from "../integrationsService";
import {
  EDITABLE,
  isFuture,
  startOfMonth,
  type Campaign,
  type Media,
  type Post,
} from "../lib";
import type { MarketingPermission } from "../marketingPermissions";
import { POST_PAGE_SIZE, type PostSummary } from "../marketingPosts.ts";
import type { PlatformCallbacks } from "../platform/types";
import { postsService, type PostPatch } from "../postsService";
import { supabase } from "../supabase";
import type { MarketingConnections } from "./useMarketingConnections";
const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (value?: string | null) => {
  if (!value) return "";
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const emptyPost = (): Partial<Post> => ({
  title: "",
  caption: "",
  campaign_id: null,
  channels: ["facebook"],
  whatsapp_recipient_type: "contact",
  whatsapp_recipient_id: "",
  whatsapp_recipient_name: "",
  status: "draft",
  publish_at: "",
  media: [],
});
const NEEDS_ATTENTION = ["awaiting_approval", "failed"];

export function useMarketingWorkspace({
  enabled,
  sessionKey,
  page,
  connections,
  permissions,
  canMarketing,
  isAdministrator,
  setPage,
  setNotice,
  setError,
  handleError,
}: PlatformCallbacks & {
  enabled: boolean;
  sessionKey: string;
  page: string;
  connections: MarketingConnections;
  permissions: MarketingPermission[];
  canMarketing: (permission: MarketingPermission) => boolean;
  isAdministrator: boolean;
  handleError: (error: unknown) => void;
}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [postTotal, setPostTotal] = useState(0);
  const [postPage, setPostPage] = useState(0);
  const [postSummary, setPostSummary] = useState<PostSummary[]>([]);
  const [postsLoading, setPostsLoading] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignPostCounts, setCampaignPostCounts] = useState<
    Record<string, number>
  >({});
  const [filter, setFilter] = useState("all");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<Partial<Post> | null>(null);
  const [campaignModal, setCampaignModal] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(
    null,
  );
  const [campaignName, setCampaignName] = useState("");
  const [campaignObjective, setCampaignObjective] = useState("");
  const [campaignStage, setCampaignStage] = useState<
    "new" | "in_progress" | "done"
  >("new");
  const [campaignType, setCampaignType] = useState("Tips");
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [imageViewer, setImageViewer] = useState<{
    images: Post["media"];
    index: number;
  } | null>(null);
  const [view, setView] = useState<"list" | "board" | "calendar" | "pivot">(
    "list",
  );
  const [month, setMonth] = useState<Date | null>(() => startOfMonth()); // null = all months (list and board only)
  const postLoadSequence = useRef(0);
  const { integrations, setIntegrations, campaignTypes } = connections;
  const patchEditor = (changes: Partial<Post>) =>
    setEditor((e) => (e ? { ...e, ...changes } : e));

  async function load() {
    if (!sessionKey || !enabled) return;
    const sequence = ++postLoadSequence.current;
    setPostsLoading(true);
    try {
      const canReadPosts =
        canMarketing("feed.view") || canMarketing("posts.view");
      const canReadCampaigns = canMarketing("campaigns.view");
      const canUseCampaignOptions =
        canReadPosts ||
        canMarketing("feed.assign_campaign") ||
        canMarketing("posts.assign_campaign") ||
        canMarketing("campaigns.assign_campaign");
      const [p, c, counts] = await Promise.all([
        canReadPosts && page === "Feed" && supabase
          ? Promise.all(
              ["facebook", "instagram"].map((channel) =>
                postsService.list({ channel, limit: 25, preview: true }),
              ),
            ).then((pages) => ({
              items: [
                ...new globalThis.Map<string, Post>(
                  pages
                    .flatMap((p) => p.items)
                    .map((p) => [p.id, p] as [string, Post]),
                ).values(),
              ],
              total: pages.reduce((sum, p) => sum + p.items.length, 0),
              summary: [],
            }))
          : canReadPosts && page === "Posts"
            ? postsService.list({
                month: (view === "calendar" ? (month ?? startOfMonth()) : month)
                  ? `${(month ?? startOfMonth()).getFullYear()}-${String((month ?? startOfMonth()).getMonth() + 1).padStart(2, "0")}-01`
                  : "",
                campaign: campaignFilter,
                search: debouncedSearch,
                status: view === "list" ? filter : "all",
                offset: postPage * POST_PAGE_SIZE,
                summary: view === "pivot",
                preview: view === "list" || view === "board",
              })
            : Promise.resolve({ items: [], total: 0, summary: [] }),
        canReadCampaigns
          ? campaignsService.list()
          : canUseCampaignOptions && supabase
            ? campaignsService.options()
            : Promise.resolve([]),
        canReadCampaigns && supabase
          ? campaignsService.postCounts()
          : Promise.resolve([]),
        connections.load(),
      ]);
      if (sequence !== postLoadSequence.current) return;
      const result = Array.isArray(p)
        ? { items: p, total: p.length, summary: [] }
        : p;
      if (
        page === "Posts" &&
        postPage > 0 &&
        postPage * POST_PAGE_SIZE >= result.total
      ) {
        setPostPage(Math.max(0, Math.ceil(result.total / POST_PAGE_SIZE) - 1));
        return;
      }
      setPosts(result.items);
      setPostTotal(result.total);
      setPostSummary(result.summary || []);
      setCampaigns(c as Campaign[]);
      setCampaignPostCounts(
        Object.fromEntries(
          (counts as Array<{ campaign_id: string; post_count: number }>).map(
            (row) => [row.campaign_id, row.post_count],
          ),
        ),
      );
      setError("");
    } catch (e) {
      if (sequence === postLoadSequence.current) handleError(e);
    } finally {
      if (sequence === postLoadSequence.current) setPostsLoading(false);
    }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search);
      setPostPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let live = true;
    setSelectedPost(null);
    if (detailId)
      postsService
        .detail(detailId)
        .then((post) => {
          if (live) setSelectedPost(post);
        })
        .catch((error) => {
          if (live) handleError(error);
        });
    return () => {
      live = false;
    };
  }, [detailId, posts]);

  useEffect(() => {
    if (
      sessionKey &&
      enabled &&
      ["Feed", "Posts", "Post", "Campaigns"].includes(page)
    )
      void load();
  }, [
    sessionKey,
    enabled,
    permissions,
    page,
    view,
    month,
    campaignFilter,
    debouncedSearch,
    filter,
    postPage,
  ]);
  useEffect(
    () => () => {
      postLoadSequence.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (enabled) return;
    postLoadSequence.current += 1;
    setPostsLoading(false);
    setEditor(null);
    setCampaignModal(false);
    setImageViewer(null);
    setDetailId(null);
  }, [enabled]);
  // Escape closes whichever dialog is open.
  useEffect(() => {
    if (!editor && !campaignModal && !imageViewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (imageViewer) setImageViewer(null);
      else if (campaignModal) setCampaignModal(false);
      else setEditor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, campaignModal, imageViewer]);

  // Filtering and totals come from the same database query, not this loaded page.
  const visiblePosts = posts;
  const filteredPosts = posts;
  const monthPosts = posts;

  async function patchPost(id: string, changes: PostPatch, message: string) {
    try {
      await postsService.update(id, changes);
      setNotice(message);
      setError("");
      await load();
    } catch (e) {
      handleError(e);
    }
  }

  async function syncAll() {
    setBusy(true);
    setError("");
    try {
      const r = await integrationsService.sync();
      const fb =
        r.facebook?.status === "error"
          ? `Facebook error: ${r.facebook.detail || "unknown error"}`
          : r.facebook?.status === "not_connected"
            ? "Facebook not connected"
            : `Facebook synced (${r.facebook.items || 0} new, ${r.facebook.fetched || 0} checked${r.facebook.metricsUnavailable ? `; metrics unavailable for ${r.facebook.metricsUnavailable}${r.facebook.metricsErrors?.[0] ? `: ${r.facebook.metricsErrors[0]}` : ""}` : ""})`;
      const ig =
        r.instagram?.status === "synced"
          ? `Instagram synced (${r.instagram.items} items)`
          : r.instagram?.status === "not_connected"
            ? "Instagram not connected"
            : `Instagram error: ${r.instagram?.detail || "unknown error"}`;
      if (r.facebook?.syncedAt)
        setIntegrations((items) =>
          items.map((item) =>
            item.provider === "facebook"
              ? { ...item, last_synced_at: r.facebook.syncedAt }
              : item,
          ),
        );
      setNotice(
        `${fb}; ${ig}.${r.facebook?.mediaUnavailable ? ` ${r.facebook.mediaUnavailable} image previews could not be copied; temporary image URLs were not saved.` : ""}`,
      );
      if (r.facebook?.audience != null)
        setIntegrations((items) =>
          items.map((item) =>
            item.provider === "facebook"
              ? { ...item, followers_count: r.facebook.audience }
              : item,
          ),
        );
      if (r.facebook?.status === "synced") setMonth(null);
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function savePost(mode: "draft" | "schedule" | "publish-now") {
    if (!editor) return;
    const permission =
      `${page === "Feed" ? "feed" : "posts"}.${editor.id ? "edit" : "create"}` as MarketingPermission;
    if (!canMarketing(permission)) {
      setError("You do not have permission to save this post.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const status =
        mode === "schedule" ? ("scheduled" as const) : ("draft" as const);
      if (mode === "schedule" && !isFuture(editor.publish_at)) {
        throw new Error("Choose a future date and time to schedule this post.");
      }
      const payload = {
        title: editor.title ?? "",
        caption: editor.caption ?? "",
        campaign_id: editor.campaign_id || null,
        channels: editor.channels ?? [],
        whatsapp_recipient_type: editor.whatsapp_recipient_type ?? null,
        whatsapp_recipient_id: editor.whatsapp_recipient_id ?? null,
        whatsapp_recipient_name: editor.whatsapp_recipient_name ?? null,
        media: editor.media ?? [],
        status,
        publish_at: editor.publish_at
          ? new Date(editor.publish_at).toISOString()
          : null,
      };
      let saved: Post;
      if (editor.id) saved = await postsService.update(editor.id, payload);
      else saved = await postsService.create(payload);
      const facebookLive = integrations.some(
        (i) => i.provider === "facebook" && i.status === "connected",
      );
      if (mode === "publish-now") {
        if (!facebookLive)
          throw new Error("Connect Facebook in Settings before publishing.");
        await postsService.publish(saved.id);
        setNotice(
          "Publish requested. Check the post status for the confirmed Facebook result.",
        );
      } else {
        setNotice(
          status === "scheduled"
            ? facebookLive
              ? "Post scheduled. It will be published to Facebook at the chosen time while the API is running."
              : "Post saved as scheduled. Connect Facebook in Configuration so it can be published."
            : "Draft saved.",
        );
      }
      setEditor(null);
      await load();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function upload(input: HTMLInputElement) {
    const files = input.files ? Array.from(input.files) : [];
    input.value = ""; // allow choosing the same file again
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      const uploaded: Media[] = [];
      for (const file of files) {
        uploaded.push(await postsService.upload(file));
      }
      // Functional update: keeps anything typed while the upload was running.
      setEditor((e) =>
        e ? { ...e, media: [...(e.media || []), ...uploaded] } : e,
      );
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function createCampaign() {
    if (
      !(editingCampaignId
        ? canMarketing("campaigns.edit")
        : canMarketing("campaigns.create"))
    ) {
      setError("You do not have permission to save this campaign.");
      return;
    }
    if (!campaignName.trim()) return;
    try {
      const payload = {
        name: campaignName,
        objective: campaignObjective,
        stage: campaignStage,
        campaign_type: campaignType,
      };
      await (editingCampaignId
        ? campaignsService.update(editingCampaignId, payload)
        : campaignsService.create(payload));
      setCampaignName("");
      setCampaignObjective("");
      setEditingCampaignId(null);
      setCampaignModal(false);
      setNotice(editingCampaignId ? "Campaign updated." : "Campaign created.");
      await load();
    } catch (e) {
      handleError(e);
    }
  }
  async function moveCampaign(
    campaignId: string,
    stage: "new" | "in_progress" | "done",
  ) {
    if (!canMarketing("campaigns.change_status")) {
      setError("You do not have permission to change campaign status.");
      return;
    }
    try {
      await campaignsService.update(campaignId, { stage });
      setNotice("Campaign moved.");
      await load();
    } catch (e) {
      handleError(e);
    }
  }

  function openCampaignEditor(c: Campaign) {
    setEditingCampaignId(c.id);
    setCampaignName(c.name);
    setCampaignObjective(c.objective || "");
    setCampaignStage(c.stage || "new");
    setCampaignType(c.campaign_type || campaignTypes[0] || "Tips");
    setCampaignModal(true);
  }
  async function removeCampaign(c: Campaign) {
    if (!canMarketing("campaigns.delete")) {
      setError("You do not have permission to delete campaigns.");
      return;
    }
    if ((campaignPostCounts[c.id] || 0) > 0) {
      setError("Campaigns can only be deleted when they contain no posts.");
      return;
    }
    if (!window.confirm(`Delete campaign "${c.name}"?`)) return;
    try {
      await campaignsService.remove(c.id);
      setNotice("Campaign deleted.");
      await load();
    } catch (e) {
      handleError(e);
    }
  }

  async function removePost(id: string) {
    const allowed =
      page === "Feed"
        ? canMarketing("feed.delete")
        : canMarketing("posts.delete");
    if (!allowed) {
      setError("You do not have permission to delete this post.");
      return;
    }
    if (!confirm("Delete this post?")) return;
    try {
      await postsService.remove(id);
      if (detailId === id) {
        setDetailId(null);
        setPage("Posts");
      }
      await load();
      setNotice("Post deleted.");
    } catch (e) {
      handleError(e);
    }
  }

  function openPost(id: string) {
    setDetailId(id);
    setError("");
    if (page !== "Feed") setPage("Post");
  }

  // Failed posts reopen with their existing content and a safe near-future time.
  function reschedulePost(p: Post) {
    const allowed =
      page === "Feed" ? canMarketing("feed.edit") : canMarketing("posts.edit");
    if (!allowed) {
      setError("You do not have permission to reschedule this post.");
      return;
    }
    const when = new Date(Date.now() + 15 * 60 * 1000);
    setEditor({
      ...p,
      status: "draft",
      publish_at: toLocalInput(when.toISOString()),
    });
    setDetailId(null);
    if (page !== "Feed") setPage("Posts");
    setError("");
    setNotice(
      "Review the post and scheduled time, then confirm Schedule post.",
    );
  }

  // Scheduled and published posts cannot be edited, so they open the detail view instead.
  async function openEditor(p: Post) {
    const allowed =
      page === "Feed" ? canMarketing("feed.edit") : canMarketing("posts.edit");
    if (!allowed) {
      setError("You do not have permission to edit this post.");
      return;
    }
    if (EDITABLE.includes(p.status)) {
      try {
        const full = await postsService.detail(p.id);
        setEditor(full);
        setError("");
      } catch (e) {
        handleError(e);
      }
    } else openPost(p.id);
  }

  async function saveCampaign(postId: string, campaignId: string | null) {
    const allowed =
      page === "Feed"
        ? canMarketing("feed.assign_campaign")
        : canMarketing("posts.assign_campaign");
    if (!allowed) {
      setError("You do not have permission to assign this post to a campaign.");
      return;
    }
    try {
      await postsService.update(postId, { campaign_id: campaignId });
      setNotice("Campaign updated.");
      setError("");
      if (detailId === postId)
        setSelectedPost(await postsService.detail(postId));
      await load();
    } catch (e) {
      handleError(e);
    }
  }

  useEffect(() => {
    const locked = enabled && page === "Feed" && Boolean(detailId);
    if (!locked) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [enabled, page, detailId]);

  const selected = selectedPost;
  const channels = editor?.channels || [];
  const canSchedule = isFuture(editor?.publish_at);

  const openNewPost = () => {
    setEditor(emptyPost());
    setError("");
  };
  const resetFilters = () => {
    setFilter("all");
    setCampaignFilter("all");
    setMonth(startOfMonth());
  };
  return {
    newPostDefaults: emptyPost,
    openNewPost,
    resetFilters,
    posts,
    postTotal,
    postPage,
    postSummary,
    postsLoading,
    debouncedSearch,
    selectedPost,
    campaigns,
    campaignPostCounts,
    filter,
    campaignFilter,
    search,
    editor,
    campaignModal,
    editingCampaignId,
    campaignName,
    campaignObjective,
    campaignStage,
    campaignType,
    detailId,
    imageViewer,
    view,
    month,
    setPostPage,
    setFilter,
    setCampaignFilter,
    setSearch,
    setEditor,
    setCampaignModal,
    setEditingCampaignId,
    setCampaignName,
    setCampaignObjective,
    setCampaignStage,
    setCampaignType,
    setDetailId,
    setImageViewer,
    setView,
    setMonth,
    patchEditor,
    patchPost,
    syncAll,
    savePost,
    upload,
    createCampaign,
    moveCampaign,
    openCampaignEditor,
    removeCampaign,
    removePost,
    openPost,
    openEditor,
    reschedulePost,
    saveCampaign,
    load,
    selected,
    channels,
    canSchedule,
    visiblePosts,
    filteredPosts,
    monthPosts,
    canMarketing,
    isAdministrator,
    setPage,
    setError,
    handleError,
    campaignTypes,
    integrations,
    page,
    connections,
    busy: busy || connections.busy,
  };
}
export type MarketingModel = ReturnType<typeof useMarketingWorkspace>;
