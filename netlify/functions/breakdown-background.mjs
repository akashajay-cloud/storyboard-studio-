// Background worker (up to 15 min). Runs the Claude breakdown (+ editorial + styling)
// and writes the result back to the project in Blobs. Communicates only via Blobs.
import {
  BREAKDOWN_PROMPT, EDITORIAL_PROMPT, SCENE_PROMPT,
  invokeClaude, parseJsonArray, parseJsonObject, applyCharacterStyling,
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

    await putProject(id, {
      ...project, status: "shots_ready", stage: "done", statusMessage: null,
      shots: styled, styles, scene, location: label,   // keep the char->colour map for slim prompts
      panelsTotal: styled.length, panelsDone: 0,
      scriptText: undefined, // drop the bulky text now that we're done
    });
  } catch (e) {
    // Always write a TERMINAL error so the UI surfaces it instead of hanging forever.
    await putProject(id, { ...project, status: "error", statusMessage: String(e).slice(0, 400), scriptText: undefined });
  }
  return new Response("done", { status: 200 });
};
