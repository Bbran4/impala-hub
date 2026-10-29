export const MARKETING_PERMISSION_GROUPS = [
  {
    id: 'feed', label: 'Feed', actions: [
      ['feed.view', 'View'], ['feed.create', 'Create'], ['feed.edit', 'Edit'],
      ['feed.delete', 'Delete'], ['feed.manage_accounts', 'Manage accounts'],
      ['feed.assign_campaign', 'Assign to campaign'],
    ],
  },
  {
    id: 'posts', label: 'Posts', actions: [
      ['posts.view', 'View'], ['posts.create', 'Create'], ['posts.edit', 'Edit'],
      ['posts.delete', 'Delete'], ['posts.assign_campaign', 'Assign to campaign'],
    ],
  },
  {
    id: 'campaigns', label: 'Campaigns', actions: [
      ['campaigns.view', 'View'], ['campaigns.create', 'Create'], ['campaigns.edit', 'Edit'],
      ['campaigns.delete', 'Delete'], ['campaigns.assign_campaign', 'Assign to campaign'],
      ['campaigns.change_status', 'Change status'],
    ],
  },
] as const

export type MarketingPermission = typeof MARKETING_PERMISSION_GROUPS[number]['actions'][number][0]

export const ALL_MARKETING_PERMISSIONS = MARKETING_PERMISSION_GROUPS.flatMap((group) =>
  group.actions.map(([permission]) => permission),
) as MarketingPermission[]

