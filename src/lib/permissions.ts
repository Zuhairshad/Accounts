export const permissions = [
  "view", "create", "edit", "delete", "restore", "post", "export", "print", "approve",
  "close_period", "view_combined", "manage_company", "manage_users", "manage_roles",
] as const;

export type Permission = typeof permissions[number];

export const defaultRoles: { name: string; permissions: Permission[] }[] = [
  { name: "Company Admin", permissions: [...permissions] },
  { name: "Accounts Manager", permissions: ["view", "create", "edit", "delete", "restore", "post", "export", "print", "approve", "close_period", "view_combined"] },
  { name: "Accountant", permissions: ["view", "create", "edit", "post", "export", "print"] },
  { name: "Data Entry Operator", permissions: ["view", "create", "edit"] },
  { name: "Viewer / Auditor", permissions: ["view", "export", "print"] },
];
