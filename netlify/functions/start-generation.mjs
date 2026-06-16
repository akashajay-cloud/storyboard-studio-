// POST /api/start-generation {id}  -> mark all shots pending and the project "generating".
// The frontend then dispatches panel-background per shot (staging first) with a concurrency limit.
import { authed, json, getProject, putProject } from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  let id;
  try { ({ id } = await req.json()); } catch { return json({ error: "bad request" }, 400); }
  const p = await getProject(id);
  if (!p) return json({ error: "project not found" }, 404);

  const shots = (p.shots || []).map(s => ({ ...s, panelStatus: s.panelStatus === "approved" ? "approved" : "pending" }));
  await putProject(id, { ...p, status: "generating", shots, panelsTotal: shots.length });
  return json({ ok: true, shots: shots.map(s => ({ shot: s.shot, type: s.type, is_staging: !!s.is_staging, setup: s.setup, panelStatus: s.panelStatus })) });
};
