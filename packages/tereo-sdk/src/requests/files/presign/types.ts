export type PresignOperation = "read" | "write";

export interface PresignObjectInput {
  operation?: PresignOperation;
  expiresInSeconds?: number;
}

export interface PresignObjectResponse {
  url: string;
  expiresAt: string;
  operation: PresignOperation;
}
