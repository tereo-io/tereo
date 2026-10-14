import type { AxiosInstance } from "axios";

interface CursorPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Core's list endpoints cap `limit` at 200 and never return a total. */
const PAGE_SIZE = 200;

/**
 * Walks a cursor-paginated core list endpoint to the end. For pickers that
 * need every row (role permissions, user roles) — core has no `limit=0`.
 */
const fetchAllPages = async <T>(
  axios: AxiosInstance,
  endpoint: string,
  params: Record<string, string> = {}
): Promise<T[]> => {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const res: { data: CursorPage<T> } = await axios.get<CursorPage<T>>(
      endpoint,
      {
        params: {
          ...params,
          limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      }
    );
    rows.push(...res.data.data);
    cursor = res.data.hasMore ? res.data.nextCursor : null;
  } while (cursor);
  return rows;
};

export default fetchAllPages;
