import { DOMParser } from "@xmldom/xmldom";

// The DOM lib is not in this tsconfig; only what the walk reads.
interface XmlNode {
  nodeType: number;
  nextSibling: XmlNode | null;
}
interface XmlElement extends XmlNode {
  localName: string;
  namespaceURI: string | null;
  firstChild: XmlNode | null;
  attributes: ArrayLike<{ name: string; localName?: string; value: string }>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// No style, script, a, image, foreignObject or animation elements: nothing
// that can load a resource or run code.
const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "symbol",
  "use",
  "title",
  "desc",
]);

/** A short reason the SVG is unsafe or malformed, or null when acceptable. */
export function svgProblem(text: string): string | null {
  if (/<!doctype|<!entity/i.test(text)) return "DOCTYPE and ENTITY not allowed";

  let parseError = false;
  let root: XmlElement | null;
  try {
    root = new DOMParser({
      onError: () => {
        parseError = true;
      },
    }).parseFromString(text, "image/svg+xml")
      .documentElement as XmlElement | null;
  } catch {
    // xmldom throws on fatal errors
    return "not well-formed XML";
  }
  if (parseError) return "not well-formed XML";

  if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS) {
    return "root element must be an svg in the SVG namespace";
  }

  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    const name = el.localName;
    if (!ALLOWED_ELEMENTS.has(name)) return `element <${name}> not allowed`;

    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]!;
      const attrName = attr.name;
      const local = attr.localName ?? attrName;
      const value = attr.value;
      if (local.toLowerCase().startsWith("on")) {
        return `attribute ${attrName} not allowed`;
      }
      if (local === "href" && !value.trim().startsWith("#")) {
        return `${attrName} must reference a local #id`;
      }
      if (/javascript:|data:/i.test(value)) {
        return `attribute ${attrName} has a disallowed scheme`;
      }
      if (/url\(/i.test(value)) {
        const stripped = value.replace(/url\(\s*#[^)\s]+\s*\)/gi, "");
        if (/url\(/i.test(stripped)) {
          return `attribute ${attrName} may only use url(#id)`;
        }
      }
    }

    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) stack.push(c as XmlElement);
    }
  }
  return null;
}
