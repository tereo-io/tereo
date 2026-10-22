import cookieParser from "cookie-parser";
import express from "express";

/**
 * Body parsing for the auth routes (/oauth, /.well-known, /v1/account,
 * /v1/admin, /v1/setup): small limits, since nothing there accepts more than
 * a form, plus cookies.
 */
export const smallBodyParsers = [
  express.json({ limit: "10kb" }),
  express.urlencoded({ extended: true, limit: "10kb" }),
  cookieParser(),
];

/**
 * JSON and form parsing for the webhooks, audit and notifications areas,
 * mounted after their rate limit and `requireAuth` so an anonymous caller
 * can't make core read a body. 1mb, unless a route needs more.
 */
export const apiBodyParsers = (limit: "1mb" | "10mb" = "1mb") => [
  express.json({ limit }),
  express.urlencoded({ extended: true, limit }),
];
