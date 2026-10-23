import { hashPassword, generateClientSecret } from "../../../utils/crypto.js";
import { prisma } from "../../../utils/db/prisma.js";
import { ALL_CORE_SCOPES } from "./constants.js";
import { generateUniqueId } from "./crypto.js";

// Create test client
export async function createTestClient(
  options: {
    clientType?: "public" | "confidential";
    scopes?: string[];
    grantTypes?: string[];
    redirectUris?: string[];
    postLogoutRedirectUris?: string[];
    audience?: string[];
    ownerId?: string;
  } = {}
) {
  const uniqueId = generateUniqueId();
  const clientId = `test-client-${uniqueId}`;

  // Get or create default owner if not provided
  let ownerId = options.ownerId;
  if (!ownerId) {
    // Use upsert to avoid race conditions when running tests in parallel
    const passwordHash = await hashPassword("TestPassword123!");
    const owner = await prisma.user.upsert({
      where: { email: "test-client-owner@test.local" },
      update: {}, // Don't update if exists
      create: {
        email: "test-client-owner@test.local",
        passwordHash,
        name: "Test Client Owner",
        isActive: true,
      },
    });
    ownerId = owner.id;
  }

  // Generate hashed secret for confidential clients
  let clientSecret: string | null = null;
  let plainSecret: string | null = null;
  if (options.clientType === "confidential") {
    const secretData = generateClientSecret();
    clientSecret = secretData.hashedSecret;
    plainSecret = secretData.plainSecret;
  }

  const grantTypes = options.grantTypes || [
    "authorization_code",
    "refresh_token",
  ];

  // Create service account user if client_credentials grant is requested
  let serviceAccountUserData: { connect: { id: string } } | undefined;
  if (grantTypes.includes("client_credentials")) {
    const serviceAccountPasswordHash = await hashPassword(
      "ServiceAccount123!@#"
    );
    const serviceAccountUser = await prisma.user.create({
      data: {
        email: `service-account-${uniqueId}@test.local`,
        passwordHash: serviceAccountPasswordHash,
        name: `Service Account ${uniqueId}`,
        isActive: true,
        userType: "service_account",
      },
    });
    serviceAccountUserData = { connect: { id: serviceAccountUser.id } };
  }

  const client = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecret,
      clientType: options.clientType || "public",
      name: `Test Client ${uniqueId}`,
      redirectUris: options.redirectUris || ["http://localhost:3000/callback"],
      postLogoutRedirectUris: options.postLogoutRedirectUris || [
        "http://localhost:3000/logout",
      ],
      scopes: options.scopes || [
        "openid",
        "profile",
        "email",
        "offline_access",
        ...ALL_CORE_SCOPES,
      ],
      grantTypes,
      audience: options.audience || [],
      ownerId,
      serviceAccountUser: serviceAccountUserData,
    },
  });

  return {
    ...client,
    plainSecret,
  };
}
