import { guardArchivedOrganization, requireOrgMember } from "./middleware.js";
import { requirePermission } from "../../../../../middleware/auth.js";
import membersRouter from "./members/index.js";
import { Router } from "express";
import {
  archiveOrganization,
  getOrganization,
  restoreOrganization,
  updateOrganization,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.use(requireOrgMember);
router.use(guardArchivedOrganization);

router.use("/members", membersRouter);

// Archive / restore are platform-admin operations. There is no delete:
// history (audit entries, buckets, webhooks) references organizations.
router.post(
  "/archive",
  requirePermission("organizations.archive"),
  archiveOrganization
);
router.post(
  "/restore",
  requirePermission("organizations.archive"),
  restoreOrganization
);

// Route-specific tiers checked in controllers via requireOrgRole (the
// router guard above only enforces the member-tier floor)
router.get("/", getOrganization);
router.patch("/", updateOrganization);

export default router;
