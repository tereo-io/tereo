// @module-tag unit
// @module-tag platform
import { BRANDING_COLOR_TOKENS } from "../../definitions/brandingTokens.js";
import { createRequire } from "module";
import { expect, it } from "vitest";
import { readFileSync } from "fs";

it("lists every colour and shadow variable of the kosmeo stylesheet", () => {
  const css = readFileSync(
    createRequire(import.meta.url).resolve("@kosmeo-ui/react/styles.css"),
    "utf8"
  );
  const fromStylesheet = [
    ...new Set(css.match(/--k-[a-z0-9-]+(?=\s*:)/g) ?? []),
  ]
    .filter((name) => name.includes("color") || name.includes("shadow"))
    .sort();
  expect([...BRANDING_COLOR_TOKENS].sort()).toEqual(fromStylesheet);
});
