import express, { RequestHandler } from "express";

// A multipart part PUT streams its raw body; a parser that matched its
// Content-Type would consume it and leave an empty part.
const PART_UPLOAD = /^\/buckets\/[^/]+\/multipart\/[^/]+\/parts\/[^/]+$/;

const jsonParser = express.json({ limit: "10mb" });
const formParser = express.urlencoded({ extended: true, limit: "10mb" });

/** Body limits are large for metadata-bearing requests. */
export const parseBody: RequestHandler = (req, res, next) => {
  if (req.method === "PUT" && PART_UPLOAD.test(req.path)) return next();
  jsonParser(req, res, (err?: unknown) =>
    err ? next(err) : formParser(req, res, next)
  );
};
