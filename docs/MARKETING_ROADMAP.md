# Impala Hub Marketing Roadmap

Updated: 2026-10-21

This workspace tracks parity between the Odoo Social Marketing workflow and Impala Hub Marketing.

## Current priorities

1. Resolve Facebook post Views, reach, impressions, and boosted-performance collection.
2. Verify Instagram boosted metrics and publishing against a live professional account.
3. Complete campaign deletion.
4. Expand search/filter panels and reporting.
5. Add notifications, social conversations, and sentiment analysis.

## Parity table

| Capability | Odoo | Impala Hub | Status |
|---|---|---|---|
| Sign-in | Odoo authentication | Impala Hub session login | Implemented |
| Persistent session | Yes | Persistent session with retry protection | Implemented |
| Logout | Yes | Yes | Implemented |
| Facebook connection | Social account configuration | Meta OAuth, Page selection, diagnostics, disconnect | Implemented |
| Instagram connection | Social account configuration | Meta OAuth for professional accounts | Implemented; live connection working |
| WhatsApp | Not central | Deferred | Correctly deferred |
| Feed | Account feeds, streams, metrics | Network columns, 25 newest posts, metrics | Partial |
| Create post | New Post workflow | Create Post editor | Implemented |
| Edit draft posts | Yes | Yes | Implemented |
| Edit scheduled/published posts | Odoo record editing | Restricted; campaign can still be changed | Partial by design |
| Delete posts | Record actions | Facebook-safe local deletion | Implemented |
| Schedule posts | Yes | Yes | Implemented |
| Publish now | Yes | Facebook workflow | Partial |
| Facebook publishing | Yes | OAuth/Page publishing | Implemented |
| Instagram publishing | Yes | OAuth/API foundation | Partial; live publishing verification required |
| Likes | Yes | Stored/displayed where synced | Partial |
| Comments | Yes | Stored/displayed where synced | Partial |
| Shares | Yes | Facebook shares | Partial |
| Views | Yes | Reach/impression/view fields and fallbacks | Partial; Facebook Views still unresolved |
| Clicks | Yes | Post model and provider paths | Partial |
| Reach | Odoo insights | Facebook/Instagram fields | Partial |
| Impressions | Odoo insights | Facebook/Instagram fields | Partial |
| Post analytics detail | Post cards and insights | Post details and metrics | Partial |
| Campaign creation | Yes | Yes | Implemented |
| Campaign editing | Yes | Title/objective editing | Implemented |
| Campaign deletion | Available through record actions | Not exposed as a complete workflow | Incomplete |
| Campaign Kanban stages | New/In Progress/Done | Drag-and-drop Kanban | Implemented |
| Campaign cards | Posts and engagement context | Clean cards without inline listings | Implemented |
| Post Kanban | Yes | Board view | Implemented |
| Post calendar | Yes | Calendar view | Implemented |
| Post list | Yes | List view | Implemented |
| Post pivot reporting | Yes | Grouped Pivot-style insights table | Implemented |
| Search/filtering | Extensive search panels | Basic search, status, campaign, month filters | Partial |
| Social conversations | Channels and chats | Not implemented | Missing |
| Sentiment analysis | Visible in Channels | Not implemented | Missing |
| Notifications | Odoo activities/messages | Not implemented | Missing |
| RFQ dashboard | Not applicable | Sales Desk dashboard | Implemented separately |
| RFQ analytics | Not applicable | Sales Desk analytics | Implemented separately |
| User-to-sales-code mapping | Not applicable | Sales Desk mapping | Implemented |

## Acceptance notes

- Facebook and Instagram are the only active social providers.
- Disconnecting a provider removes mirrored published records locally; it does not delete provider content.
- The Posts manager retains the full local history; the Feed displays the 25 newest posts per connected network.
- Facebook Views must not be marked complete until a live Refresh populates total views/reach/impressions.


## Wildcard search

Marketing roadmap now includes wildcard search across posts, campaigns, captions and supported searchable fields.
