/**
 * Loads the edit-mode overlay from the Orchidery devtools server. Emitted
 * into the root layout in development only; renders nothing in production.
 */
export function OrchideryDevTools({ url }: { url?: string }) {
  if (process.env.NODE_ENV === "production") return null;
  const base = url ?? process.env.NEXT_PUBLIC_ORCHIDERY_DEVTOOLS_URL ?? "http://localhost:4747";
  return <script src={`${base}/overlay.js`} async data-orchidery-devtools={base} />;
}
