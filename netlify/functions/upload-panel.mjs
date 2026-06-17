// POST /api/upload-panel  (multipart: id, shot, image)
// Stores a user-uploaded image as that shot's panel in Blobs, so it becomes the real reference for
// the scene (derived shots anchor to a staging frame via /api/panel) and shows on the storyboard.
import { authed, json, getProject, putProject, savePanel } from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let form;
  try { form = await req.formData(); } catch { return json({ error: "expected multipart form" }, 400); }
  const id = String(form.get("id") || "");
  const shotNum = Number(form.get("shot"));
  const file = form.get("image");
  if (!id || !shotNum || !file || typeof file === "string") return json({ error: "missing id/shot/image" }, 400);

  const p = await getProject(id);
  if (!p) return json({ error: "project not found" }, 404);

  const b64 = Buffer.from(new Uint8Array(await file.arrayBuffer())).toString("base64");
  await savePanel(id, shotNum, b64);
  const shots = (p.shots || []).map(s => s.shot === shotNum
    ? { ...s, panelStatus: "approved", hasImage: true, reason: null, uploaded: true } : s);
  await putProject(id, { ...p, shots });
  return json({ ok: true });
};
