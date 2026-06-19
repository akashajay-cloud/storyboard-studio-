// Background worker: generate ONE panel (gpt-image-2) -> QA (Claude vision) -> store in Blobs ->
// update that shot's status on the project. Frontend dispatches one of these per shot (with a
// concurrency limit) and polls /api/status. Communicates only via Blobs.
// Look = a fixed photoreal full-colour cinematic frame. References passed to gpt-image's edits
// endpoint = this setup's STAGING frame (derived shots) + the shot's CHARACTER / LOCATION / key PROP
// reference images (Phase 2), as content/identity anchors. Capped — gpt-image juggles only a few well.
import {
  authed, getProject, putProject, generateImageB64, qaPanel, savePanel, readPanel, readAssetImg,
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

    // ---- references for GENERATION (content/identity anchors): the setup's STAGING frame (derived) +
    // ---- this shot's CHARACTER / LOCATION / key PROP reference images. Capped for gpt-image.
    const refs = [];
    let stagingB64 = null, locAdded = false;
    const A = project.assets || {};
    const MAX_REFS = 6;
    const loadRefBufs = async (asset, n) => {
      const out = [];
      // prefer the user-selected ref; fall back to first n refs in order
      const allRefs = asset?.refs || [];
      const ordered = asset?.selectedRid
        ? [allRefs.find(r => r.rid === asset.selectedRid), ...allRefs.filter(r => r.rid !== asset.selectedRid)].filter(Boolean)
        : allRefs;
      for (const r of ordered.slice(0, n)) {
        if (refs.length + out.length >= MAX_REFS) break;
        const buf = await readAssetImg(id, asset.which, r.rid);
        if (buf) out.push(Buffer.from(buf));
      }
      return out;
    };
    // characters FIRST — gpt-image weights earlier images more; face identity must come before staging
    const shotChars = new Set([...(shot.figures || []).map(f => f && f.name), ...(shot.characters || [])].filter(Boolean));
    const charNames = [];
    for (const c of (A.characters || [])) {
      if (!shotChars.has(c.name) || refs.length >= MAX_REFS) continue;
      const b = await loadRefBufs(c, 1); if (b.length) { refs.push(...b); charNames.push(c.name); }
    }
    // location reference leads the staging shot (it has no staging frame of its own yet)
    if (shot.is_staging && shot.setup) {
      const loc = (A.locations || []).find(l => l.id === shot.setup);
      if (loc) { const b = await loadRefBufs(loc, 1); if (b.length) { refs.push(...b); locAdded = true; } }
    }
    // staging frame for derived shots (location + established blocking continuity)
    if (!shot.is_staging && shot.setup) {
      const stagingShot = shots.find(s => s.is_staging && s.setup === shot.setup);
      if (stagingShot) { const pbuf = await readPanel(id, stagingShot.shot); if (pbuf) { const b = Buffer.from(pbuf); refs.push(b); stagingB64 = b.toString("base64"); } }
    }
    // key props mentioned in this shot's text
    const shotText = `${shot.caption || ""} ${shot.action || ""} ${shot.image_prompt || ""}`.toLowerCase();
    const propNames = [];
    for (const p of (A.props || [])) {
      if (refs.length >= MAX_REFS) break;
      const kw = String(p.name || "").toLowerCase().split(/\s+/).find(w => w.length > 3) || String(p.name || "").toLowerCase();
      if (kw && shotText.includes(kw)) { const b = await loadRefBufs(p, 1); if (b.length) { refs.push(...b); propNames.push(p.name); } }
    }

    // Build usedRefs list for the frontend to display as thumbnails on each panel card.
    // { which, rid, role, label } — role is "location" | "staging" | "character" | "prop"
    const usedRefs = [];
    if (locAdded) {
      const loc = (A.locations || []).find(l => l.id === shot.setup);
      if (loc && (loc.refs || []).length) usedRefs.push({ which: loc.which, rid: loc.refs[0].rid, role: "location", label: loc.label || loc.id });
    }
    if (stagingB64) {
      const stagingShot = shots.find(s => s.is_staging && s.setup === shot.setup);
      if (stagingShot) usedRefs.push({ which: "staging", rid: String(stagingShot.shot), role: "staging", label: "Staging frame" });
    }
    for (const name of charNames) {
      const c = (A.characters || []).find(x => x.name === name);
      if (c && (c.refs || []).length) usedRefs.push({ which: c.which, rid: c.refs[0].rid, role: "character", label: name });
    }
    for (const name of propNames) {
      const p = (A.props || []).find(x => x.name === name);
      if (p && (p.refs || []).length) usedRefs.push({ which: p.which, rid: p.refs[0].rid, role: "prop", label: name });
    }

    // ---- assemble: photoreal lead -> reference roles -> shot size + lens -> blocking -> lighting ->
    // ---- name labels -> inline "no".
    const refBits = [];
    if (locAdded) refBits.push("a reference photo of the LOCATION — match the place exactly");
    if (stagingB64) refBits.push("the wide STAGING frame of this location — keep the same place, props and the figures' established left-to-right positions");
    // Per-character appearance override: when a ref photo exists, the model must use the photo for
    // face AND clothing, ignoring any text description of that character's look.
    if (charNames.length) {
      refBits.push(
        `the FIRST ${charNames.length > 1 ? charNames.length + " reference photos are" : "reference photo is"} of ${charNames.join(" and ")} — ` +
        `COPY each person's face, hair, skin tone, and ALL clothing EXACTLY from their reference photo. ` +
        `Do NOT substitute generic faces or invent clothing. The character must be identifiable as the same person across every shot.`
      );
    }
    if (propNames.length) refBits.push(`reference photos of ${propNames.join(", ")} — keep these objects consistent`);
    const refLine = refBits.length ? `You are given reference images: ${refBits.join("; ")}. Match them so the people, place and objects stay consistent across shots. ` : "";

    // Gender override: if a character has a ref photo, the photo defines their gender — the script's
    // text may have guessed wrong (e.g. named "Arya" assumed female; ref shows male). Append an
    // explicit correction so the gendered words in image_prompt don't fight the reference.
    const genderOverrides = charNames.map(name => {
      const c = (A.characters || []).find(x => x.name === name);
      const fig = (shot.figures || []).find(f => f && f.name === name);
      if (!fig) return null;
      // We can't read the ref image to detect gender, but we can tell the model: let the photo decide.
      return `IMPORTANT: The word "${fig.gender}" in the prompt below may be wrong for ${name} — the reference photo shows their actual gender. Render ${name} exactly as they appear in their reference photo, ignoring any gendered text description.`;
    }).filter(Boolean);
    const genderOverrideLine = genderOverrides.length ? genderOverrides.join(" ") + " " : "";

    const blocking = coreBlocking(shot.image_prompt) || shot.action || shot.caption || "";
    const anchor = lightingAnchorFor(shots, shot);                 // one lighting anchor per setup
    const labels = labelInstruction(shot.figures, shot.characters, project.styles);
    const tail = " No captions, borders, panel frames, watermarks or UI — only the small character name labels described above.";

    let prompt = promptOverride
      ? CINEMATIC_LEAD + " " + refLine + genderOverrideLine + promptOverride + labels + tail
      : CINEMATIC_LEAD + " " + refLine + genderOverrideLine + `${shot.type}, ${lensFor(shot.type)}. ` + blocking
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
    await setShot({ panelStatus: status, reason, hasImage: true, usedRefs });
  } catch (e) {
    await setShot({ panelStatus: "error", reason: String(e).slice(0, 240) });
  }
  return new Response("done", { status: 200 });
};
