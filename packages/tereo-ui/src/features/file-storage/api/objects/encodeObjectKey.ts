/**
 * Encode an object key for core's `*objectKey` splat routes. Each segment is
 * percent-encoded and the slashes kept, so keys holding characters core
 * allows but URLs reserve (`#`, `?`, `&`, `+`, spaces, …) reach the server
 * intact. Express decodes each segment back before validation.
 */
const encodeObjectKey = (objectKey: string): string =>
  objectKey.split("/").map(encodeURIComponent).join("/");

export default encodeObjectKey;
