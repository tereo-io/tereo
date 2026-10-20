import { PreconditionFailedError } from "./errors.js";
import type { Request, Response } from "express";

export interface EntityTag {
  weak: boolean;
  opaque: string;
}

/**
 * An `If-Match` / `If-None-Match` value: `*`, or a comma-separated list of
 * entity tags (RFC 9110 §8.8.3). A bare token without quotes is read as a
 * strong tag, for clients that never quoted theirs. Null without the header.
 */
export const parseEntityTagList = (
  header: string | undefined
): EntityTag[] | "*" | null => {
  if (header === undefined) return null;
  if (header.trim() === "*") return "*";
  return header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const weak = s.startsWith("W/");
      const tag = weak ? s.slice(2) : s;
      const opaque =
        tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')
          ? tag.slice(1, -1)
          : tag;
      return { weak, opaque };
    });
};

/** `If-Match`: strong comparison, so a weak tag never matches. */
export const ifMatchPasses = (list: EntityTag[] | "*", etag: string) =>
  list === "*" || list.some((t) => !t.weak && t.opaque === etag);

/** `If-None-Match` matches by weak comparison: `W/` is ignored. */
export const ifNoneMatchMatches = (list: EntityTag[] | "*", etag: string) =>
  list === "*" || list.some((t) => t.opaque === etag);

const parseHttpDate = (header: string | undefined): number | null => {
  if (header === undefined) return null;
  const time = Date.parse(header);
  return Number.isNaN(time) ? null : time;
};

/** HTTP dates have whole seconds. */
const toSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export interface RepresentationValidators {
  etag: string;
  lastModified?: Date;
}

/**
 * The preconditions of RFC 9110 §13.2.2 for a read of an existing
 * representation, in its order: `If-Match`, else `If-Unmodified-Since`
 * (412); then `If-None-Match`, else `If-Modified-Since` (304).
 */
export const evaluateReadPreconditions = (
  req: Request,
  validators: RepresentationValidators
): "proceed" | "not_modified" | "precondition_failed" => {
  const { etag, lastModified } = validators;

  const ifMatch = parseEntityTagList(req.header("If-Match"));
  if (ifMatch) {
    if (!ifMatchPasses(ifMatch, etag)) return "precondition_failed";
  } else {
    const since = parseHttpDate(req.header("If-Unmodified-Since"));
    if (
      since !== null &&
      lastModified &&
      toSeconds(lastModified) > Math.floor(since / 1000)
    ) {
      return "precondition_failed";
    }
  }

  const ifNoneMatch = parseEntityTagList(req.header("If-None-Match"));
  if (ifNoneMatch) {
    if (ifNoneMatchMatches(ifNoneMatch, etag)) {
      return req.method === "GET" || req.method === "HEAD"
        ? "not_modified"
        : "precondition_failed";
    }
  } else if (req.method === "GET" || req.method === "HEAD") {
    const since = parseHttpDate(req.header("If-Modified-Since"));
    if (
      since !== null &&
      lastModified &&
      toSeconds(lastModified) <= Math.floor(since / 1000)
    ) {
      return "not_modified";
    }
  }

  return "proceed";
};

/**
 * Answer a download's preconditions: throws `412`, or ends the response as
 * `304` and returns true. A 304 carries the headers already set, so set
 * `ETag`, `Last-Modified` and `Cache-Control` before calling this.
 */
export const answerReadPreconditions = (
  req: Request,
  res: Response,
  validators: RepresentationValidators
): boolean => {
  const outcome = evaluateReadPreconditions(req, validators);
  if (outcome === "precondition_failed") {
    throw new PreconditionFailedError("Precondition failed");
  }
  if (outcome === "not_modified") {
    res.status(304).end();
    return true;
  }
  return false;
};
