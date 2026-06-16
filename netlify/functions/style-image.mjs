// GET /api/style-image?id=...&which=cand_sketch|cand_ink|cand_grayscale|ref  -> the stored PNG.
// Public (no auth) so <img>/background-image can load it, same as /api/panel.
import { readStyleImg } from "./_lib.mjs";

const ALLOW = ["ref", "cand_sketch", "cand_ink", "cand_grayscale"];

export default async (req) => {
  const u = new URL(req.url);
  const id = u.searchParams.get("id"), which = u.searchParams.get("which");
  if (!id || !which) return new Response("missing id/which", { status: 400 });
  if (!ALLOW.includes(which)) return new Response("bad which", { status: 400 });
  const buf = await readStyleImg(id, which);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
};
