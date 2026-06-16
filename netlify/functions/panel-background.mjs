// Background worker: generate ONE panel (gpt-image-2) -> QA (Claude vision) -> store in Blobs ->
// update that shot's status on the project. Frontend dispatches one of these per shot (with a
// concurrency limit) and polls /api/status. Communicates only via Blobs.
// References: the project's chosen STYLE anchor (every panel) + this setup's STAGING frame (derived
// shots), passed to gpt-image-2's edits endpoint AND to QA. The prompt then carries only the delta.
import {
  authed, getProject, putProject, generateImageB64, qaPanel, savePanel, readPanel,
  readStyleImg, coreBlocking, labelInstruction, styleClauseFor, lensFor, lightingAnchorFor,
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

    // ---- assemble references: style anchor (all panels) + this setup's staging frame (derived) ----
    const refs = [];
    let styleB64 = null, stagingB64 = null;
    if (project.styleRef) {
      const sbuf = await readStyleImg(id, "ref");
      if (sbuf) { const b = Buffer.from(sbuf); refs.push(b); styleB64 = b.toString("base64"); }
    }
    if (!shot.is_staging && shot.setup) {
      const stagingShot = shots.find(s => s.is_staging && s.setup === shot.setup);
      if (stagingShot) {
        const pbuf = await readPanel(id, stagingShot.shot);
        if (pbuf) { const b = Buffer.from(pbuf); refs.push(b); stagingB64 = b.toString("base64"); }
      }
    }

    // ---- assemble in cinematographer order: references -> shot size -> blocking (angle / figures by
    // ---- gender+position+facing / expression / FG-MG-BG depth) -> lighting anchor -> lens -> style
    // ---- -> name labels -> inline "no". Figures are described by gender+position; NAMES only label.
    const refLine = (styleB64 && stagingB64)
      ? "Two reference images. Reference 1 = STYLE: match its drawing medium, linework and finish EXACTLY, but ignore its subject and composition. Reference 2 = STAGING: keep the SAME location, props and the figures' established left-to-right positions. "
      : styleB64
      ? "Reference image = STYLE: match its drawing medium, linework and finish EXACTLY, but ignore its subject. "
      : "";
    const blocking = coreBlocking(shot.image_prompt) || shot.action || shot.caption || "";
    const anchor = lightingAnchorFor(shots, shot);                 // one lighting anchor per setup
    const styleText = styleClauseFor(project.styleChoice);         // explicit words for the SELECTED style
    const styleDirective = styleText
      ? " Style: " + styleText
      : (styleB64 ? " Match the style reference's medium and finish exactly." : "");
    const labels = labelInstruction(shot.figures, shot.characters, project.styles);
    const tail = " No text or captions other than the character name labels; no panel borders, frames or UI.";

    let prompt = promptOverride
      ? refLine + promptOverride + styleDirective + labels + tail
      : refLine + `${shot.type}. ` + blocking
        + (anchor ? " Lighting: " + anchor : "")
        + " " + lensFor(shot.type) + "."
        + styleDirective + labels + tail;
    if (shot._feedback) prompt += " CORRECTION: " + shot._feedback;

    let b64 = await generateImageB64(prompt, refs);

    let status = "approved", reason = null;
    if (qa) {
      try {
        await setShot({ panelStatus: "qa" });
        const r = await qaPanel(b64, shot, { styleB64, stagingB64 });
        if (!r.pass) {
          // one corrective regeneration using the QA fix (keep the same references)
          if (r.fix) { try { b64 = await generateImageB64(prompt + " CORRECTION: " + r.fix, refs); } catch (_) {} }
          const r2 = await qaPanel(b64, shot, { styleB64, stagingB64 }).catch(() => ({ pass: true }));
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
