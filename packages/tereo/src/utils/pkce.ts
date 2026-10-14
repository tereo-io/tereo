import { createHash, timingSafeEqual } from "crypto";

export type CodeChallengeMethod = "S256";

export const verifyCodeChallenge = (
  codeVerifier: string,
  codeChallenge: string,
  method: CodeChallengeMethod
): boolean => {
  if (method !== "S256") return false;
  const hash = createHash("sha256").update(codeVerifier).digest("base64url");
  if (hash.length !== codeChallenge.length) return false;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(codeChallenge));
};
