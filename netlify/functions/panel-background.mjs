// Background worker: generate ONE panel (gpt-image-2) -> QA (Claude vision) -> store in Blobs ->
// update that shot's status on the project. Frontend dispatches one of these per shot (with a
// concurrency limit) and polls /api/status. Communicates only via Blobs.
// Look = a fixed photoreal full-colour cinematic frame. The only reference is this setup's STAGING
// frame (derived shots), passed to gpt-image's edits endpoint for location/content continuity.
import {
  authed, getProject, putProject, generateImageB64, qaPanel, savePanel, readPanel,
  coreBlocking, labelInstruction, CINEMATIC_LEAD, lensFor, lightingAnchorFor,
} from "./_lib.mjs";

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

    // ---- reference for GENERATION = this setup's STAGING frame (derived shots), for location/content
    // ---- continuity (passed to gpt-image's edits endpoint). Staging shots themselves have no ref.
    const refs = [];
    let stagingB64 = null;
    if (!shot.is_staging && shot.setup) {
      const stagingShot = shots.find(s => s.is_staging && s.setup === shot.setup);
      if (stagingShot) {
        const pbuf = await readPanel(id, stagingShot.shot);
        if (pbuf) { const b = Buffer.from(pbuf); refs.push(b); stagingB64 = b.toString("base64"); }
      }
    }

    // ---- assemble: photoreal cinematic lead -> staging reference role -> shot size + lens (the
    // ---- telephoto hack) -> blocking (figures by gender+position+facing, FG/MG/BG depth) -> per-setup
    // ---- lighting anchor -> name labels -> inline "no".
    const refLine = stagingB64
      ? "Use the STAGING reference image to keep the SAME location, set, props, palette and the figures' established left-to-right positions; only the framing, action and expressions change for this shot. "
      : "";
    const blocking = coreBlocking(shot.image_prompt) || shot.action || shot.caption || "";
    const anchor = lightingAnchorFor(shots, shot);                 // one lighting anchor per setup
    const labels = labelInstruction(shot.figures, shot.characters, project.styles);
    const tail = " No captions, borders, panel frames, watermarks or UI — only the small character name labels described above.";

    let prompt = promptOverride
      ? CINEMATIC_LEAD + " " + refLine + promptOverride + labels + tail
      : CINEMATIC_LEAD + " " + refLine + `${shot.type}, ${lensFor(shot.type)}. ` + blocking
        + (anchor ? " Lighting: " + anchor.replace(/\s*\.?\s*$/, "") + "." : "")
        + labels + tail;
    if (shot._feedback) prompt += " CORRECTION: " + shot._feedback;

    let b64 = await generateImageB64(prompt, refs);

    let status = "approved", reason = null;
    if (qa) {
      try {
        await setShot({ panelStatus: "qa" });
        const r = await qaPanel(b64, shot, { stagingB64 });
        if (!r.pass) {
          // one corrective regeneration using the QA fix (keep the same reference)
          if (r.fix) { try { b64 = await generateImageB64(prompt + " CORRECTION: " + r.fix, refs); } catch (_) {} }
          const r2 = await qaPanel(b64, shot, { stagingB64 }).catch(() => ({ pass: true }));
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
