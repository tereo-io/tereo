import type { Prisma } from "../../../prisma/generated/client/index.js";
import type { UserRow } from "../userLifecycle.js";
import type { ScimUserLink } from "../db/scim.js";
import type { ScimContext } from "./context.js";
import type { ScimFilter } from "./filter.js";
import db from "../db/index.js";

type Tx = Prisma.TransactionClient;

export type Visible = { user: UserRow; link: ScimUserLink | null };

const toVisible = ({
  scimLink,
  ...user
}: UserRow & { scimLink: ScimUserLink | null }): Visible => ({
  user,
  link: scimLink,
});

const scope = (ctx: ScimContext) => ({
  connectionId: ctx.connection.id,
  providerId: ctx.provider.id,
});

export const providerDomains = async (
  ctx: ScimContext,
  tx?: Tx
): Promise<string[]> => await db.scim.listProviderDomains(ctx.provider.id, tx);

export const findVisible = async (
  ctx: ScimContext,
  userId: string,
  tx?: Tx
): Promise<Visible | null> => {
  const found = await db.scim.findVisibleUser(scope(ctx), userId, tx);
  return found ? toVisible(found) : null;
};

export const listVisible = async (
  ctx: ScimContext,
  filter: ScimFilter,
  page: { startIndex: number; count: number }
): Promise<{ items: Visible[]; total: number }> => {
  const { items, total } = await db.scim.listVisibleUsers(scope(ctx), filter, {
    skip: page.startIndex - 1,
    take: page.count,
  });
  return { items: items.map(toVisible), total };
};
