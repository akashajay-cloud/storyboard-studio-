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
  const a = t.indexOf("["); if (a !== -1) t = t.slice(a);
  try { const b = t.lastIndexOf("]"); if (b > 0) return JSON.parse(t.slice(0, b + 1)); } catch {}
  // Salvage: pull out every COMPLETE top-level {...} object, so a response that was cut off
  // mid-array still yields all the shots that finished (never a silent "half" or hard fail).
  const objs = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { try { objs.push(JSON.parse(t.slice(start, i + 1))); } catch {} start = -1; } }
  }
  if (objs.length) return objs;
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

// ===================== image generation (OpenAI gpt-image-2) =====================
export const IMAGE_MODEL = "gpt-image-2";
export const IMAGE_SIZE = "1024x1536"; // 9:16 portrait
export const IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";

// ---- per-project style anchor: 3 candidate swatches the user picks from (or replaces by upload) ----
// Rendered text-only (these bootstrap the look); the chosen one becomes the STYLE reference fed into
// every panel. Subject is deliberately neutral so its CONTENT never bleeds into real scenes.
const STYLE_SUBJECT =
  "A neutral style swatch for a storyboard: two simple blocking figures (one reading male, one " +
  "female by body proportion only) standing a little apart on plain white, each with a short " +
  "example full-name label - 'ALEX' in red beside one figure, 'SAM' in blue beside the other. No " +
  "background, no props - this image is ONLY a sample of the drawing STYLE.";
export const STYLE_CANDIDATES = [
  { id: "sketch", name: "Rough storyboard sketch",
    clause: "Draw it as a loose, rough black-and-white pre-production storyboard sketch: quick gestural " +
      "pencil construction lines, faceless figures with plain oval heads, NO shading, NO rendering - a fast thumbnail." },
  { id: "ink", name: "Clean comic line-art",
    clause: "Draw it as clean black ink line-art: confident even contour lines, flat, NO shading or hatching, " +
      "faceless figures with simple oval heads, crisp comic-panel clarity on white." },
  { id: "grayscale", name: "Cinematic grayscale concept",
    clause: "Draw it as a moody cinematic grayscale concept sketch: soft graphite shading and tonal depth, " +
      "gentle directional lighting, figures still loosely blocked with no detailed faces, atmospheric but monochrome." },
];
export const styleCandidatePrompt = (c) =>
  `${STYLE_SUBJECT} ${c.clause} The ONLY colour anywhere is the two name labels; every drawn line is otherwise black on white.`;

// Appended on a content-moderation block (clothes the faceless figures so they don't read as nude).
export const SOFTEN_CLAUSE =
  " All figures must be fully clothed in simple, plain, loosely-sketched clothing, with NO bare " +
  "skin, NO bare torso, and NO suggestive or intimate framing. A neutral, non-sexual, " +
  "professional pre-production storyboard blocking sketch.";

const isModeration = (s) => /moderation_blocked|safety|content_policy|rejected/i.test(String(s));

// Returns base64 PNG. Auto-softens + retries once on a moderation block.
// `refs` = array of PNG byte buffers (style anchor, staging frame). With refs we hit the
// /v1/images/edits endpoint (multipart) so the model anchors to them; without, the plain
// text-to-image endpoint. The reference roles are explained in the prompt by the caller.
export async function generateImageB64(prompt, refs = []) {
  const hasRefs = Array.isArray(refs) && refs.length > 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    if (hasRefs) {
      const fd = new FormData();
      fd.append("model", IMAGE_MODEL);
      fd.append("prompt", prompt);
      fd.append("size", IMAGE_SIZE);
      fd.append("n", "1");
      refs.forEach((buf, i) => fd.append("image[]", new Blob([buf], { type: "image/png" }), `ref${i}.png`));
      res = await fetch(IMAGE_EDIT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, // let fetch set the multipart boundary
        body: fd,
      });
    } else {
      res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, n: 1 }),
      });
    }
    if (res.ok) {
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return b64;
      throw new Error("image API returned no data");
    }
    const errText = await res.text();
    if (attempt === 0 && isModeration(errText)) { prompt = prompt + SOFTEN_CLAUSE; continue; }
    throw new Error(`image ${res.status}: ${errText.slice(0, 240)}`);
  }
  throw new Error("image generation failed");
}

