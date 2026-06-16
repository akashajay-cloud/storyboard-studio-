// POST /api/set-style — record the project's chosen STYLE reference.
//   JSON  { id, choice: "sketch"|"ink"|"grayscale" }  -> copy that candidate to the "ref" slot.
//   multipart { id, style: <image file> }             -> use the uploaded image as the ref.
// The chosen ref is then fed into every panel's generation + QA.
import { authed, json, getProject, putProject, readStyleImg, saveStyleImg } from "./_lib.mjs";

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
    const p = await getProject(id); if (!p) return json({ error: "project not found" }, 404);
    const buf = await readStyleImg(id, "cand_" + choice);
    if (!buf) return json({ error: "candidate not generated" }, 404);
    await saveStyleImg(id, "ref", Buffer.from(buf).toString("base64"));
    await putProject(id, { ...p, styleRef: true, styleChoice: choice });
    return json({ ok: true, choice });
  } catch (e) {
    return json({ error: String(e).slice(0, 200) }, 400);
  }
};
