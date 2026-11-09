import {
  decodeListCursor,
  encodeListCursor,
} from "../../../../utils/cursor.js";

// Group lists page by id: the db layer takes the last id of the previous
// page, carried in a signed cursor bound to the list's path.
const ID_ORDER = { sort: "id", sortDir: "asc" } as const;

/** The last id of the previous page, from a signed cursor. */
export const cursorId = (cursor: string | undefined): string | undefined =>
  cursor === undefined
    ? undefined
    : String(decodeListCursor(cursor, ID_ORDER).id);

export const nextCursor = (page: {
  data: { id: string }[];
  hasMore: boolean;
}): string | null => {
  const last = page.data[page.data.length - 1];
  return page.hasMore && last
    ? encodeListCursor({ ...ID_ORDER, sortValue: last.id, id: last.id })
    : null;
};