// ===================== QA (Claude vision) =====================
// The panel is graded against the shot card and, when present, a STYLE reference and a STAGING
// reference (the action/caption are the source of truth for intent, not the prompt).
export const QA_PROMPT = `You are a storyboard QA reviewer. You are shown a generated panel image and its shot card, and SOMETIMES a STYLE reference image and/or a STAGING reference image (the wide frame of this location). Return ONLY a JSON object: {"pass": boolean, "issues": [string], "fix": string}.
Checks (any failure => pass=false):
1. CHARACTERS: every character in the card is present; correct FULL-NAME labels in their assigned colours.
2. POSITIONS & FACING: left/right/depth and who-faces/approaches-whom match the action/caption intent (a figure walking toward the camera when they should engage others in-frame is a FAIL).
3. ACTION & FRAMING: the pose/action and shot type (close-up vs wide etc.) match the card.
4. STYLE: if a STYLE reference is provided, the panel must match ITS drawing medium and level of finish (linework, shading/none); if not, judge it as a rough black-and-white blocking sketch. The only colour should be the name labels.
5. CONTINUITY (apply ONLY when a STAGING reference is provided): the panel must share the SAME location and key props, and keep the characters' left-to-right order consistent with the staging frame (someone left of another in staging must not appear right of them here unless it is a deliberate reverse angle). Skip this check entirely if no staging reference is given.
"issues": short specific problems naming the check (empty if pass). "fix": one concrete correction to append to the prompt on regeneration (empty if pass).`;

function extractText(r) { return (r.content || []).map(b => b.text || "").join("").trim(); }

// refs = { styleB64, stagingB64 } — either/both optional.
export async function qaPanel(imageB64, shot, refs = {}) {
  const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } }];
  if (refs.styleB64) content.push(
    { type: "text", text: "STYLE reference (match this drawing style/medium only, ignore its subject):" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: refs.styleB64 } });
  if (refs.stagingB64) content.push(
    { type: "text", text: "STAGING reference (same location, props and character left-to-right order):" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: refs.stagingB64 } });
  content.push({ type: "text", text: "Shot card:\n" + JSON.stringify({ shot: shot.shot, type: shot.type, caption: shot.caption, action: shot.action, characters: shot.characters }) + "\n\nReturn ONLY the JSON object." });
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: QA_PROMPT, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`qa ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let t = extractText(await res.json()).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(a !== -1 && b > a ? t.slice(a, b + 1) : t);
}

// ===================== panel image storage (Netlify Blobs) =====================
export const panelStore = () => getStore("panels");
export const panelKey = (id, shot) => `${id}/${shot}`;
export async function savePanel(id, shot, b64) {
  await panelStore().set(panelKey(id, shot), Buffer.from(b64, "base64"), { metadata: { contentType: "image/png" } });
}
export async function readPanel(id, shot) {
  return panelStore().get(panelKey(id, shot), { type: "arrayBuffer" });
}

// ===================== style image storage (Netlify Blobs) =====================
// which: "cand_sketch" | "cand_ink" | "cand_grayscale" (the 3 candidates) or "ref" (the chosen one).
export const styleStore = () => getStore("styles");
export async function saveStyleImg(id, which, b64) {
  await styleStore().set(`${id}/${which}`, Buffer.from(b64, "base64"), { metadata: { contentType: "image/png" } });
}
export async function readStyleImg(id, which) {
  return styleStore().get(`${id}/${which}`, { type: "arrayBuffer" });
}

// ===================== slim, reference-aware prompt helpers =====================
// With a style ref + staging ref carrying the look and the location, the per-shot prompt should
// only state the delta. These strip the auto-appended style/label text and rebuild the labels.
export function coreBlocking(imagePrompt) {
  let t = String(imagePrompt || "");
  t = t.split("Character name-label colors for this panel:")[0]; // drop applyCharacterStyling's appended sentence
  t = t.split(STYLE_CLAUSE).join(" ");                            // drop any inlined house-style clause
  return t.replace(/\s+/g, " ").trim();
}
export function labelInstruction(characters, styles) {
  const chars = (characters || []).filter(Boolean);
  if (!chars.length) return "";
  const map = styles || {};
  const parts = chars.map(c => `'${String(c).toUpperCase()}' in ${map[c] || "a distinct colour"}`);
  return ` Write each visible character's FULL NAME as a small text label beside their figure: ${parts.join(", ")}. Those labels are the ONLY colour; every other line is black on white.`;
}
