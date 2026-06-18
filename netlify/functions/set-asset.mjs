// POST /api/set-asset
//   multipart { id, which, image }       -> store an uploaded reference, APPEND it to the asset; returns {rid}
//   JSON { id, which, rid, action:"delete" } -> remove that one reference from the asset + Blobs
import { authed, json, getProject, putProject, saveAssetImg, deleteAssetImg, mkRid } from "./_lib.mjs";

const kindOf = (assets, which) =>
  (assets?.characters || []).find(x => x.which === which) ? "characters" :
  (assets?.locations || []).find(x => x.which === which) ? "locations" :
  (assets?.props || []).find(x => x.which === which) ? "props" : null;

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const ctype = req.headers.get("content-type") || "";
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const id = String(form.get("id") || ""), which = String(form.get("which") || "");
      const file = form.get("image");
      if (!id || !which || !file || typeof file === "string") return json({ error: "missing id/which/image" }, 400);
      const p = await getProject(id); if (!p) return json({ error: "project not found" }, 404);
      const kind = kindOf(p.assets, which); if (!kind) return json({ error: "asset not found" }, 404);
      const rid = mkRid();
      await saveAssetImg(id, which, rid, Buffer.from(new Uint8Array(await file.arrayBuffer())).toString("base64"));
      const a = JSON.parse(JSON.stringify(p.assets));
      a[kind].forEach(x => { if (x.which === which) x.refs = [...(x.refs || []), { rid, kind: "upload" }]; });
      await putProject(id, { ...p, assets: a });
      return json({ ok: true, rid });
    }
    const { id, which, rid, action } = await req.json();
    if (!id || !which || !rid) return json({ error: "missing id/which/rid" }, 400);
    const p = await getProject(id); if (!p) return json({ error: "project not found" }, 404);
    const kind = kindOf(p.assets, which); if (!kind) return json({ error: "asset not found" }, 404);
    if (action === "delete") {
      const a = JSON.parse(JSON.stringify(p.assets));
      a[kind].forEach(x => {
        if (x.which !== which) return;
        x.refs = (x.refs || []).filter(r => r.rid !== rid);
        if (x.selectedRid === rid) x.selectedRid = (x.refs[0] || {}).rid || null;
      });
      await putProject(id, { ...p, assets: a });
      await deleteAssetImg(id, which, rid);
    }
    if (action === "select") {
      const a = JSON.parse(JSON.stringify(p.assets));
      a[kind].forEach(x => { if (x.which === which) x.selectedRid = rid; });
      await putProject(id, { ...p, assets: a });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 400);
  }
};
