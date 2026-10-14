import { requirePermission } from "../../../../../middleware/auth.js";
import { guardArchivedRole } from "./middleware.js";
import usersRouter from "./users/index.js";
import { Router } from "express";
import {
  archiveRole,
  deleteRole,
  duplicateRole,
  getRole,
  restoreRole,
  setRolePermissions,
  updateRole,
} from "./controllers.js";

const router = Router({ mergeParams: true });

router.use("/users", usersRouter);

router.put(
  "/permissions",
  requirePermission("roles.write"),
  guardArchivedRole,
  setRolePermissions
);
router.post(
  "/duplicate",
  requirePermission("roles.write"),
  guardArchivedRole,
  duplicateRole
);
router.post(
  "/archive",
  requirePermission("roles.archive"),
  guardArchivedRole,
  archiveRole
);
router.post(
  "/restore",
  requirePermission("roles.archive"),
  guardArchivedRole,
  restoreRole
);

router.get("/", requirePermission("roles.read"), getRole);
router.patch(
  "/",
  requirePermission("roles.write"),
  guardArchivedRole,
  updateRole
);
router.delete(
  "/",
  requirePermission("roles.delete"),
  guardArchivedRole,
  deleteRole
);

export default router;
