/**
 * The built-in primitives and the props each accepts. This is the single
 * source of truth for the validator (unknown prop / missing prop), the
 * emitter, and the docs. The runtime package implements them.
 */

export interface PrimitiveSpec {
  /** Props accepted in addition to the common ones. */
  props: string[];
  /** Props that must be present. */
  required?: string[];
  /** Element renders an HTML tag and can carry a data-orchid stamp directly. */
  stampable: boolean;
  /** Short description for docs. */
  doc: string;
}

const LAYOUT_PROPS = [
  "as", "padding", "paddingX", "paddingY", "margin", "gap", "radius", "bg", "color",
  "border", "width", "height", "maxWidth", "minHeight", "align", "justify", "direction",
  "wrap", "shadow", "grow",
];
const COMMON = ["className", "style", "id", "role", "ariaLabel", "hidden", "testId"];

export const PRIMITIVES: Record<string, PrimitiveSpec> = {
  Box: { props: LAYOUT_PROPS, stampable: true, doc: "A generic container. Renders a <div> by default; `as` changes the tag." },
  Stack: { props: LAYOUT_PROPS, stampable: true, doc: "A flex container. Column by default; `direction: \"row\"` for a row." },
  Text: { props: ["as", "size", "weight", "color", "align", "muted", "truncate"], stampable: true, doc: "Body text. Renders a <p> by default." },
  Heading: { props: ["level", "size", "weight", "color", "align"], stampable: true, doc: "A heading. `level` picks h1..h6 (default 2)." },
  Button: {
    props: ["variant", "size", "onClick", "type", "disabled", "href", "name", "value", "formAction", "fullWidth"],
    stampable: true,
    doc: "A button. `variant` is primary, secondary, ghost or danger. With `href` it renders a link styled as a button.",
  },
  Input: {
    props: ["name", "type", "value", "defaultValue", "defaultChecked", "label", "placeholder", "onChange", "onInput", "disabled", "required", "autoFocus", "size"],
    required: ["name"],
    stampable: true,
    doc: "A form input. `name` is required so forms and actions can read it. `type: \"checkbox\"` with `label` renders a labelled checkbox.",
  },
  Textarea: {
    props: ["name", "value", "defaultValue", "placeholder", "onChange", "rows", "disabled", "required"],
    required: ["name"],
    stampable: true,
    doc: "A multi-line input.",
  },
  Form: { props: ["action", "onSubmit", "method"], stampable: true, doc: "A form. `action` takes a page action and submits without client JavaScript." },
  Link: { props: ["href", "color", "weight", "underline", "external"], required: ["href"], stampable: true, doc: "A navigation link (next/link)." },
  Image: { props: ["src", "alt", "width", "height", "radius", "fit"], required: ["src", "alt"], stampable: true, doc: "An image (next/image)." },
  Divider: { props: ["color", "margin"], stampable: true, doc: "A horizontal rule." },
  Spacer: { props: ["size"], stampable: true, doc: "Empty space of a token size." },
};

export function isPrimitive(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRIMITIVES, name);
}

export function allowedProps(name: string): string[] | undefined {
  const spec = PRIMITIVES[name];
  return spec ? [...spec.props, ...COMMON] : undefined;
}

/** Props whose value is a token-sized measure and get `px` when numeric. */
export const MEASURE_PROPS = new Set([
  "padding", "paddingX", "paddingY", "margin", "gap", "radius", "width", "height", "maxWidth", "minHeight", "size",
]);
