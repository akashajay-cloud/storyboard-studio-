// GET /api/status?id=...  -> current project status + shots (polled by the frontend)
import { authed, json, getProject } from "./_lib.mjs";

export default async (req) => {
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return json({ error: "missing id" }, 400);
  const p = await getProject(id);
  if (!p) return json({ status: "error", message: "project not found" });
  return json({
    status: p.status,
    message: p.statusMessage || null,
    shots: p.shots || [],
    scene: p.scene, location: p.location || "",
    name: p.name,
  });
};
