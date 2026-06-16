// Shared backend helpers: Claude calls, the (ported) breakdown/editorial prompts,
// character styling, Blobs storage, and the password gate.
import { getStore } from "@netlify/blobs";

export const MODEL = "claude-sonnet-4-6";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ---- house style (verbatim from the CLI's style.py) ----
export const STYLE_CLAUSE =
  "Rough black-and-white gestural storyboard BLOCKING SKETCH only - loose, quick, unfinished " +
  "pencil construction lines like a fast pre-production thumbnail. Faceless generic figures " +
  "with plain oval heads and NO facial features (a rough expression is allowed only in a " +
  "close-up), NO hair detail, NO detailed or textured clothing, NO shading, NO cross-hatching, " +
  "NO grayscale rendering, NO realism, NO finished-illustration look. Show gender through body " +
  "proportions only. Minimal line-art background on plain white. The ONLY colour anywhere in " +
  "the image is each character's full-name text label written next to their figure in that " +
  "character's assigned colour; every line of the drawing itself is plain black on white. The " +
  "image must contain ONLY the illustrated scene filling the frame - no text except the " +
  "character name labels, and no captions, borders, panel frames, UI elements, or storyboard " +
  "template layout.";

// ---- breakdown system prompt (ported from shot_breakdown.py) ----
export const BREAKDOWN_PROMPT = `You are a professional storyboard artist and cinematographer working on micro-drama (short-form vertical/landscape drama) productions. Given a script or scene, break it down into a numbered sequence of storyboard shots.

For each shot, decide the shot type (e.g. WIDE ESTABLISHING, MEDIUM, CLOSE UP, TRACKING, POV, DYNAMIC ANGLE, INSERT) based on the dramatic beat. Aim for shots that read clearly as single images - split complex actions into multiple shots if needed. KEEP THE BREAKDOWN FOCUSED: at most 30 shots; produce COMPLETE, valid JSON (never stop mid-object). Cover the script faithfully; a separate editorial pass adds extra coverage afterward.

Return ONLY a JSON array (no markdown fences, no commentary). Each element must have these exact keys:
- "shot": integer, sequential starting at 1
- "type": shot type, in capitals (e.g. "WIDE ESTABLISHING SHOT", "CLOSE UP")
- "caption": 2-3 short lines in present tense, natural sentence case, the way a storyboard scene description reads. Join lines with \\n.
- "characters": array of character names visible in this shot (empty array if none)
- "setting": brief description of location/environment
- "setup": a short lowercase id for the physical location/configuration (e.g. "lab_floor", "carter_office"). EVERY shot in the same physical space shares the same setup id.
- "is_staging": boolean. For EACH distinct setup, include exactly ONE shot with "is_staging": true - a WIDE ESTABLISHING shot showing the whole space and ALL characters in that setup, in clear left-to-right positions, plus key props. Make it the FIRST shot of that setup. All others are false.
- "action": one sentence describing what is happening
- "mood": lighting/atmosphere description
- "image_prompt": 2-3 sentences describing ONLY composition, blocking, poses, camera angle, and spatial relationships - a rough blocking sketch, not finished art. State each visible figure's EXPLICIT position (far-left/center/far-right, foreground/mid/background), consistent with that setup's staging shot. Whenever a character moves or is oriented toward/away from someone, state the direction EXPLICITLY relative to the others AND the camera (never the bare word "forward"). Make every gaze/approach/reach unambiguous about who/what it targets. Do not describe drawing style/colour/rendering - a fixed house-style sentence is appended automatically.

Image-generation safety: depict romance/intimacy/violence tastefully and non-explicitly (poses, framing, spatial relationships - not literal kissing/embracing/gore).`;

// ---- editorial enrichment prompt (ported from shot_breakdown.py) ----
export const EDITORIAL_PROMPT = `You are a film editor enriching a faithful shot breakdown (given as a JSON array) into more engaging coverage WITHOUT changing the story.

Insert extra shots between existing ones where they strengthen the visual language: REACTION shots, INSERTS/CUTAWAYS (a hand, a prop, a detail), B-ROLL/establishing beats, and rhythm beats. Add with intent - a handful of well-placed additions per scene, not filler.

HARD RULES:
- KEEP every original shot (light caption polish only).
- Do NOT add new staging shots. Keep exactly the staging shots already marked "is_staging": true. Every added shot has "is_staging": false and reuses an EXISTING "setup" id from its neighbours.
- Use the EXACT same JSON keys as the existing shots ("shot","type","caption","characters","setting","setup","is_staging","action","mood","image_prompt").
- Write each added shot's "image_prompt" in the same style and END it with this EXACT sentence: "${STYLE_CLAUSE}"
- Renumber "shot" sequentially from 1 in final viewing order.

Return ONLY the full enriched JSON array.`;

export const SCENE_PROMPT = `Read the script and return ONLY a JSON object {"scene": "<number or '01'>", "label": "<short location/scene label, or ''>"} describing the first/primary scene. No commentary.`;

const PALETTE = ["red", "blue", "green", "orange", "purple", "teal", "magenta", "brown", "olive", "navy"];

export function applyCharacterStyling(shots) {
  const colorMap = {};
  for (const s of shots) for (const c of (s.characters || [])) if (!(c in colorMap)) colorMap[c] = PALETTE[Object.keys(colorMap).length % PALETTE.length];
  for (const s of shots) {
    const chars = s.characters || [];
    if (!chars.length) continue;
    const assignments = chars.map(c => `"${String(c).toUpperCase()}" in ${colorMap[c]}`).join(", ");
    s.image_prompt = (s.image_prompt || "") +
      ` Character name-label colors for this panel: ${assignments} - write each character's FULL NAME as a small text label next to their figure in the assigned color, while every line of the drawing itself stays plain black on white.`;
  }
  return { shots, styles: colorMap };
}

// ---- Claude call over plain fetch (no SDK) ----
export async function invokeClaude(system, userText, maxTokens = 16000) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userText }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || "").join("");
}

export function parseJsonArray(raw) {
  let t = String(raw).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Could not parse model output as JSON");
}
export function parseJsonObject(raw) {
  let t = String(raw).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(a !== -1 && b > a ? t.slice(a, b + 1) : t);
}

// ---- storage (Netlify Blobs) ----
export const projects = () => getStore("projects");
export const getProject = async id => (await projects().get(id, { type: "json" })) || null;
export const putProject = (id, obj) => projects().setJSON(id, obj);

// ---- auth gate ----
export function authed(req) {
  const need = process.env.APP_PASSWORD;
  if (!need) return true; // no password configured -> open
  const got = req.headers.get("x-app-password");
  return got === need;
}
export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
