# Notifications

Each notification has a separate Delete button. Deletion affects only its recipient, removes it from the list and unread totals, and survives refresh. The underlying event and deduplication key remain stored with `dismissed_at` so provider retries do not recreate deleted alerts. Browser clients cannot update notification rows directly; `delete_user_notification` checks the active recipient.

Opening uses `open_user_notification` to resolve the current record before navigating. RFQ links check the caller's current row permissions and exclude soft-deleted RFQs. A stale RFQ notification is dismissed and the panel explains that the RFQ was deleted or is no longer available. Notifications belonging to another recipient return no details. RFQ detail loading also shows the same clear message if deletion happens after the initial check, including links opened from chat.

Deletion is per notification. It does not delete the RFQ, chat message, audit history or another user's notification.
