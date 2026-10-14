import { getNotification } from "./controllers.js";
import { Router } from "express";

const router = Router({ mergeParams: true });

// `.send` sees its own notifications, `.read` any: checked in the controller.
router.get("/", getNotification);

export default router;
