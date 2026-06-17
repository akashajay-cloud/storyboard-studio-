// Background worker: generate ONE more reference image for a production asset (character / location /
// prop) and APPEND it to that asset's gallery (assets can hold several angles). Stores the image in
// Blobs and adds {rid} to the asset's refs. Frontend triggers per asset and polls /api/status.
import {
  authed, getProject, putProject, generateImageB64, saveAssetImg, mkRid,
  charRefPrompt, locRefPrompt, propRefPrompt,
} from "./_lib.mjs";

const findAsset = (assets, which) =>
  (assets?.characters || []).find(x => x.which === which) ? "characters" :
  (assets?.locations || []).find(x => x.which === which) ? "locations" :
  (assets?.props || []).find(x => x.which === which) ? "props" : null;

export default async (req) => {
  if (!authed(req)) return new Response("unauthorized", { status: 401 });
  let id, which;
  try { ({ id, which } = await req.json()); } catch { return new Response("bad request", { status: 400 }); }
  const p = await getProject(id);
  if (!p) return new Response("not found", { status: 404 });
  const kind = findAsset(p.assets, which);
  if (!kind) return new Response("asset not found", { status: 404 });
  const asset = p.assets[kind].find(x => x.which === which);
  const prompt = kind === "characters" ? charRefPrompt(asset) : kind === "locations" ? locRefPrompt(asset) : propRefPrompt(asset);

  const rid = mkRid();
  try {
    const b64 = await generateImageB64(prompt);   // text-only realistic reference, no input refs
    await saveAssetImg(id, which, rid, b64);
    // append the new ref to the asset (re-read to reduce clobbering of concurrent edits)
    const proj = await getProject(id); if (!proj) return new Response("gone", { status: 200 });
    const a = JSON.parse(JSON.stringify(proj.assets || {}));
    (a[kind] || []).forEach(x => { if (x.which === which) x.refs = [...(x.refs || []), { rid, kind: "gen" }]; });
    await putProject(id, { ...proj, assets: a });
  } catch (_) { /* failed generation just adds nothing; the UI times out its loading tile */ }
  return new Response("done", { status: 200 });
};
