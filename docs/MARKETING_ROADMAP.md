# Impala Hub Marketing Roadmap

Updated: 2026-10-28

This workspace tracks parity between the Odoo Social Marketing workflow and the current Supabase/Vercel Impala Hub deployment. Older FastAPI provider routes are legacy implementation evidence and are not treated as active hosted capabilities.

## Current priorities

1. Expand search to campaigns and advanced filters.
2. Add notifications and social conversations.
3. Add sentiment analysis and advanced reporting.
4. Keep Instagram connectivity, publishing and insights deferred until that migration resumes.

## Parity table

| Capability | Odoo | Impala Hub | Status |
|---|---|---|---|
| Sign-in | Odoo authentication | Impala Hub session login | Implemented |
| Persistent session | Yes | Persistent session with retry protection | Implemented |
| Logout | Yes | Yes | Implemented |
| Facebook connection | Social account configuration | Meta OAuth, Page selection, diagnostics, disconnect | Implemented |
| Instagram connection | Social account configuration | Schema and UI foundation; Supabase OAuth is disabled | Deferred |
| WhatsApp | Not central | Deferred | Correctly deferred |
| Feed | Account feeds, streams, metrics | Network columns, 25 newest posts, metrics | Implemented; provider availability applies |
| Create post | New Post workflow | Create Post editor | Implemented |
| Edit draft posts | Yes | Yes | Implemented |
| Edit scheduled/published posts | Odoo record editing | Restricted; campaign can still be changed | Partial by design |
| Delete posts | Record actions | Facebook-safe local deletion | Implemented |
| Schedule posts | Yes | Yes | Implemented |
| Publish now | Yes | Facebook workflow | Partial |
| Facebook publishing | Yes | OAuth/Page publishing | Implemented |
| Instagram publishing | Yes | Not enabled on the Supabase deployment | Deferred |
| Likes | Yes | Stored/displayed where synced, including reactions and saves | Implemented; provider availability applies |
| Comments | Yes | Stored/displayed where synced | Implemented; provider availability applies |
| Shares | Yes | Provider shares | Implemented; provider availability applies |
| Views | Yes | Facebook post views and provider fallbacks | Implemented; provider availability applies |
| Clicks | Yes | Post model and Facebook/Instagram provider paths | Implemented; provider availability applies |
| Reach | Odoo insights | Facebook/Instagram fields and fallbacks | Implemented; provider availability applies |
| Impressions | Odoo insights | Facebook/Instagram fields | Partial |
| Post analytics detail | Post cards and insights | Post detail performance metrics | Implemented; provider availability applies |
| Campaign creation | Yes | Yes | Implemented |
| Campaign editing | Yes | Title/objective editing | Implemented |
| Campaign deletion | Available through record actions | Empty campaigns can be deleted; campaigns with posts are protected | Implemented |
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

- Facebook is the active social provider. Instagram and WhatsApp are deferred.
- Disconnecting a provider removes mirrored published records locally; it does not delete provider content.
- The Posts manager retains the full local history; the Feed displays the 25 newest posts per connected network.
- Facebook Views, reach and clicks are implemented with current Meta post insight fallbacks; live provider responses determine which values are available for a specific post.


## Search status

Marketing currently provides literal substring search over post titles and captions plus basic status, campaign and month filters. Campaign-name search, saved filters and true wildcard-pattern syntax remain planned.


## Recently completed

- Campaign deletion is available for empty campaigns only. Campaigns containing posts are protected from deletion.


## Metrics status update

- Facebook post Views and Reach retrieval is implemented using current Meta post insight metrics with fallbacks.
- Post Likes, Reactions, Saves, Comments and Shares are stored and used in engagement totals; availability depends on the provider response.
- Post analytics detail is implemented for the metrics returned by the connected provider.


## Completion update

- Clicks are implemented through the post model and Facebook/Instagram provider sync paths.
- The Feed is implemented with separate network columns, the 25 newest posts per network, and network/post metrics.
