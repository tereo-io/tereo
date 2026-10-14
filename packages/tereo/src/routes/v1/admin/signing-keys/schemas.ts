import { z } from "zod";

export const RotateSigningKeySchema = z
  .object({
    // Sign with the new key at once, without the activation delay: for a
    // compromised key.
    immediate: z.boolean().optional(),
  })
  .default({});
