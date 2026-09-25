import DOMPurify from "dompurify";

/**
 * HTML sanitizer for rich-text content produced by the course editors
 * (TinyMCE, Tiptap/ProseForge, Lexical, Slate).
 *
 * Editors express alignment, colour, sizing and table layout as inline
 * `style` attributes, so `style` is allowed, but each declaration is filtered
 * against a property allowlist and a value denylist (no url(), expression(),
 * javascript:, behaviour, bindings, or fixed/absolute positioning). Scripts,
 * event handlers, and unknown tags/attributes are removed by DOMPurify.
 */

const BASE_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "small",
  "a", "img",
  "blockquote", "pre", "code",
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  "div", "span",
  "figure", "figcaption",
  "video", "audio", "source",
];

const BASE_ATTR = [
  "href", "target", "rel", "src", "alt", "title", "width", "height",
  "class", "style", "colspan", "rowspan", "controls", "type",
  "loading", "referrerpolicy",
  "align", "valign", "border", "cellpadding", "cellspacing", "start", "reversed", "dir", "lang",
];

/** CSS properties an editor may legitimately set inline. */
const ALLOWED_CSS_PROPS = new Set([
  "text-align", "text-indent", "text-decoration", "text-decoration-line", "text-decoration-style",
  "text-decoration-color", "text-transform", "vertical-align", "white-space", "word-break",
  "color", "background-color", "background",
  "font-size", "font-family", "font-weight", "font-style", "font-variant", "line-height",
  "letter-spacing", "word-spacing",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-width", "border-style", "border-color", "border-radius", "border-collapse", "border-spacing",
  "list-style", "list-style-type", "list-style-position",
  "display", "float", "clear", "overflow", "overflow-x", "overflow-y",
  "table-layout", "caption-side", "empty-cells",
  "opacity", "box-sizing", "object-fit",
]);

/** Values that can load resources or escape the content box. */
const FORBIDDEN_CSS_VALUE =
  /(url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|@import|\\|<|>)/i;

/** display values that could overlay or hide page chrome. */
const FORBIDDEN_DISPLAY = /^(?:none|contents)$/i;

function filterStyle(style: string): string {
  const out: string[] = [];
  for (const raw of style.split(";")) {
    const decl = raw.trim();
    if (!decl) continue;
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).trim();
    if (!ALLOWED_CSS_PROPS.has(prop)) continue;
    if (!value || FORBIDDEN_CSS_VALUE.test(value)) continue;
    if (prop === "display" && FORBIDDEN_DISPLAY.test(value)) continue;
    if (prop === "background" && !/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+|transparent|none)$/i.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join("; ");
}

const styleHook = (_node: Element, data: any) => {
  if (data.attrName === "style") {
    const clean = filterStyle(String(data.attrValue || ""));
    if (clean) {
      data.attrValue = clean;
    } else {
      data.keepAttr = false;
    }
  }
};

/** Embed hosts permitted inside <iframe src> by sanitizeHtmlWithEmbeds(). */
const ALLOWED_EMBED_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
  "vimeo.com",
];

function isAllowedEmbedSrc(src: string | null): boolean {
  if (!src) return false;
  try {
    const url = new URL(src, "https://invalid.local");
    if (url.protocol !== "https:") return false;
    return ALLOWED_EMBED_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const iframeHook = (node: Element) => {
  if (node.nodeName && node.nodeName.toLowerCase() === "iframe") {
    const src = node.getAttribute("src");
    if (!isAllowedEmbedSrc(src)) {
      node.parentNode?.removeChild(node);
      return;
    }
    // Lock down the frame regardless of what the author supplied.
    node.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    node.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    node.setAttribute("loading", "lazy");
  }
};

function runWithHooks<T>(withIframes: boolean, fn: () => T): T {
  DOMPurify.addHook("uponSanitizeAttribute", styleHook as any);
  if (withIframes) DOMPurify.addHook("uponSanitizeElement", iframeHook as any);
  try {
    return fn();
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute");
    if (withIframes) DOMPurify.removeHook("uponSanitizeElement");
  }
}

/**
 * Sanitize HTML to prevent XSS attacks.
 * Allows safe formatting, links, images, tables, native media and filtered
 * inline styles; strips scripts, event handlers and iframes.
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return "";
  return runWithHooks(false, () =>
    DOMPurify.sanitize(String(dirty), {
      ALLOWED_TAGS: BASE_TAGS,
      ALLOWED_ATTR: BASE_ATTR,
      ALLOW_DATA_ATTR: false,
    })
  );
}

/**
 * Like sanitizeHtml(), but additionally permits <iframe> embeds whose src is
 * an https YouTube / YouTube-nocookie / Vimeo URL. Use this only where lesson
 * or course content legitimately embeds video (LessonViewer, CoursePreview,
 * lesson page, RichText). Any other iframe is removed.
 */
export function sanitizeHtmlWithEmbeds(dirty: string | null | undefined): string {
  if (!dirty) return "";
  return runWithHooks(true, () =>
    DOMPurify.sanitize(String(dirty), {
      ALLOWED_TAGS: [...BASE_TAGS, "iframe"],
      ALLOWED_ATTR: [...BASE_ATTR, "frameborder", "allowfullscreen", "sandbox"],
      ALLOW_DATA_ATTR: false,
    })
  );
}
