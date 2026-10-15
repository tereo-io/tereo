import { UpdateClientInput } from "../../routes/v1/admin/clients/client/schemas.js";
import { CreateClientInput } from "../../routes/v1/admin/clients/schemas.js";
import { NotFoundError } from "../errors.js";
import { orgRefSelect } from "../refs.js";
import { prisma } from "./prisma.js";
import {
  ClientType,
  Prisma,
  UserType,
} from "../../../prisma/generated/client/index.js";

interface CreateClientData extends CreateClientInput {
  clientId: string;
  clientSecret: string | null;
  ownerId: string;
}

interface UpdateClientData extends UpdateClientInput {
  id: string;
  clientSecret?: string;
  ownerId?: string;
}

export interface ClientRecord {
  name: string;
  id: string;
  createdAt: Date;
  updatedAt: Date;
  clientId: string;
  clientType: ClientType;
  scopes: string[];
  clientSecret: string | null;
  previousSecretHash: string | null;
  previousSecretExpiresAt: Date | null;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  audience: string[];
  consentRequired: boolean;
  ownerId: string;
  organizationId: string | null;
  serviceAccountUser: {
    id: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
    email: string;
    passwordHash: string | null;
    firstName: string | null;
    lastName: string | null;
    userType: UserType;
    oauthClientId: string | null;
    isActive: boolean;
    totpSecret: string | null;
    totpEnabled: boolean;
    totpEnabledAt: Date | null;
    photoObjectId: string | null;
  } | null;
}

export const get = async (
  id: string,
  tx?: Prisma.TransactionClient
): Promise<ClientRecord> => {
  const db = tx ?? prisma;
  const existing = await db.oAuthClient.findUnique({
    where: { id },
    include: { serviceAccountUser: true },
  });
  if (!existing) throw new NotFoundError("Client not found");
  return existing;
};

export const getWithRelations = async (id: string) => {
  const existing = await prisma.oAuthClient.findUnique({
    where: { id },
    include: {
      owner: {
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
        },
      },
      serviceAccountUser: {
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
        },
      },
      service: { select: { id: true, slug: true, name: true } },
      organization: orgRefSelect,
    },
  });
  if (!existing) throw new NotFoundError("Client not found");
  return existing;
};

export const getByClientId = async (
  clientId: string
): Promise<ClientRecord> => {
  const existing = await prisma.oAuthClient.findUnique({
    where: { clientId },
    include: { serviceAccountUser: true },
  });
  if (!existing) throw new NotFoundError("Client not found");
  return existing;
};

export const getAll = async (): Promise<ClientRecord[]> => {
  return await prisma.oAuthClient.findMany({
    orderBy: { createdAt: "desc" },
    include: { serviceAccountUser: true },
  });
};

interface GetPaginatedOptions {
  /** Over-fetch happens inside the helper — pass the user's requested page size. */
  take: number;
  orderBy?: Record<string, "asc" | "desc">[];
  where?: Record<string, unknown>;
}

export const getPaginated = async (options: GetPaginatedOptions) => {
  const { take, orderBy, where } = options;

  const rows = await prisma.oAuthClient.findMany({
    take: take + 1,
    orderBy: orderBy,
    where,
    include: {
      owner: {
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
        },
      },
      serviceAccountUser: {
        select: {
          id: true,
          email: true,
          name: true,
          userType: true,
        },
      },
      service: { select: { id: true, slug: true, name: true } },
      organization: orgRefSelect,
    },
  });

  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;

  return { data, hasMore };
};

export const create = async (
  data: CreateClientData,
  tx?: Prisma.TransactionClient
): Promise<ClientRecord> => {
  const db = tx ?? prisma;
  return await db.oAuthClient.create({
    data: {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      clientType: data.clientType,
      name: data.name,
      redirectUris: data.redirectUris,
      postLogoutRedirectUris: data.postLogoutRedirectUris,
      scopes: data.scopes,
      grantTypes: data.grantTypes,
      consentRequired: data.consentRequired,
      audience: data.audience,
      ownerId: data.ownerId,
    },
    include: { serviceAccountUser: true },
  });
};

export const update = async (
  data: UpdateClientData,
  tx?: Prisma.TransactionClient
): Promise<ClientRecord> => {
  const db = tx ?? prisma;
  return await db.oAuthClient.update({
    where: { id: data.id },
    data: {
      name: data.name,
      clientType: data.clientType,
      clientSecret: data.clientSecret,
      redirectUris: data.redirectUris,
      postLogoutRedirectUris: data.postLogoutRedirectUris,
      scopes: data.scopes,
      grantTypes: data.grantTypes,
      consentRequired: data.consentRequired,
      audience: data.audience,
      ...(data.ownerId && { ownerId: data.ownerId }),
    },
    include: { serviceAccountUser: true },
  });
};

export const deleteClient = async (
  id: string,
  tx?: Prisma.TransactionClient
) => {
  const db = tx ?? prisma;
  await db.oAuthClient.delete({ where: { id } });
};
