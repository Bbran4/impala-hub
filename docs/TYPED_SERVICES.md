# Typed workspace services

The browser no longer translates REST URL strings into Supabase operations. `lib.ts` contains only presentation helpers and compatibility exports; it has no network requests or URL router.

- `rfqService.ts`: RFQ lists/details, transactional create/update/claim/archive/convert, configuration, analytics and attachments. A factory accepts the legacy session token and an optional Supabase client for testing.
- `returnsService.ts`: claim lists/details, whitelisted writes, supplier workflow normalization, archive and attachments.
- `postsService.ts`: bounded filtered post pages, detail/history, validated save RPCs, publishing and media uploads.
- `campaignsService.ts`: campaigns, permitted campaign choices, grouped post counts and campaign type management.
- `integrationsService.ts`: named Facebook/Instagram operations against the actual Marketing server endpoints.
- `authService.ts`: sign-out for both Supabase and the older backend.

The workspace types define records, write inputs, forms, attachment metadata, audit changes, configuration and analytics results. In particular, post writes exclude provider IDs and metrics and accept only draft/awaiting-approval/scheduled status; RFQ writes exclude generated numbers and actors. Forms explicitly allow the string values produced by number inputs. Claim records use numeric quantities and receipt amounts. Unstructured historical audit values use `unknown` and are narrowed before rendering.

`serviceTransport.ts` handles real HTTP requests, current-session authorization and errors. It never interprets paths or dispatches Supabase operations. Each service owns its older-backend fallback; screens use the same named methods with either backend. Failed HTTP mutations are not automatically retried.

Supabase JSON RPC responses currently require explicit domain assertions at service boundaries; these are maintained TypeScript contracts rather than a generated database schema or runtime schema validator. Database policies, validation, transactional commands and audit triggers remain authoritative. This refactor requires no migration.

Regression tests in `serviceModules.test.mjs` inject fake clients and HTTP responses, exercise pagination under reduced response caps, RPC errors/cardinality, attachment cleanup, safe claim payloads, session caching and legacy requests. The same test compiles `serviceContracts.typecheck.ts` to ensure invalid write fields and filter types stay rejected. Existing Returns workflow/report/export, Marketing filtering and session tests also apply.
