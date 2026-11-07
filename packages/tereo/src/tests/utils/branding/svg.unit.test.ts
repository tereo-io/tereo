// @module-tag unit
// @module-tag auth
// @module-tag security
import { svgProblem } from "../../../utils/branding/svg.js";
import { describe, expect, it } from "vitest";

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const wrap = (inner: string) => `<svg ${NS} viewBox="0 0 10 10">${inner}</svg>`;

describe("svgProblem", () => {
  it("accepts a plain path", () => {
    expect(
      svgProblem(
        `<svg ${NS} viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#0b5"/></svg>`
      )
    ).toBeNull();
  });

  it("accepts a gradient referenced by fill", () => {
    expect(
      svgProblem(
        wrap(
          `<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)"/>`
        )
      )
    ).toBeNull();
  });

  it.each([
    ["script", wrap(`<script>alert(1)</script>`)],
    ["onload", `<svg ${NS} onload="x()"></svg>`],
    ["onclick on a child", wrap(`<g onclick="x()"/>`)],
    ["foreignObject", wrap(`<foreignObject><div/></foreignObject>`)],
    ["a element", wrap(`<a href="javascript:alert(1)"><path d="M0 0"/></a>`)],
    ["external use", wrap(`<use href="https://x/y.svg#a"/>`)],
    [
      "data href",
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">` +
        `<use xlink:href="data:image/svg+xml,x"/></svg>`,
    ],
    ["style import", wrap(`<style>@import url(x)</style>`)],
    ["style any", wrap(`<style>path{fill:red}</style>`)],
    ["doctype entity", `<!DOCTYPE svg [<!ENTITY a "b">]><svg ${NS}>&a;</svg>`],
    ["root not svg", `<html xmlns="http://www.w3.org/1999/xhtml"></html>`],
    ["malformed", `<svg ${NS}><path></svg>`],
    ["external url paint", wrap(`<rect fill="url(https://x)"/>`)],
    ["javascript value", wrap(`<text title="javascript:x">a</text>`)],
  ])("rejects %s", (_name, svg) => {
    expect(typeof svgProblem(svg)).toBe("string");
  });
});
