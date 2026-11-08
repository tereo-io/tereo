/// <reference types="node" />
import { BRANDING_COLOR_TOKENS } from "./colorTokens";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

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
