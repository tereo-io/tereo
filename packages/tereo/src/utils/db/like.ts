/**
 * Escapes LIKE's wildcards (`%`, `_`) and its default escape character (`\`),
 * so a caller's text matches only itself.
 */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
