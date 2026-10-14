export interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy: Array<Record<string, "asc" | "desc">>;
  where?: Record<string, unknown>;
}
