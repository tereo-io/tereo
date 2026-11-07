import { DOMParser } from "@xmldom/xmldom";

// The DOM lib is not in this tsconfig; only what the walk reads.
interface XmlNode {
  nodeType: number;
  nodeName?: string;
  nextSibling: XmlNode | null;
}
interface XmlElement extends XmlNode {
  localName: string;
  namespaceURI: string | null;
  firstChild: XmlNode | null;
  attributes: ArrayLike<{
    name: string;
    localName?: string;
    namespaceURI?: string | null;
    value: string;
  }>;
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
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

  const declaration = /^\s*<\?xml\s[^?]*\?>/i.exec(text)?.[0];
  const encoding =
    declaration && /encoding\s*=\s*["']([^"']*)["']/i.exec(declaration);
  if (encoding && encoding[1]!.toLowerCase() !== "utf-8") {
    return "XML encoding must be UTF-8";
  }

  let parseError = false;
  let root: XmlElement | null;
  let docNode: XmlNode | null;
  try {
    const doc = new DOMParser({
      onError: () => {
        parseError = true;
      },
    }).parseFromString(text, "image/svg+xml");
    root = doc.documentElement as XmlElement | null;
    docNode = doc as unknown as XmlNode & { firstChild: XmlNode | null };
  } catch {
    // xmldom throws on fatal errors
    return "not well-formed XML";
  }
  if (parseError) return "not well-formed XML";

  if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS) {
    return "root element must be an svg in the SVG namespace";
  }

  // Processing instructions can pull in stylesheets; only the XML
  // declaration is acceptable, if the parser exposes it as one.
  for (
    let n = (docNode as unknown as XmlElement).firstChild;
    n;
    n = n.nextSibling
  ) {
    if (n.nodeType === 7 && n.nodeName?.toLowerCase() !== "xml") {
      return "processing instructions not allowed";
    }
  }

  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    const name = el.localName;
    if (el.namespaceURI !== SVG_NS)
      return `element <${name}> not in the SVG namespace`;
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
      if (
        attr.namespaceURI === XML_NS &&
        local !== "space" &&
        local !== "lang"
      ) {
        return `attribute ${attrName} not allowed`;
      }
      if (value.includes("\\")) {
        return `attribute ${attrName} has a backslash`;
      }
      if (
        /image-set\(|image\(|cross-fade\(|src\(|@import|expression\(/i.test(
          value
        )
      ) {
        return `attribute ${attrName} has a disallowed function`;
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
      if (c.nodeType === 7) return "processing instructions not allowed";
      if (c.nodeType === 1) stack.push(c as XmlElement);
    }
  }
  return null;
}
