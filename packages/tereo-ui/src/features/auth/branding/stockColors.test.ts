/// <reference types="node" />
import { BRANDING_COLOR_TOKENS } from "./colorTokens";
import { STOCK_COLORS } from "./stockColors";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(
  createRequire(import.meta.url).resolve("@kosmeo-ui/react/styles.css"),
  "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

const declarations = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--k-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim().replace(/\s+/g, " "),
    ])
  );
};

it("matches the stock light and dark values of the kosmeo stylesheet", () => {
  const light = declarations(":root");
  const dark = { ...light, ...declarations('[data-theme="dark"]') };
  const only = (all: Record<string, string>) =>
    Object.fromEntries(BRANDING_COLOR_TOKENS.map((t) => [t, all[t]]));
  expect(STOCK_COLORS.light).toEqual(only(light));
  expect(STOCK_COLORS.dark).toEqual(only(dark));
});
