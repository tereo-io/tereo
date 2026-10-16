import { provisioningJsonSchema } from "../src/cli/provision/index.js";
import { writeFileSync } from "fs";

writeFileSync(
  new URL("../provisioning.schema.json", import.meta.url),
  `${JSON.stringify(provisioningJsonSchema(), null, 2)}\n`
);
