/** Shared between the server, the store, the overlay and the MCP server. */

export type AnnotationStatus = "pending" | "in_progress" | "done" | "rejected";

export interface Region {
  /** Page coordinates (document, not viewport). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Freehand path in page coordinates, if drawn. */
  path?: { x: number; y: number }[];
}

export interface Annotation {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Path of the page the annotation was made on, e.g. `/todos/abc`. */
  url: string;
  /** Addresses of the nodes covered. */
  targets: string[];
  commonAncestor?: string;
  region?: Region;
  note: string;
  status: AnnotationStatus;
  /** Set by the agent when it finishes. */
  summary?: string;
  /** Relative path of the screenshot PNG, if captured. */
  screenshot?: string;
  /** Viewport size when captured, for interpreting the screenshot. */
  viewport?: { width: number; height: number };
}

export interface NewAnnotation {
  url: string;
  targets: string[];
  commonAncestor?: string;
  region?: Region;
  note: string;
  /** PNG data URL. */
  screenshot?: string;
  viewport?: { width: number; height: number };
}

export interface MapEntry {
  address: string;
  file?: string;
  range?: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
  name: string;
}
export type AddressMap = Record<string, MapEntry>;
