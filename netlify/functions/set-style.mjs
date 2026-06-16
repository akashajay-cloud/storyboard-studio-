// POST /api/set-style — record the project's chosen STYLE reference.
//   JSON  { id, choice: "sketch"|"ink"|"grayscale" }  -> freeze that PREMADE static swatch as the ref.
//   multipart { id, style: <image file> }             -> use the uploaded image as the ref.
// The chosen ref is then fed into every panel's generation + QA.
import { authed, json, getProject, putProject, saveStyleImg } from "./_lib.mjs";

const PRESETS = ["sketch", "ink", "grayscale"];

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const ctype = req.headers.get("content-type") || "";

  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData();
      const id = String(form.get("id") || "");
      const file = form.get("style");
      if (!id || !file || typeof file === "string") return json({ error: "missing id/file" }, 400);
      const p = await getProject(id); if (!p) return json({ error: "project not found" }, 404);
      const b64 = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString("base64");
      await saveStyleImg(id, "ref", b64);
      await putProject(id, { ...p, styleRef: true, styleChoice: "upload" });
      return json({ ok: true, choice: "upload" });
    }

    const { id, choice } = await req.json();
    if (!id || !choice) return json({ error: "missing id/choice" }, 400);
    if (!PRESETS.includes(choice)) return json({ error: "unknown style" }, 400);
    const p = await getProject(id); if (!p) return json({ error: "project not found" }, 404);
    // premade swatches are static assets at /styles/<id>.png — fetch the chosen one + freeze it as this project's ref
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    const assetUrl = `${proto}://${host}/styles/${choice}.png`;
    const r = await fetch(assetUrl);
    if (!r.ok) return json({ error: `preset fetch ${r.status} (${assetUrl})` }, 502);
    const b64 = Buffer.from(new Uint8Array(await r.arrayBuffer())).toString("base64");
    await saveStyleImg(id, "ref", b64);
    await putProject(id, { ...p, styleRef: true, styleChoice: choice });
    return json({ ok: true, choice });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 400);
  }
};
