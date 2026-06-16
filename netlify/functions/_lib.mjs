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

// ---- breakdown system prompt: composes each shot like a cinematographer ----
export const BREAKDOWN_PROMPT = `You are a professional storyboard artist and cinematographer working on micro-drama (short-form vertical/landscape drama) productions. Break the script into a numbered sequence of storyboard shots, each COMPOSED like a real cinematographer (shot size, angle, depth, lighting continuity, the 180-degree rule).

KEEP IT FOCUSED: at most 30 shots; produce COMPLETE, valid JSON (never stop mid-object). Cover the script faithfully; a separate editorial pass adds coverage afterward.

Return ONLY a JSON array (no markdown fences, no commentary). Each element has these EXACT keys:
- "shot": integer, sequential from 1.
- "type": shot SIZE in capitals (e.g. "WIDE ESTABLISHING SHOT", "FULL SHOT", "MEDIUM SHOT", "MEDIUM CLOSE-UP", "CLOSE UP", "EXTREME CLOSE-UP", "INSERT", "OVER-THE-SHOULDER", "TWO-SHOT", "POV").
- "caption": 2-3 short present-tense lines, the way a storyboard description reads. Join lines with \\n.
- "characters": array of character NAMES visible in this shot (empty array if none).
- "figures": for EACH visible character, an object {"name","gender","pos"} where gender is exactly "man", "woman", or "person" (decide ONCE per character from the script and keep it IDENTICAL in every shot) and pos is a short position token: "far-left"|"left"|"centre"|"right"|"far-right", optionally with depth e.g. "left foreground" / "centre background". Empty array if no figures.
- "setting": brief location/environment.
- "setup": short lowercase id for the physical location/configuration (e.g. "startup_office"). EVERY shot in the same space shares the same setup id.
- "is_staging": boolean. For EACH distinct setup include exactly ONE wide establishing staging shot (is_staging:true) showing the whole space and ALL its characters in clear left-to-right positions plus key props; make it the FIRST shot of that setup. All others false.
- "mood": ONE sentence written as a LIGHTING ANCHOR - light DIRECTION + QUALITY (hard/soft, warm/cool) + PRACTICAL SOURCE (window/lamp/sun). Use the SAME lighting-anchor sentence for every shot sharing a setup (the staging shot defines it).
- "action": one sentence on what happens.
- "image_prompt": the cinematic composition in 2-4 sentences, following these RULES exactly:
   * Describe each visible figure by GENDER + POSITION + FACING - NEVER by name (the renderer cannot resolve names; names are only ever used for the drawn labels). E.g. "the woman stands far-left facing right toward the man; the man sits centre-right, angled left toward her."
   * 180-DEGREE RULE: if a figure is left of another they face right toward them, and vice-versa; keep facings consistent with the staging shot.
   * DEPTH: explicitly name what is in the FOREGROUND, MIDGROUND and BACKGROUND. Distant elements are hazier/lighter (atmospheric depth). When figures sit at different depths, state relative size (closer = larger in frame).
   * Give each figure a brief expression/posture.
   * Include a CAMERA ANGLE only if NOT eye-level (low angle, high angle, etc.).
   * Do NOT mention drawing style, medium, colour, line/shading, OR any camera lens - those are added automatically. Do NOT write character names or labels here.

Image-generation safety: depict romance/intimacy/violence tastefully and non-explicitly (poses, framing, spatial relationships - not literal kissing/embracing/gore).`;

