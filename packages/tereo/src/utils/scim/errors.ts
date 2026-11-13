import {
  AppError,
  BadRequestError,
  ConflictError,
  ValidationError,
} from "../errors.js";

export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

const BAD_REQUEST_TYPES: readonly string[] = [
  "invalidFilter",
  "invalidSyntax",
  "invalidPath",
  "invalidValue",
  "tooMany",
];

export interface ScimErrorBody {
  schemas: [string];
  status: string;
  scimType?: string;
  detail: string;
}

const body = (
  status: number,
  detail: string,
  scimType?: string
): { status: number; body: ScimErrorBody } => ({
  status,
  body: {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType && { scimType }),
    detail,
  },
});

/** An error from express.json: an http-errors 4xx with a string `type`. */
const bodyParserError = (err: unknown) => {
  const { status, type } = (err ?? {}) as { status?: unknown; type?: unknown };
  if (typeof type !== "string" || typeof status !== "number") return null;
  if (status < 400 || status > 499) return null;
  return { status, type };
};

export const toScimError = (err: unknown) => {
  const parser = bodyParserError(err);
  if (parser) {
    if (parser.type === "entity.parse.failed") {
      return body(400, "Request body is not valid JSON", "invalidSyntax");
    }
    if (parser.type === "entity.too.large") {
      return body(413, "Request body is too large");
    }
    return body(parser.status, "Request body could not be read");
  }
  if (err instanceof ValidationError) {
    return body(400, err.message, "invalidValue");
  }
  if (err instanceof BadRequestError && BAD_REQUEST_TYPES.includes(err.code)) {
    return body(400, err.message, err.code);
  }
  if (err instanceof ConflictError && err.code === "uniqueness") {
    return body(409, err.message, "uniqueness");
  }
  if (err instanceof AppError) return body(err.statusCode, err.message);
  return body(500, "Internal server error");
};
