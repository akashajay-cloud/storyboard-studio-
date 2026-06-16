// Background worker: generate ONE panel (gpt-image-2) -> QA (Claude vision) -> store in Blobs ->
// update that shot's status on the project. Frontend dispatches one of these per shot (with a
// concurrency limit) and polls /api/status. Communicates only via Blobs.
import { authed, getProject, putProject, generateImageB64, qaPanel, savePanel } from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return new Response("unauthorized", { status: 401 });
  let id, shotNum, qa = true, promptOverride, feedback;
  try { ({ id, shot: shotNum, qa = true, prompt: promptOverride, feedback } = await req.json()); } catch { return new Response("bad request", { status: 400 }); }

  const project = await getProject(id);
  if (!project) return new Response("not found", { status: 404 });
  const shots = project.shots || [];
  const shot = shots.find(s => s.shot === shotNum);
  if (!shot) return new Response("shot not found", { status: 404 });
  if (promptOverride) shot.image_prompt = promptOverride;   // from the per-panel edit
  if (feedback) shot._feedback = feedback;

  const setShot = async (patch) => {
    const p = await getProject(id); if (!p) return;
    const arr = (p.shots || []).map(s => s.shot === shotNum ? { ...s, ...patch } : s);
    const done = arr.filter(s => s.panelStatus === "approved" || s.panelStatus === "flagged").length;
    await putProject(id, { ...p, shots: arr, panelsDone: done });
  };

  try {
    await setShot({ panelStatus: "drawing", reason: null });

    let prompt = shot.image_prompt || `${shot.type}. ${shot.caption || ""}`;
    if (shot._feedback) prompt += " CORRECTION: " + shot._feedback;
    let b64 = await generateImageB64(prompt);

    let status = "approved", reason = null;
    if (qa) {
      try {
        await setShot({ panelStatus: "qa" });
        const r = await qaPanel(b64, shot);
        if (!r.pass) {
          // one corrective regeneration using the QA fix
          if (r.fix) { try { b64 = await generateImageB64(prompt + " CORRECTION: " + r.fix); } catch (_) {} }
          const r2 = await qaPanel(b64, shot).catch(() => ({ pass: true }));
          if (!r2.pass) { status = "flagged"; reason = (r2.issues || r.issues || []).join("; ") || "QA flagged"; }
        }
      } catch (_) { /* QA inconclusive -> keep the image, mark approved */ }
    }

    await savePanel(id, shotNum, b64);
    await setShot({ panelStatus: status, reason, hasImage: true });
  } catch (e) {
    await setShot({ panelStatus: "error", reason: String(e).slice(0, 240) });
  }
  return new Response("done", { status: 200 });
};
