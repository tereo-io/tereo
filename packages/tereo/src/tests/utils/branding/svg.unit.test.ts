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

  it("accepts an XML declaration with UTF-8 and xml:space", () => {
    expect(
      svgProblem(
        `<?xml version="1.0" encoding="utf-8"?><!-- c --><svg ${NS}><text xml:space="preserve">a</text></svg>`
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
    [
      "stylesheet PI before root",
      `<?xml-stylesheet type="text/xsl" href="https://e/x.xsl"?><svg ${NS}/>`,
    ],
    ["PI inside root", wrap(`<?foo bar?>`)],
    [
      "foreign-namespace element",
      wrap(`<h:path xmlns:h="http://www.w3.org/1999/xhtml"/>`),
    ],
    ["css escape", wrap(`<g style="background:u\\72l(https://e/x)"/>`)],
    [
      "image-set",
      wrap(`<g style="background-image:image-set('https://e/x' 1x)"/>`),
    ],
    ["cross-fade", wrap(`<g style="x:CROSS-FADE(a,b)"/>`)],
    ["encoding", `<?xml version="1.0" encoding="UTF-16"?><svg ${NS}/>`],
    ["xml:base", wrap(`<use xml:base="https://e/" href="#a"/>`)],
    ["javascript value", wrap(`<text title="javascript:x">a</text>`)],
    ["unquoted url", wrap(`<rect fill="url('#g')"/>`)],
    ["a url id with a parenthesis", wrap(`<rect fill="url(#a(b)"/>`)],
    ["a non-numeric path", wrap(`<path d="M0 0 url(x)"/>`)],
    ["a non-numeric points list", wrap(`<polygon points="0,0 1:1"/>`)],
  ])("rejects %s", (_name, svg) => {
    expect(typeof svgProblem(svg)).toBe("string");
  });

  it("accepts several url(#id) paints and long path data", () => {
    const d = `M0 0${" l1.5e-1,-2".repeat(20_000)}z`;
    expect(
      svgProblem(
        wrap(
          `<rect fill="url(#a)" stroke="url( #b )"/><path d="${d}"/><polygon points="0,0 1,1 2,0"/>`
        )
      )
    ).toBeNull();
  });

  it("refuses an attribute value over 8 KiB", () => {
    expect(svgProblem(wrap(`<g id="${"a".repeat(8 * 1024 + 1)}"/>`))).toMatch(
      /too long/
    );
  });

  it.each([
    ["fill", (v: string) => wrap(`<rect fill="${v}"/>`)],
    ["d", (v: string) => wrap(`<path d="${v}"/>`)],
  ])("checks a 512 KB %s of unclosed url(#a in linear time", (_name, svg) => {
    const text = svg("url(#a".repeat((512 * 1024) / 6));
    const started = performance.now();
    expect(typeof svgProblem(text)).toBe("string");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("checks the attribute regexes in linear time under the length cap", () => {
    const value = "url(#a".repeat((8 * 1024) / 6);
    const started = performance.now();
    for (let i = 0; i < 64; i++) {
      expect(typeof svgProblem(wrap(`<rect fill="${value}"/>`))).toBe("string");
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
