# Impala Hub administrator settings behaviour

## Scope

The platform has one administrator-only Settings workspace. It is opened from a
Settings item directly below Apps Dashboard and is not part of any individual
workspace navigation.

The page uses a two-column layout:

1. An application menu containing Marketing, Sales Desk, Returns & Claims,
   Smart Stock Control, Fleet Management, E-commerce and Reporting.
2. The selected application's settings and access list.

Marketing contains Social media channels and Campaign types. The other
applications initially contain only Who can open this app.

## Access model

- Only active users with the `administrator` role can open Settings, list all
  employee access, or change application access.
- Administrators always have access to every application.
- Management users retain their existing inherited access to current business
  applications. Inherited access is displayed but cannot be removed from an
  individual application; their platform role must be changed separately.
- Other users receive access through the application's existing role:
  `marketing`, `sales`, `returns`, `stock`, `fleet`, `ecommerce` or `reporting`.
- Fleet Management and E-commerce remain planned applications, but their roles
  can be prepared in Settings without making the application cards available.
- Every role assignment or removal is attributed to the administrator and
  stored in an audit table.
- The database, not the browser, validates administrator authority and the
  allowed application identifiers.

## Marketing settings

- Social media channel controls preserve the existing connect/reconnect, Page
  choice, connection check and disconnect behaviour. The selected connection is
  shared by the Marketing workspace rather than owned by one employee.
- OAuth callbacks return the administrator to Settings.
- Server-side endpoints that change the shared Facebook connection require an
  administrator; ordinary Marketing users may still read and use the shared
  connection for their normal workspace duties.
- Browser roles have no direct table access to encrypted provider connection
  rows; status responses expose only non-secret connection health and identity.
- Campaign types remain readable by active users but can only be created,
  reordered or deleted by administrators.

## State and edge cases

- A signed-out user cannot see Apps Dashboard content or Settings.
- A non-administrator navigating directly to Settings is returned to Apps.
- Changing the selected application reloads the authoritative access list.
- A failed save restores the previous checkbox state and shows the database
  error.
- Deactivated profiles are not offered new application access.
- Administrators and inherited platform users are visibly marked and their
  application checkbox is disabled.
- Existing app role assignments remain valid after the migration.

## Acceptance examples

1. An administrator opens Settings, selects Returns & Claims, grants an active
   employee access, and that employee sees the application after signing in or
   refreshing.
2. A Marketing employee does not see Settings and a direct RPC attempt to grant
   Reporting access fails with permission error `42501`.
3. The administrator connects or checks Facebook from Settings > Marketing and
   the Marketing workspace immediately uses the same shared connection.
4. The administrator adds a campaign type; a Marketing employee can use it but
   cannot add or delete campaign types directly.
5. Selecting Fleet Management shows its access list and planned status without
   exposing a Fleet application card to assigned users yet.

