// POST /api/breakdown  (multipart: script file + project + mode + editorial)
// Extracts the script text, creates a project in Blobs, kicks off the background worker.
import { authed, json, putProject } from "./_lib.mjs";

async function extractText(file) {
  const name = (file.name || "").toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith(".txt") || name.endsWith(".csv")) return new TextDecoder().decode(buf);
  if (name.endsWith(".pdf")) {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
    return value;
  }
  // fallback: try utf-8
  return new TextDecoder().decode(buf);
}

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let form;
  try { form = await req.formData(); } catch { return json({ error: "expected multipart form" }, 400); }
  const file = form.get("script");
  if (!file || typeof file === "string") return json({ error: "no script file" }, 400);

  let text;
  try { text = (await extractText(file)).trim(); }
  catch (e) { return json({ error: "could not read script: " + String(e).slice(0, 200) }, 400); }
  if (!text || text.length < 20) return json({ error: "script appears empty" }, 400);

  const id = "p" + Date.now() + Math.random().toString(36).slice(2, 7);
  const name = String(form.get("project") || file.name.replace(/\.[^.]+$/, "") || "Untitled");
  const project = {
    id, name,
    scene: String(form.get("scene") || "01"),
    format: String(form.get("format") || "9:16"),
    mode: String(form.get("mode") || "script"),
    editorial: String(form.get("editorial") || "1") === "1",
    status: "breaking_down",
    statusMessage: null,
    scriptText: text,
    shots: [],
    createdAt: Date.now(),
  };
  await putProject(id, project);
  // NOTE: the frontend triggers /.netlify/functions/breakdown-background directly with this id —
  // a fire-and-forget fetch from here would be killed when this function returns.
  return json({ id });
};
