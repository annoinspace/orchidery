import type { CSSProperties, ElementType, ReactNode } from "react";
import NextLink from "next/link";
import NextImage from "next/image";

export { OrchideryDevTools } from "./devtools.js";

type Measure = string | number;
type Rest = Record<string, unknown>;

const px = (v: Measure | undefined): string | undefined => (typeof v === "number" ? `${v}px` : v);

interface CommonProps {
  className?: string;
  style?: CSSProperties;
  id?: string;
  role?: string;
  ariaLabel?: string;
  hidden?: boolean;
  testId?: string;
  children?: ReactNode;
}

/** Pass through data-* attributes (the dev stamp) and map the common props. */
function common(p: CommonProps & Rest, extraClass?: string) {
  const out: Rest = {};
  for (const [k, v] of Object.entries(p)) if (k.startsWith("data-")) out[k] = v;
  if (p.id) out.id = p.id;
  if (p.role) out.role = p.role;
  if (p.ariaLabel) out["aria-label"] = p.ariaLabel;
  if (p.hidden) out.hidden = true;
  if (p.testId) out["data-testid"] = p.testId;
  const cls = [extraClass, p.className].filter(Boolean).join(" ");
  if (cls) out.className = cls;
  return out;
}

export interface LayoutProps extends CommonProps {
  as?: ElementType;
  padding?: Measure;
  paddingX?: Measure;
  paddingY?: Measure;
  margin?: Measure;
  gap?: Measure;
  radius?: Measure;
  bg?: string;
  color?: string;
  border?: string;
  width?: Measure;
  height?: Measure;
  maxWidth?: Measure;
  minHeight?: Measure;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  direction?: "row" | "column";
  wrap?: boolean;
  shadow?: "sm" | "md" | "lg";
  grow?: boolean;
}

function layoutStyle(p: LayoutProps, base: CSSProperties = {}): CSSProperties {
  const s: CSSProperties = { ...base };
  if (p.padding !== undefined) s.padding = px(p.padding);
  if (p.paddingX !== undefined) { s.paddingLeft = px(p.paddingX); s.paddingRight = px(p.paddingX); }
  if (p.paddingY !== undefined) { s.paddingTop = px(p.paddingY); s.paddingBottom = px(p.paddingY); }
  if (p.margin !== undefined) s.margin = px(p.margin);
  if (p.gap !== undefined) s.gap = px(p.gap);
  if (p.radius !== undefined) s.borderRadius = px(p.radius);
  if (p.bg !== undefined) s.background = p.bg;
  if (p.color !== undefined) s.color = p.color;
  if (p.border !== undefined) s.border = p.border === "true" || (p.border as unknown) === true ? "1px solid var(--color-border, #e5e7eb)" : p.border;
  if (p.width !== undefined) s.width = px(p.width);
  if (p.height !== undefined) s.height = px(p.height);
  if (p.maxWidth !== undefined) s.maxWidth = px(p.maxWidth);
  if (p.minHeight !== undefined) s.minHeight = px(p.minHeight);
  if (p.align !== undefined) s.alignItems = p.align;
  if (p.justify !== undefined) s.justifyContent = p.justify;
  if (p.direction !== undefined) s.flexDirection = p.direction;
  if (p.wrap) s.flexWrap = "wrap";
  if (p.shadow) s.boxShadow = `var(--shadow-${p.shadow})`;
  if (p.grow) s.flexGrow = 1;
  return { ...s, ...p.style };
}

export function Box(p: LayoutProps & Rest) {
  const Tag = (p.as ?? "div") as ElementType;
  return <Tag {...common(p, "o-box")} style={layoutStyle(p)}>{p.children}</Tag>;
}

export function Stack(p: LayoutProps & Rest) {
  const Tag = (p.as ?? "div") as ElementType;
  return (
    <Tag {...common(p, "o-stack")} style={layoutStyle(p, { display: "flex", flexDirection: p.direction ?? "column" })}>
      {p.children}
    </Tag>
  );
}

export interface TextProps extends CommonProps {
  as?: ElementType;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  weight?: "normal" | "medium" | "semibold" | "bold" | number;
  color?: string;
  align?: CSSProperties["textAlign"];
  muted?: boolean;
  truncate?: boolean;
}

function textStyle(p: TextProps): CSSProperties {
  const s: CSSProperties = {};
  if (p.color) s.color = p.color;
  if (p.align) s.textAlign = p.align;
  if (typeof p.weight === "number") s.fontWeight = p.weight;
  return { ...s, ...p.style };
}

export function Text(p: TextProps & Rest) {
  const Tag = (p.as ?? "p") as ElementType;
  const cls = ["o-text", p.size && `o-size-${p.size}`, typeof p.weight === "string" && `o-weight-${p.weight}`, p.muted && "o-muted", p.truncate && "o-truncate"]
    .filter(Boolean)
    .join(" ");
  return <Tag {...common(p, cls)} style={textStyle(p)}>{p.children}</Tag>;
}

