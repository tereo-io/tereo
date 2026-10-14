import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { type AddressInfo } from "node:net";
import { type Server } from "node:http";
import express from "express";

export interface FakeClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  given_name: string;
  family_name: string;
  hd: string;
}

interface Tamper {
  nonce?: string;
  aud?: string;
  iss?: string;
  error?: string;
  /** Sign the id_token with a key the JWKS doesn't hold, under the same kid. */
  signWithOtherKey?: boolean;
}

export interface FakeOidcProvider {
  issuer: string; // http://localhost:<port>
  clientId: string;
  clientSecret: string;
  nextIdentity(claims: Partial<FakeClaims> & { sub: string }): void; // bound to the next /authorize
  tamper(next: Tamper): void;
  /** How many times `/jwks` has been fetched. */
  jwksRequests(): number;
  close(): Promise<void>;
}

interface IssuedCode {
  claims: Partial<FakeClaims> & { sub: string };
  tamper: Tamper;
  nonce: string | undefined;
  codeChallenge: string;
  redirectUri: string;
}

const KID = "fake-oidc-1";

const base64url = (buf: Buffer): string => buf.toString("base64url");

/**
 * A minimal OIDC provider on localhost: discovery, JWKS, an `/authorize`
 * that redirects straight back with a code for the identity set by
 * `nextIdentity`, and a `/token` that checks client_secret_basic and PKCE.
 */
export const startFakeOidcProvider = async (
  opts: { issuerOverride?: string; noS256?: boolean } = {}
): Promise<FakeOidcProvider> => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const { privateKey: otherPrivateKey } = await generateKeyPair("RS256");
  let jwksRequests = 0;
  const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256" };
  const clientId = `fake-client-${randomBytes(4).toString("hex")}`;
  const clientSecret = randomBytes(24).toString("base64url");
  const codes = new Map<string, IssuedCode>();
  let pendingIdentity: (Partial<FakeClaims> & { sub: string }) | null = null;
  let pendingTamper: Tamper = {};

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let issuer = "";
  const advertisedIssuer = () => opts.issuerOverride ?? issuer;

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.json({
      issuer: advertisedIssuer(),
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: opts.noS256 ? ["plain"] : ["S256"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  app.get("/jwks", (_req, res) => {
    jwksRequests += 1;
    res.json({ keys: [jwk] });
  });

  app.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const tamper = pendingTamper;
    pendingTamper = {};
    if (!q.redirect_uri || q.client_id !== clientId) {
      res.status(400).send("bad client_id or redirect_uri");
      return;
    }
    const back = new URL(q.redirect_uri);
    if (q.state) back.searchParams.set("state", q.state);
    back.searchParams.set("iss", advertisedIssuer());
    if (tamper.error) {
      back.searchParams.set("error", tamper.error);
      res.redirect(302, back.toString());
      return;
    }
    if (!pendingIdentity || q.code_challenge_method !== "S256") {
      res.status(400).send("no identity set, or no S256 challenge");
      return;
    }
    const code = randomBytes(16).toString("base64url");
    codes.set(code, {
      claims: pendingIdentity,
      tamper,
      nonce: q.nonce,
      codeChallenge: q.code_challenge ?? "",
      redirectUri: q.redirect_uri,
    });
    pendingIdentity = null;
    back.searchParams.set("code", code);
    res.redirect(302, back.toString());
  });

  app.post("/token", async (req, res) => {
    const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
    // Compared as sent, without form-decoding, as Google does: a client ID's
    // "-" or "." escaped as %2D or %2E is then an unknown client.
    const [id, secret] = Buffer.from(encoded ?? "", "base64")
      .toString("utf8")
      .split(":");
    if (scheme !== "Basic" || id !== clientId || secret !== clientSecret) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    const body = req.body as Record<string, string | undefined>;
    const issued = body.code ? codes.get(body.code) : undefined;
    if (body.code) codes.delete(body.code);
    const challenge = base64url(
      createHash("sha256")
        .update(body.code_verifier ?? "")
        .digest()
    );
    if (
      body.grant_type !== "authorization_code" ||
      !issued ||
      issued.redirectUri !== body.redirect_uri ||
      issued.codeChallenge !== challenge
    ) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    const { tamper } = issued;
    const nonce = tamper.nonce ?? issued.nonce;
    const idToken = await new SignJWT({
      ...issued.claims,
      ...(nonce ? { nonce } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(tamper.iss ?? advertisedIssuer())
      .setAudience(tamper.aud ?? clientId)
      .setSubject(issued.claims.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(tamper.signWithOtherKey ? otherPrivateKey : privateKey);
    res.json({
      access_token: randomBytes(16).toString("base64url"),
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  });

  // No host: dual-stack, so `localhost` reaches it whether it resolves to
  // 127.0.0.1 or ::1.
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  issuer = `http://localhost:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    nextIdentity(claims) {
      pendingIdentity = claims;
    },
    tamper(next) {
      pendingTamper = next;
    },
    jwksRequests: () => jwksRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
