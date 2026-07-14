/** Default scope for normal Person reads and writes. Archived merge sources are audit-only records. */
export const activePersonWhere = { archivedAt: null } as const;
