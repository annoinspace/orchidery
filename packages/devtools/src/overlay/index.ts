/**
 * Orchidery edit-mode overlay. Injected by <OrchideryDevTools /> in dev.
 * Lives in a Shadow DOM so it never fights the app's styles or React tree.
 */
import { toCanvas } from "html-to-image";
import type { AddressMap, Annotation, NewAnnotation, Region } from "../types.js";

type Tool = "select" | "box" | "pen";
interface Pt { x: number; y: number }

const script = document.currentScript as HTMLScriptElement | null;
const BASE = script?.dataset.orchideryDevtools ?? "http://localhost:4747";
const HOST_TAG = "orchidery-devtools";

if (!document.querySelector(HOST_TAG)) boot();

function boot(): void {
  const host = document.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .toolbar {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    display: flex; gap: 4px; padding: 4px; border-radius: 999px;
    background: #111; color: #fff; font: 12px/1 ui-sans-serif, system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0,0,0,.25);
  }
  .toolbar button {
    all: unset; cursor: pointer; padding: 8px 12px; border-radius: 999px; color: #ddd;
  }
  .toolbar button:hover { background: #333; color: #fff; }
  .toolbar button.on { background: #7b3fa0; color: #fff; }
  .toolbar .count { padding: 8px 10px; color: #aaa; }
  .layer { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; }
  .hover, .sel {
    position: absolute; border: 2px solid #7b3fa0; border-radius: 3px; pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(123,63,160,0); transition: none;
  }
  .hover { border-style: dashed; opacity: .8; }
  .sel { background: rgba(123,63,160,.08); }
  .tag {
    position: absolute; transform: translateY(-100%); padding: 2px 6px; border-radius: 4px 4px 0 0;
    background: #7b3fa0; color: #fff; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
  canvas.draw { position: fixed; inset: 0; z-index: 2147482500; cursor: crosshair; pointer-events: none; }
  canvas.draw.active { pointer-events: auto; }
  .panel {
    position: fixed; z-index: 2147483100; width: 340px; max-width: calc(100vw - 32px);
    background: #fff; color: #111; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25);
    font: 13px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .panel .targets { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #555; max-height: 80px; overflow: auto; }
  .panel textarea { all: unset; display: block; width: 100%; min-height: 64px; padding: 8px; border: 1px solid #ddd; border-radius: 8px; font: inherit; white-space: pre-wrap; }
  .panel .row { display: flex; gap: 8px; justify-content: flex-end; }
  .panel button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; background: #eee; }
  .panel button.primary { background: #7b3fa0; color: #fff; }
  .pin {
    position: absolute; z-index: 2147482800; pointer-events: auto; cursor: pointer;
    width: 22px; height: 22px; border-radius: 999px; transform: translate(-50%, -50%);
    display: flex; align-items: center; justify-content: center; color: #fff;
    font: 700 11px/1 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.3);
  }
  .pin.pending { background: #f59e0b; } .pin.in_progress { background: #3b82f6; } .pin.done { background: #10b981; } .pin.rejected { background: #6b7280; }
  .pin:hover::after {
    content: attr(data-note); position: absolute; left: 14px; top: 14px; white-space: pre-wrap; width: 240px;
    background: #111; color: #fff; font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; padding: 8px; border-radius: 8px;
  }
  .toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 2147483200; background: #111; color: #fff; padding: 8px 14px; border-radius: 999px; font: 12px ui-sans-serif, system-ui, sans-serif; }
</style>
<div class="layer" id="layer"></div>
<canvas class="draw" id="draw"></canvas>
<div class="toolbar">
  <button id="toggle" title="Toggle edit mode (Alt+Shift+E)">Edit</button>
  <button id="t-select" class="tool" data-tool="select" title="Click to select" hidden>Select</button>
  <button id="t-box" class="tool" data-tool="box" title="Drag a box" hidden>Box</button>
  <button id="t-pen" class="tool" data-tool="pen" title="Draw freehand" hidden>Pen</button>
  <span class="count" id="count" title="Pending annotations on this page"></span>
</div>`;

  const $ = <T extends HTMLElement>(id: string) => shadow.getElementById(id) as T;
  const layer = $("#layer".slice(1)) as HTMLDivElement;
  const canvas = $("draw") as HTMLCanvasElement;
  const ctx2d = canvas.getContext("2d")!;
  const toggleBtn = $("toggle");
  const toolBtns = [...shadow.querySelectorAll<HTMLButtonElement>(".tool")];
  const countEl = $("count");

  let editing = false;
  let tool: Tool = "select";
  let map: AddressMap = {};
  let annotations: Annotation[] = [];
  let hoverEl: Element | null = null;
  let selected: Element[] = [];
  let region: Region | undefined;
  let drawing = false;
  let path: Pt[] = [];
  let panel: HTMLDivElement | null = null;

  // -- data --------------------------------------------------------------

  async function refresh(): Promise<void> {
    try {
      const [m, a] = await Promise.all([
        fetch(`${BASE}/map`).then((r) => r.json() as Promise<AddressMap>),
        fetch(`${BASE}/annotations`).then((r) => r.json() as Promise<Annotation[]>),
      ]);
      map = m;
      annotations = a.filter((x) => x.url === location.pathname);
      renderPins();
    } catch {
      /* devtools server not running */
    }
  }
  void refresh();
  setInterval(() => void refresh(), 3000);

  // -- helpers -----------------------------------------------------------

  const stampOf = (el: Element) => el.getAttribute("data-orchid") ?? "";
  const addressOf = (el: Element) => map[stampOf(el)]?.address ?? `#${stampOf(el)}`;
  const nameOf = (el: Element) => map[stampOf(el)]?.name ?? el.tagName.toLowerCase();

  function stampedAt(x: number, y: number): Element | null {
    const prev = canvas.style.pointerEvents;
    canvas.style.pointerEvents = "none";
    const els = document.elementsFromPoint(x, y);
    canvas.style.pointerEvents = prev;
    for (const el of els) {
      if (el === host || host.contains(el)) continue;
      const s = el.closest("[data-orchid]");
      if (s) return s;
    }
    return null;
  }

  function pageRect(el: Element): Region {
    let r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.children.length) {
      // display: contents wrappers (component instances) have no box; use their children's.
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const c of el.children) {
        const b = c.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        x1 = Math.min(x1, b.left); y1 = Math.min(y1, b.top); x2 = Math.max(x2, b.right); y2 = Math.max(y2, b.bottom);
      }
      if (x1 !== Infinity) r = new DOMRect(x1, y1, x2 - x1, y2 - y1);
    }
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  function box(cls: string, r: Region, label?: string): HTMLDivElement {
    const d = document.createElement("div");
    d.className = cls;
    d.style.left = `${r.x - scrollX}px`;
    d.style.top = `${r.y - scrollY}px`;
    d.style.width = `${r.w}px`;
    d.style.height = `${r.h}px`;
    if (label) {
      const t = document.createElement("div");
      t.className = "tag";
      t.textContent = label;
      d.appendChild(t);
    }
    return d;
  }

  function renderBoxes(): void {
    layer.querySelectorAll(".hover, .sel").forEach((e) => e.remove());
    if (!editing) return;
    if (hoverEl && !selected.includes(hoverEl)) layer.appendChild(box("hover", pageRect(hoverEl), addressOf(hoverEl)));
    for (const el of selected) layer.appendChild(box("sel", pageRect(el), addressOf(el)));
  }

  function renderPins(): void {
    layer.querySelectorAll(".pin").forEach((e) => e.remove());
    const pending = annotations.filter((a) => a.status !== "done" && a.status !== "rejected");
    countEl.textContent = pending.length ? `${pending.length} open` : "";
    annotations.forEach((a, i) => {
      const stampsByAddress = Object.entries(map).filter(([, e]) => a.targets.includes(e.address)).map(([s]) => s);
      const first = stampsByAddress.map((s) => document.querySelector(`[data-orchid="${s}"]`)).find(Boolean);
      const r = first ? pageRect(first) : a.region;
      if (!r) return;
      const pin = document.createElement("div");
      pin.className = `pin ${a.status}`;
      pin.textContent = String(i + 1);
      pin.dataset.note = `${a.status}: ${a.note}${a.summary ? `\n\n${a.summary}` : ""}`;
      pin.style.left = `${r.x + r.w - scrollX}px`;
      pin.style.top = `${r.y - scrollY}px`;
      pin.onclick = () => {
        if (a.status === "done" || a.status === "rejected") {
          void fetch(`${BASE}/annotations/${a.id}`, { method: "DELETE" }).then(() => refresh());
        }
      };
      layer.appendChild(pin);
    });
  }

  addEventListener("scroll", () => { renderBoxes(); renderPins(); }, { passive: true });
  addEventListener("resize", () => { resizeCanvas(); renderBoxes(); renderPins(); });

  // -- edit mode ---------------------------------------------------------

  function setEditing(on: boolean): void {
    editing = on;
    toggleBtn.classList.toggle("on", on);
    toolBtns.forEach((b) => (b.hidden = !on));
    if (!on) { clearSelection(); setTool("select"); }
    renderBoxes();
  }

  function setTool(t: Tool): void {
    tool = t;
    toolBtns.forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    canvas.classList.toggle("active", editing && t !== "select");
    document.body.style.cursor = editing && t !== "select" ? "crosshair" : "";
  }

  function clearSelection(): void {
    selected = [];
    region = undefined;
    path = [];
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    panel?.remove();
    panel = null;
    renderBoxes();
  }

  toggleBtn.onclick = () => setEditing(!editing);
  toolBtns.forEach((b) => (b.onclick = () => setTool(b.dataset.tool as Tool)));
  addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyE") { e.preventDefault(); setEditing(!editing); }
    if (e.key === "Escape" && editing) { clearSelection(); }
  });

  // Hover + click selection
  document.addEventListener("mousemove", (e) => {
    if (!editing || tool !== "select") return;
    const el = stampedAt(e.clientX, e.clientY);
    if (el !== hoverEl) { hoverEl = el; renderBoxes(); }
  }, true);

  document.addEventListener("click", (e) => {
    if (!editing || tool !== "select") return;
    if (e.composedPath().includes(host)) return; // clicks on the overlay itself
    e.preventDefault();
    e.stopPropagation();
    const el = stampedAt(e.clientX, e.clientY);
    if (!el) return;
    if (e.shiftKey) selected = selected.includes(el) ? selected.filter((s) => s !== el) : [...selected, el];
    else selected = [el];
    region = undefined;
    renderBoxes();
    if (selected.length) openPanel();
    else { panel?.remove(); panel = null; }
  }, true);

  // Drawing
  function resizeCanvas(): void {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx2d.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }
  resizeCanvas();

  canvas.addEventListener("pointerdown", (e) => {
    if (!editing || tool === "select") return;
    drawing = true;
    path = [{ x: e.clientX + scrollX, y: e.clientY + scrollY }];
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = { x: e.clientX + scrollX, y: e.clientY + scrollY };
    if (tool === "box") path = [path[0]!, p];
    else path.push(p);
    strokePath();
  });
  canvas.addEventListener("pointerup", () => {
    if (!drawing) return;
    drawing = false;
    finishRegion();
  });

  function strokePath(): void {
    ctx2d.clearRect(0, 0, innerWidth, innerHeight);
    ctx2d.strokeStyle = "#e11d48";
    ctx2d.lineWidth = 3;
    ctx2d.lineJoin = "round";
    ctx2d.lineCap = "round";
    if (tool === "box" && path.length === 2) {
      const [a, b] = path as [Pt, Pt];
      ctx2d.strokeRect(Math.min(a.x, b.x) - scrollX, Math.min(a.y, b.y) - scrollY, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (path.length > 1) {
      ctx2d.beginPath();
      path.forEach((p, i) => (i ? ctx2d.lineTo(p.x - scrollX, p.y - scrollY) : ctx2d.moveTo(p.x - scrollX, p.y - scrollY)));
      ctx2d.stroke();
    }
  }

  function finishRegion(): void {
    if (path.length < 2) { path = []; return; }
    const xs = path.map((p) => p.x), ys = path.map((p) => p.y);
    const r: Region = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    if (tool === "pen") r.path = path;
    if (r.w < 4 && r.h < 4) { path = []; ctx2d.clearRect(0, 0, innerWidth, innerHeight); return; }
    region = r;
    selected = coveredElements(r);
    renderBoxes();
    openPanel();
  }

  /** Stamped elements mostly inside the region, keeping only the outermost. */
  function coveredElements(r: Region): Element[] {
    const all = [...document.querySelectorAll("[data-orchid]")];
    const inside = (el: Element) => {
      const b = pageRect(el);
      if (b.w === 0 || b.h === 0) return false;
      const ix = Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x));
      const iy = Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
      const overlap = (ix * iy) / (b.w * b.h);
      if (overlap < 0.6) return false;
      if (!r.path) return true;
      return pointInPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, r.path) || overlap > 0.95;
    };
    const covered = all.filter(inside);
    const outer = covered.filter((el) => !covered.some((o) => o !== el && o.contains(el)));
    if (outer.length) return outer;
    // Nothing fully inside: fall back to the smallest element that intersects.
    const hit = all
      .map((el) => ({ el, b: pageRect(el) }))
      .filter(({ b }) => b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y)
      .sort((a, b) => a.b.w * a.b.h - b.b.w * b.b.h)[0];
    return hit ? [hit.el] : [];
  }

  function pointInPolygon(p: Pt, poly: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // -- note panel --------------------------------------------------------

  function openPanel(): void {
    panel?.remove();
    panel = document.createElement("div");
    panel.className = "panel";
    const targets = selected.map(addressOf);
    const anchor = region ?? (selected[0] ? pageRect(selected[0]) : { x: scrollX + 40, y: scrollY + 40, w: 0, h: 0 });
    const left = Math.min(anchor.x + anchor.w + 12 - scrollX, innerWidth - 356);
    const top = Math.min(Math.max(anchor.y - scrollY, 12), innerHeight - 220);
    panel.style.left = `${Math.max(12, left)}px`;
    panel.style.top = `${top}px`;
    panel.innerHTML = `
      <div><b>${selected.length} node${selected.length === 1 ? "" : "s"}</b> ${selected.map(nameOf).join(", ")}</div>
      <div class="targets">${targets.map((t) => escapeHtml(t)).join("<br>")}</div>
      <textarea id="note" placeholder="What should change here?"></textarea>
      <div class="row"><button id="cancel">Cancel</button><button id="send" class="primary">Send to agent</button></div>`;
    shadow.appendChild(panel);
    const note = panel.querySelector<HTMLTextAreaElement>("#note")!;
    note.focus();
    panel.querySelector<HTMLButtonElement>("#cancel")!.onclick = clearSelection;
    panel.querySelector<HTMLButtonElement>("#send")!.onclick = () => void submit(note.value.trim());
    note.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit(note.value.trim());
      e.stopPropagation();
    });
  }

  async function submit(note: string): Promise<void> {
    if (!note) return;
    const targets = selected.map(addressOf);
    const body: NewAnnotation = {
      url: location.pathname,
      targets,
      commonAncestor: commonAncestor(targets),
      region,
      note,
      viewport: { width: innerWidth, height: innerHeight },
    };
    try {
      body.screenshot = await screenshot();
    } catch {
      /* screenshot is best-effort */
    }
    const res = await fetch(`${BASE}/annotations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    toast(res.ok ? "Sent. An agent can tend it now." : "Could not reach the devtools server.");
    clearSelection();
    void refresh();
  }

  /** Viewport screenshot with the selection and drawing painted on top. */
  async function screenshot(): Promise<string> {
    const shot = await toCanvas(document.documentElement, {
      width: innerWidth,
      height: innerHeight,
      pixelRatio: 1,
      filter: (n) => !(n instanceof Element && n.tagName.toLowerCase() === HOST_TAG),
      style: { transform: `translate(${-scrollX}px, ${-scrollY}px)` },
    });
    const c = shot.getContext("2d")!;
    c.lineWidth = 3;
    c.strokeStyle = "#e11d48";
    for (const el of selected) {
      const r = pageRect(el);
      c.strokeRect(r.x - scrollX, r.y - scrollY, r.w, r.h);
    }
    if (region?.path) {
      c.beginPath();
      region.path.forEach((p, i) => (i ? c.lineTo(p.x - scrollX, p.y - scrollY) : c.moveTo(p.x - scrollX, p.y - scrollY)));
      c.stroke();
    } else if (region) {
      c.setLineDash([6, 4]);
      c.strokeRect(region.x - scrollX, region.y - scrollY, region.w, region.h);
    }
    return shot.toDataURL("image/png");
  }

  function commonAncestor(addresses: string[]): string | undefined {
    if (!addresses.length) return undefined;
    const split = addresses.map((a) => a.split(" > "));
    let n = split[0]!.length;
    for (const parts of split.slice(1)) {
      let i = 0;
      while (i < n && i < parts.length && parts[i] === split[0]![i]) i++;
      n = i;
    }
    return n ? split[0]!.slice(0, n).join(" > ") : undefined;
  }

  function toast(msg: string): void {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    shadow.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  }
}
