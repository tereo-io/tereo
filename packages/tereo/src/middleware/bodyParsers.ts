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
