import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCheck, MessageCircle, RefreshCw, X } from "lucide-react";
import { supabase } from "./supabase";

export type NotificationChannel =
  | "marketing"
  | "sales_desk"
  | "returns_claims"
  | "stock_control"
  | "reporting"
  | "system";

export type UserNotification = {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  kind: string;
  title: string;
  description: string;
  target_page: string | null;
  target_record_id: string | null;
  read_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
};

type Props = {
  enabled: boolean;
  channels: NotificationChannel[];
  onNavigate: (notification: UserNotification) => void;
  onOpenChat: () => void;
  onError: (message: string) => void;
};

const LABELS: Record<NotificationChannel, string> = {
  marketing: "Marketing",
  sales_desk: "Sales Desk",
  returns_claims: "Returns & Claims",
  stock_control: "Smart Stock",
  reporting: "Reporting",
  system: "System",
};

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

export default function NotificationCentre({
  enabled,
  channels,
  onNavigate,
  onOpenChat,
  onError,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeChannel, setActiveChannel] = useState<
    "all" | NotificationChannel
  >("all");
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({
    __all__: 0,
  });
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loadGeneration = useRef(0);
  const hadLoadError = useRef(false);
  const active = enabled && authenticated;

  useEffect(() => {
    if (!enabled || !supabase) {
      setAuthenticated(false);
      return;
    }
    let mounted = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) setAuthenticated(Boolean(data.session));
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (mounted) setAuthenticated(Boolean(session));
      },
    );
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [enabled]);

  const load = useCallback(
    async (quiet = false) => {
      if (!active || !supabase) return;
      const generation = ++loadGeneration.current;
      if (!quiet) setLoading(true);
      const [listResult, countResult] = await Promise.all([
        supabase
          .from("user_notifications")
          .select(
            "id,user_id,channel,kind,title,description,target_page,target_record_id,read_at,created_at,metadata",
          )
          .order("created_at", { ascending: false })
          .limit(100),
        supabase.rpc("user_notification_unread_counts"),
      ]);
      if (generation !== loadGeneration.current) return;
      const error = listResult.error || countResult.error;
      if (error) {
        hadLoadError.current = true;
        if (!quiet) onError(`Could not load notifications: ${error.message}`);
      } else {
        if (hadLoadError.current) {
          hadLoadError.current = false;
          onError("");
        }
        setNotifications((listResult.data || []) as UserNotification[]);
        setUnreadCounts(
          Object.fromEntries(
            (countResult.data || []).map((row: any) => [
              row.notification_channel,
              Number(row.unread_count || 0),
            ]),
          ),
        );
      }
      if (!quiet) setLoading(false);
    },
    [active, onError],
  );

  useEffect(() => {
    if (!active) {
      loadGeneration.current += 1;
      setNotifications([]);
      setUnreadCounts({ __all__: 0 });
      setOpen(false);
      return;
    }
    void load(true);
    const timer = window.setInterval(() => void load(true), 30_000);
    const refresh = () => void load(true);
    window.addEventListener("focus", refresh);
    return () => {
      loadGeneration.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [active, load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const visibleChannels = useMemo(
    () => Array.from(new Set([...channels, "system" as const])),
    [channels],
  );
  const visible =
    activeChannel === "all"
      ? notifications
      : notifications.filter((item) => item.channel === activeChannel);
  const unread = unreadCounts.__all__ || 0;
  const unreadInView =
    activeChannel === "all" ? unread : unreadCounts[activeChannel] || 0;

  function closePanel(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  async function markRead(notification: UserNotification) {
    if (!active || !supabase || notification.read_at) return;
    const { error } = await supabase.rpc("mark_user_notification_read", {
      notification_id: notification.id,
    });
    if (error) {
      onError(`Could not mark notification as read: ${error.message}`);
    }
    await load(true);
  }

  async function markAllRead() {
    if (!active || !supabase || !unreadInView) return;
    const channel = activeChannel === "all" ? null : activeChannel;
    const { error } = await supabase.rpc("mark_all_user_notifications_read", {
      notification_channel: channel,
    });
    if (error) {
      onError(`Could not mark notifications as read: ${error.message}`);
    }
    await load(true);
  }

  async function openNotification(notification: UserNotification) {
    await markRead(notification);
    closePanel(false);
    onNavigate(notification);
  }

  if (!active) return null;

  return (
    <div className="notification-centre">
      <button
        type="button"
        ref={triggerRef}
        className="notification-trigger"
        aria-label={
          unread ? `Notifications, ${unread} unread` : "Notifications"
        }
        aria-expanded={open}
        aria-controls="impala-notification-panel"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
      >
        <span className="notification-trigger-icon">
          <Bell size={17} />
          {unread > 0 && <b>{unread > 99 ? "99+" : unread}</b>}
        </span>
        <span>Notifications</span>
      </button>

      {open && (
        <section
          id="impala-notification-panel"
          className="notification-panel"
          aria-label="Notification centre"
        >
          <header className="notification-panel-head">
            <div>
              <span className="eyebrow">IMPALA HUB</span>
              <h2>Notifications</h2>
            </div>
            <div className="notification-head-actions">
              <button
                className="icon-button"
                title="Refresh"
                aria-label="Refresh notifications"
                onClick={() => void load()}
              >
                <RefreshCw size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Close notifications"
                onClick={() => closePanel()}
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div className="notification-panel-actions">
            <button
              className="secondary"
              onClick={() => { closePanel(false); onOpenChat() }}
            >
              <MessageCircle size={15} /> Chat
            </button>
            {unreadInView > 0 && (
              <button
                className="text-button"
                onClick={() => void markAllRead()}
              >
                <CheckCheck size={15} /> Mark all read
              </button>
            )}
          </div>

          <>
              <nav
                className="notification-channels"
                aria-label="Notification channels"
              >
                <button
                  className={activeChannel === "all" ? "active" : ""}
                  onClick={() => setActiveChannel("all")}
                >
                  All
                </button>
                {visibleChannels.map((channel) => {
                  const count = unreadCounts[channel] || 0;
                  return (
                    <button
                      key={channel}
                      className={activeChannel === channel ? "active" : ""}
                      onClick={() => setActiveChannel(channel)}
                    >
                      {LABELS[channel]}
                      {count > 0 && <span>{count}</span>}
                    </button>
                  );
                })}
              </nav>
              <div className="notification-list">
                {loading ? (
                  <div className="notification-empty">
                    Loading notifications…
                  </div>
                ) : visible.length ? (
                  visible.map((notification) => (
                    <button
                      key={notification.id}
                      className={`notification-item ${notification.read_at ? "" : "unread"}`}
                      onClick={() => void openNotification(notification)}
                    >
                      <span className="notification-item-channel">
                        {LABELS[notification.channel]}
                      </span>
                      <strong>{notification.title}</strong>
                      {notification.description && (
                        <p>{notification.description}</p>
                      )}
                      <time dateTime={notification.created_at}>
                        {formatDate(notification.created_at)}
                      </time>
                    </button>
                  ))
                ) : (
                  <div className="notification-empty">
                    <Bell size={26} />
                    <h3>No notifications here</h3>
                    <p>New activity for this channel will appear here.</p>
                  </div>
                )}
              </div>
            </>
        </section>
      )}
    </div>
  );
}
