import express, { RequestHandler } from "express";

// A multipart part PUT streams its raw body; a parser that matched its
// Content-Type would consume it and leave an empty part.
const PART_UPLOAD = /^\/buckets\/[^/]+\/multipart\/[^/]+\/parts\/[^/]+$/i;
// The route parses its own part list, up to 5mb.
const MULTIPART_COMPLETE = /^\/buckets\/[^/]+\/multipart\/[^/]+\/complete$/i;
// Up to 1000 keys of up to 1024 characters each.
const ARCHIVE_CREATE = /^\/buckets\/[^/]+\/archives\/?$/i;

const jsonParser = express.json({ limit: "1mb" });
const formParser = express.urlencoded({ extended: true, limit: "1mb" });
const largeJsonParser = express.json({ limit: "5mb" });

/** JSON and form bodies: metadata, settings, id lists. */
export const parseBody: RequestHandler = (req, res, next) => {
  if (req.method === "PUT" && PART_UPLOAD.test(req.path)) return next();
  if (req.method === "POST" && MULTIPART_COMPLETE.test(req.path)) {
    return next();
  }
  const json =
    req.method === "POST" && ARCHIVE_CREATE.test(req.path)
      ? largeJsonParser
      : jsonParser;
  json(req, res, (err?: unknown) =>
    err ? next(err) : formParser(req, res, next)
  );
};
