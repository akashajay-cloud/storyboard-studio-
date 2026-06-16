// GET /api/panel?id=...&shot=N  -> the stored PNG bytes for that panel.
import { readPanel } from "./_lib.mjs";

export default async (req) => {
  const u = new URL(req.url);
  const id = u.searchParams.get("id"), shot = Number(u.searchParams.get("shot"));
  if (!id || !shot) return new Response("missing id/shot", { status: 400 });
  const buf = await readPanel(id, shot);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
};