// ---- editorial enrichment prompt (ported from shot_breakdown.py) ----
export const EDITORIAL_PROMPT = `You are a film editor enriching a faithful shot breakdown (given as a JSON array) into more engaging coverage WITHOUT changing the story.

Insert extra shots between existing ones where they strengthen the visual language: REACTION shots, INSERTS/CUTAWAYS (a hand, a prop, a detail), B-ROLL/establishing beats, and rhythm beats. Add with intent - a handful of well-placed additions per scene, not filler.

HARD RULES:
- KEEP every original shot (light caption polish only).
- Do NOT add new staging shots. Keep exactly the staging shots already marked "is_staging": true. Every added shot has "is_staging": false and reuses an EXISTING "setup" id from its neighbours.
- Use the EXACT same JSON keys as the existing shots ("shot","type","caption","characters","figures","setting","setup","is_staging","action","mood","image_prompt").
- For each added shot, set "figures" ({name,gender,pos}) with gender IDENTICAL to how that character appears elsewhere, and copy the neighbours' setup "mood" (lighting anchor) verbatim.
- Write each added shot's "image_prompt" by the SAME rules: describe figures by GENDER + POSITION + FACING (never by name), explicit FOREGROUND/MIDGROUND/BACKGROUND depth, camera angle only if not eye-level, and NO drawing-style/colour/lens/label text.
- Renumber "shot" sequentially from 1 in final viewing order.

Return ONLY the full enriched JSON array.`;

export const SCENE_PROMPT = `Read the script and return ONLY a JSON object {"scene": "<number or '01'>", "label": "<short location/scene label, or ''>"} describing the first/primary scene. No commentary.`;

const PALETTE = ["red", "blue", "green", "orange", "purple", "teal", "magenta", "brown", "olive", "navy"];

// Assigns a stable colour to each character name. The label instruction itself is built at
// generation time from each shot's `figures` (so labels are tied to the right figure by position).
export function applyCharacterStyling(shots) {
  const colorMap = {};
  for (const s of shots) for (const c of (s.characters || [])) if (!(c in colorMap)) colorMap[c] = PALETTE[Object.keys(colorMap).length % PALETTE.length];
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
// The explicit words for a chosen preset style ("" for uploads/unknown) — fed into every panel so the
// model is TOLD the look, not left to infer it from the reference image alone (which it under-uses).
export const styleClauseFor = (choice) => (STYLE_CANDIDATES.find((c) => c.id === choice)?.clause) || "";

// Appended on a content-moderation block (clothes the faceless figures so they don't read as nude).
export const SOFTEN_CLAUSE =
  " All figures must be fully clothed in simple, plain, loosely-sketched clothing, with NO bare " +
  "skin, NO bare torso, and NO suggestive or intimate framing. A neutral, non-sexual, " +
  "professional pre-production storyboard blocking sketch.";

const isModeration = (s) => /moderation_blocked|safety|content_policy|rejected/i.test(String(s));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns base64 PNG. `refs` = array of PNG byte buffers (style anchor, staging frame). With refs we
// hit the /v1/images/edits endpoint (multipart) so the model anchors to them; without, the plain
// text-to-image endpoint. Auto-softens once on a moderation block, and retries transient upstream
// failures (5xx / 429 / connection resets — the "image 503: upstream connect error" the user saw)
// with backoff so one OpenAI hiccup doesn't fail the panel.
export async function generateImageB64(prompt, refs = []) {
  const hasRefs = Array.isArray(refs) && refs.length > 0;
  let softened = false;
  const MAX = 5;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let res;
    try {
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
    } catch (e) {
      if (attempt < MAX) { await sleep(1200 * attempt); continue; }  // network/connection reset
      throw new Error("image network error: " + String(e).slice(0, 150));
    }
    if (res.ok) {
      const data = await res.json();
      const b64 = data?.data?.[0]?.b64_json;
      if (b64) return b64;
      throw new Error("image API returned no data");
    }
    const errText = await res.text();
    if (!softened && isModeration(errText)) { prompt += SOFTEN_CLAUSE; softened = true; continue; } // clothe + retry
    if ((res.status >= 500 || res.status === 429) && attempt < MAX) { await sleep(1200 * attempt); continue; } // transient
    throw new Error(`image ${res.status}: ${errText.slice(0, 240)}`);
  }
  throw new Error("image generation failed after retries");
}

