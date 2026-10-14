export type UpstreamAuthErrorCode = "upstream_cancelled" | "upstream_failed";

export class UpstreamAuthError extends Error {
  constructor(
    public code: UpstreamAuthErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "UpstreamAuthError";
  }
}
