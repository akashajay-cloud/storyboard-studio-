// GET /api/asset-image?id=...&which=char_x|loc_x|prop_x&rid=...  -> one stored reference PNG.
// Public (no auth) so <img>/background-image can load it, same as /api/panel.
import { readAssetImg } from "./_lib.mjs";

export default async (req) => {
  const u = new URL(req.url);
  const id = u.searchParams.get("id"), which = u.searchParams.get("which"), rid = u.searchParams.get("rid");
  if (!id || !which || !rid) return new Response("missing id/which/rid", { status: 400 });
  const buf = await readAssetImg(id, which, rid);
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(buf, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
};
