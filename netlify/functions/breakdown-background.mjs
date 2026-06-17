// Background worker (up to 15 min). Runs the Claude breakdown (+ editorial + styling)
// and writes the result back to the project in Blobs. Communicates only via Blobs.
import {
  BREAKDOWN_PROMPT, EDITORIAL_PROMPT, SCENE_PROMPT, ASSET_PROMPT,
  invokeClaude, parseJsonArray, parseJsonObject, applyCharacterStyling, slug,
  getProject, putProject, authed,
} from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return new Response("unauthorized", { status: 401 });
  let id;
  try { ({ id } = await req.json()); } catch { return new Response("bad request", { status: 400 }); }
  const project = await getProject(id);
  if (!project) return new Response("not found", { status: 404 });
  if (project.status !== "breaking_down") return new Response("ok", { status: 200 });

  // report progress per stage so the UI lights up real steps (reading->breakdown->editorial->styling)
  const setStage = (stage) => putProject(id, { ...project, status: "breaking_down", stage });

  try {
    // 1) faithful breakdown (generous token budget so the JSON array isn't truncated)
    await setStage("breakdown");
    let shots = parseJsonArray(await invokeClaude(BREAKDOWN_PROMPT, project.scriptText, 24000));
    if (!Array.isArray(shots) || shots.length === 0) throw new Error("no shots produced");

    // 2) optional editorial enrichment
    if (project.editorial) {
      await setStage("editorial");
      try {
        const enriched = parseJsonArray(await invokeClaude(EDITORIAL_PROMPT, "Enrich this shot breakdown:\n\n" + JSON.stringify(shots), 24000));
        if (Array.isArray(enriched) && enriched.length >= shots.length) shots = enriched;
      } catch (_) { /* keep the faithful breakdown if editorial fails */ }
    }

    // 3) scene/label detection + 4) character styling
    await setStage("styling");
    let scene = project.scene, label = "";
    try {
      const info = parseJsonObject(await invokeClaude(SCENE_PROMPT, project.scriptText.slice(0, 8000), 300));
      scene = info.scene || scene; label = info.label || "";
    } catch (_) {}

    const { shots: styled, styles } = applyCharacterStyling(shots);
    styled.forEach((s, i) => { s.shot = i + 1; });

    // 5) production-asset detection: characters (+ look), locations, key props -> reference targets
    let assets = { characters: [], locations: [], props: [] };
    try {
      const names = Object.keys(styles);
      const genderOf = {};
      for (const s of styled) for (const f of (s.figures || [])) if (f && f.name && !genderOf[f.name]) genderOf[f.name] = f.gender;
      const setups = {};
      for (const s of styled) if (s.setup && !(s.setup in setups)) setups[s.setup] = s.setting || s.setup;
      const summary = `CHARACTERS: ${names.map(n => `${n} (${genderOf[n] || "person"})`).join(", ") || "(none)"}\nLOCATIONS: ${Object.entries(setups).map(([k, v]) => `${k} (${v})`).join("; ") || "(none)"}`;
      let enr = {};
      try { enr = parseJsonObject(await invokeClaude(ASSET_PROMPT, summary + "\n\nSCRIPT:\n" + (project.scriptText || "").slice(0, 8000), 2000)); } catch (_) {}
      const lookOf = {}; (enr.characters || []).forEach(c => { if (c && c.name) lookOf[c.name] = c.look; });
      const locOf = {}; (enr.locations || []).forEach(l => { if (l && l.id) locOf[l.id] = l; });
      assets.characters = names.map(n => ({ name: n, gender: genderOf[n] || "person", color: styles[n], look: lookOf[n] || "", which: "char_" + slug(n), refs: [] }));
      assets.locations = Object.entries(setups).map(([k, v]) => ({ id: k, label: locOf[k]?.label || v, desc: locOf[k]?.desc || v, which: "loc_" + slug(k), refs: [] }));
      assets.props = (Array.isArray(enr.props) ? enr.props : []).slice(0, 6).filter(p => p && p.name).map(p => ({ name: p.name, desc: p.desc || "", which: "prop_" + slug(p.name), refs: [] }));
    } catch (_) { /* assets are best-effort */ }

    await putProject(id, {
      ...project, status: "shots_ready", stage: "done", statusMessage: null,
      shots: styled, styles, assets, scene, location: label,   // keep colour map + detected assets
      panelsTotal: styled.length, panelsDone: 0,
      scriptText: undefined, // drop the bulky text now that we're done
    });
  } catch (e) {
    // Always write a TERMINAL error so the UI surfaces it instead of hanging forever.
    await putProject(id, { ...project, status: "error", statusMessage: String(e).slice(0, 400), scriptText: undefined });
  }
  return new Response("done", { status: 200 });
};
