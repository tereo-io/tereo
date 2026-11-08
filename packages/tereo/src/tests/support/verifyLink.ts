import { SYSTEM_USER_ID } from "../../definitions/index.js";
import { issueVerifyLink } from "../../utils/userLinks.js";
import { prisma } from "../../utils/db/prisma.js";

export const issueVerifyLinkFor = (userId: string) =>
  prisma.$transaction((tx) =>
    issueVerifyLink(tx, { userId, createdBy: SYSTEM_USER_ID })
  );
