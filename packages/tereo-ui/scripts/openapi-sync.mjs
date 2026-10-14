// Copies core's bundled OpenAPI spec into public/ for the API docs page. A
// missing source only warns, so the UI still builds without it.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(
  uiRoot,
  "../tereo/openapi/bundled-openapi.yaml"
);
const target = path.join(uiRoot, "public/openapi/tereo.yaml");

if (existsSync(source)) {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(
    `openapi:sync: copied ${path.relative(uiRoot, source)} to ${path.relative(uiRoot, target)}`
  );
} else {
  console.warn(
    `openapi:sync: warning: ${path.relative(uiRoot, source)} not found; the API docs page will have no spec`
  );
}