export interface HeadingProps extends TextProps {
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

export function Heading(p: HeadingProps & Rest) {
  const level = p.level ?? 2;
  const Tag = `h${level}` as ElementType;
  const cls = ["o-heading", `o-heading-${level}`, p.size && `o-size-${p.size}`, typeof p.weight === "string" && `o-weight-${p.weight}`]
    .filter(Boolean)
    .join(" ");
  return <Tag {...common(p, cls)} style={textStyle(p)}>{p.children}</Tag>;
}

export interface ButtonProps extends CommonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  onClick?: (e: React.MouseEvent<HTMLElement>) => unknown;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  href?: string;
  name?: string;
  value?: string;
  formAction?: unknown;
  fullWidth?: boolean;
}

export function Button(p: ButtonProps & Rest) {
  const cls = ["o-btn", `o-btn-${p.variant ?? "secondary"}`, `o-btn-${p.size ?? "md"}`, p.fullWidth && "o-full"].filter(Boolean).join(" ");
  if (p.href) {
    return (
      <NextLink href={p.href} {...common(p, cls)} style={p.style} onClick={p.onClick as never} aria-disabled={p.disabled}>
        {p.children}
      </NextLink>
    );
  }
  return (
    <button
      {...common(p, cls)}
      style={p.style}
      type={p.type ?? "button"}
      onClick={p.onClick as never}
      disabled={p.disabled}
      name={p.name}
      value={p.value}
      formAction={p.formAction as never}
    >
      {p.children}
    </button>
  );
}

export interface InputProps extends CommonProps {
  name: string;
  type?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => unknown;
  onInput?: (e: React.FormEvent<HTMLInputElement>) => unknown;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  size?: "sm" | "md" | "lg";
  defaultChecked?: boolean;
  /** For checkboxes: text rendered beside the box. */
  label?: string;
}

export function Input(p: InputProps & Rest) {
  const isCheck = p.type === "checkbox" || p.type === "radio";
  const input = (
    <input
      {...common(p, isCheck ? "o-check" : `o-input o-input-${p.size ?? "md"}`)}
      style={p.style}
      name={p.name}
      type={p.type ?? "text"}
      value={p.value}
      defaultValue={p.defaultValue}
      defaultChecked={p.defaultChecked}
      placeholder={p.placeholder}
      onChange={p.onChange}
      onInput={p.onInput}
      disabled={p.disabled}
      required={p.required}
      autoFocus={p.autoFocus}
    />
  );
  if (!isCheck || !p.label) return input;
  return (
    <label className="o-check-label">
      {input}
      <span>{p.label}</span>
    </label>
  );
}

export interface TextareaProps extends CommonProps {
  name: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => unknown;
  rows?: number;
  disabled?: boolean;
  required?: boolean;
}

export function Textarea(p: TextareaProps & Rest) {
  return (
    <textarea
      {...common(p, "o-input o-textarea")}
      style={p.style}
      name={p.name}
      value={p.value}
      defaultValue={p.defaultValue}
      placeholder={p.placeholder}
      onChange={p.onChange}
      rows={p.rows}
      disabled={p.disabled}
      required={p.required}
    />
  );
}

export interface FormProps extends CommonProps {
  action?: unknown;
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => unknown;
  method?: "get" | "post";
}

export function Form(p: FormProps & Rest) {
  return (
    <form {...common(p, "o-form")} style={p.style} action={p.action as never} onSubmit={p.onSubmit} method={p.method}>
      {p.children}
    </form>
  );
}

export interface LinkProps extends CommonProps {
  href: string;
  color?: string;
  weight?: "normal" | "medium" | "semibold" | "bold";
  underline?: boolean;
  external?: boolean;
}

export function Link(p: LinkProps & Rest) {
  const cls = ["o-link", p.weight && `o-weight-${p.weight}`, p.underline === false && "o-no-underline"].filter(Boolean).join(" ");
  const style = { ...(p.color ? { color: p.color } : {}), ...p.style };
  if (p.external) {
    return (
      <a href={p.href} {...common(p, cls)} style={style} target="_blank" rel="noreferrer">
        {p.children}
      </a>
    );
  }
  return (
    <NextLink href={p.href} {...common(p, cls)} style={style}>
      {p.children}
    </NextLink>
  );
}

export interface ImageProps extends CommonProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  radius?: Measure;
  fit?: "cover" | "contain";
}

export function Image(p: ImageProps & Rest) {
  const style: CSSProperties = { ...(p.radius !== undefined ? { borderRadius: px(p.radius) } : {}), ...(p.fit ? { objectFit: p.fit } : {}), ...p.style };
  return <NextImage src={p.src} alt={p.alt} width={p.width ?? 400} height={p.height ?? 300} {...common(p, "o-image")} style={style} />;
}

export function Divider(p: CommonProps & { color?: string; margin?: Measure } & Rest) {
  const style: CSSProperties = { ...(p.color ? { borderColor: p.color } : {}), ...(p.margin !== undefined ? { margin: `${px(p.margin)} 0` } : {}), ...p.style };
  return <hr {...common(p, "o-divider")} style={style} />;
}

export function Spacer(p: CommonProps & { size?: Measure } & Rest) {
  return <div {...common(p, "o-spacer")} style={{ height: px(p.size ?? 16), flexShrink: 0, ...p.style }} />;
}