// ===================== QA (Claude vision) =====================
// The panel is graded against the shot card and, when present, a STYLE reference and a STAGING
// reference (the action/caption are the source of truth for intent, not the prompt).
export const QA_PROMPT = `You are a storyboard QA reviewer. You are shown a generated panel image and its shot card, and SOMETIMES a STYLE reference image and/or a STAGING reference image (the wide frame of this location). Return ONLY a JSON object: {"pass": boolean, "issues": [string], "fix": string}.
Checks (any failure => pass=false):
1. CHARACTERS: every character in the card is present; correct FULL-NAME labels in their assigned colours.
2. POSITIONS & FACING: left/right/depth and who-faces/approaches-whom match the action/caption intent (a figure walking toward the camera when they should engage others in-frame is a FAIL).
3. ACTION & FRAMING: the pose/action and shot type (close-up vs wide etc.) match the card.
4. STYLE: assess style ONLY if a STYLE reference image is provided — then the panel must match ITS drawing medium and level of finish (e.g. flat clean linework vs. soft grayscale shading). If NO style reference is provided, SKIP the style check entirely — do NOT assume any particular style and do NOT flag for shading/finish. The only colour anywhere should be the character name labels.
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
// Builds the label instruction tied to the right FIGURE (by gender + position), so a NAME is only
// ever used as drawn label text — never as the figure's identity. Reconciles with `characters`
// (which the user can edit in review): drops labels for removed characters, adds any extras.
export function labelInstruction(figures, characters, styles) {
  const map = styles || {};
  const names = (characters || []).filter(Boolean).map(String);
  const figs = (Array.isArray(figures) ? figures : []).filter(f => f && f.name && (!names.length || names.includes(String(f.name))));
  const parts = figs.map(f => {
    const who = [f.gender, f.pos && ("on the " + String(f.pos))].filter(Boolean).join(" ") || "figure";
    return `label the ${who} '${String(f.name).toUpperCase()}' in ${map[f.name] || "a distinct colour"}`;
  });
  const covered = new Set(figs.map(f => String(f.name)));
  for (const c of names) if (!covered.has(c)) parts.push(`label '${c.toUpperCase()}' in ${map[c] || "a distinct colour"}`);
  if (!parts.length) return "";
  return ` Name labels are the ONLY colour in the frame (every other line follows the style reference): ${parts.join("; ")}.`;
}

// Maps a shot SIZE to a real lens + aperture (the "telephoto hack" — without this gpt-image defaults
// to a ~35mm wide look that distorts faces and over-sharpens backgrounds).
export function lensFor(type) {
  const t = String(type || "").toUpperCase();
  if (/EXTREME CLOSE|\bECU\b/.test(t)) return "Shot on a 100mm lens, f/1.8, ultra-shallow depth of field, only the subject sharp";
  if (/MEDIUM CLOSE|\bMCU\b/.test(t)) return "Shot on an 85mm portrait lens, f/2.8, shallow depth of field, background softly blurred";
  if (/CLOSE|\bCU\b|REACTION/.test(t)) return "Shot on an 85mm portrait lens, f/2.8, shallow depth of field, background softly blurred";
  if (/INSERT|DETAIL|CUTAWAY/.test(t)) return "Shot on a 100mm macro lens, f/4, close focus on the detail, background soft";
  if (/ESTABLISH|EXTREME WIDE|\bEWS\b/.test(t)) return "Shot on a 24mm wide-angle lens, deep focus, f/8, everything sharp";
  if (/OVER-THE-SHOULDER|OVER THE SHOULDER|\bOTS\b/.test(t)) return "Shot on an 85mm lens, f/2.8, foreground shoulder soft, subject sharp";
  if (/MEDIUM|TWO-SHOT|TWO SHOT|\bMS\b/.test(t)) return "Shot on a 50mm lens, f/2.8, shallow depth of field";
  if (/WIDE|FULL|TRACKING|DYNAMIC|\bPOV\b|\bWS\b|\bFS\b/.test(t)) return "Shot on a 35mm lens, f/5.6, moderate depth of field";
  return "Shot on a 50mm lens, f/2.8";
}

// One lighting anchor per setup (the setup's staging shot's mood), reused verbatim for continuity.
export function lightingAnchorFor(shots, shot) {
  if (shot && shot.setup) {
    const st = (shots || []).find(s => s.is_staging && s.setup === shot.setup);
    if (st && st.mood) return st.mood;
  }
  return (shot && shot.mood) || "";
}
