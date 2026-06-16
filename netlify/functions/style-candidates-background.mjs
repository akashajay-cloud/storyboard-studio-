// Background worker: generate the 3 style-candidate swatches for a project (in parallel), store
// them in Blobs, and flip styleStage to "ready". The frontend polls /api/status and fills each
// swatch as it appears, then the user picks one (or uploads their own) via /api/set-style.
import {
  authed, getProject, putProject, generateImageB64, saveStyleImg,
  STYLE_CANDIDATES, styleCandidatePrompt,
} from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return new Response("unauthorized", { status: 401 });
  let id;
  try { ({ id } = await req.json()); } catch { return new Response("bad request", { status: 400 }); }
  const project = await getProject(id);
  if (!project) return new Response("not found", { status: 404 });

  // If they're already generated, don't pay to redo them.
  if ((project.styleCandidates || []).length >= STYLE_CANDIDATES.length) {
    return new Response("ok", { status: 200 });
  }

  await putProject(id, { ...project, styleStage: "generating", styleCandidates: [], styleError: null });

  // Each candidate is independent; one failing must not sink the others.
  const results = await Promise.allSettled(STYLE_CANDIDATES.map(async (c) => {
    const b64 = await generateImageB64(styleCandidatePrompt(c)); // text-only — these bootstrap the look
    await saveStyleImg(id, "cand_" + c.id, b64);
    return c.id;
  }));

  const ready = results.filter(r => r.status === "fulfilled").map(r => r.value);
  const failed = STYLE_CANDIDATES.filter(c => !ready.includes(c.id)).map(c => c.id);
  const reason = results.find(r => r.status === "rejected");
  const p = await getProject(id);
  await putProject(id, {
    ...p,
    styleStage: ready.length ? "ready" : "error",
    styleCandidates: ready,
    styleError: failed.length ? `failed: ${failed.join(", ")}${reason ? " — " + String(reason.reason).slice(0, 160) : ""}` : null,
  });
  return new Response("done", { status: 200 });
};
