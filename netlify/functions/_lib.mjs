// Shared backend helpers: Claude calls, the (ported) breakdown/editorial prompts,
// character styling, Blobs storage, and the password gate.
import { getStore } from "@netlify/blobs";

export const MODEL = "claude-sonnet-4-6";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";


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

// ---- production-asset detection: enrich the known characters/locations with a visual "look" and
// ---- pull out the KEY recurring story props (so we can build reference images for each) ----
export const ASSET_PROMPT = `You are a production designer. You are given a micro-drama script plus its already-detected CHARACTERS (with gender) and LOCATIONS (setup id + setting). Return ONLY a JSON object describing the assets to build reference images for:
{
 "characters": [{"name": "<EXACT given name>", "look": "<one concrete visual line: apparent age, build, skin/hair, and typical wardrobe, inferred from the script>"}],
 "locations": [{"id": "<EXACT given setup id>", "label": "<short human location name>", "desc": "<one concrete visual line: the look of the place, key features, time of day>"}],
 "props": [{"name": "<short>", "desc": "<one concrete visual line>"}]
}
Rules: keep EXACTLY the given character names and location ids (one object each). For "props", include ONLY the few KEY, recurring, story-significant objects (AT MOST 6) — never background clutter. No commentary, no markdown.`;

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

// The look is a fixed, photoreal full-colour cinematic frame (the style-picker feature was removed —
// gpt-image's native strength is photorealism, so we lean into it). This leads EVERY panel prompt.
export const CINEMATIC_LEAD =
  "A photorealistic, full-colour cinematic film still — realistic natural lighting, real human " +
  "figures with believable faces and clothing, real materials and textures, filmic colour, shallow " +
  "cinematic depth, as if a frame grabbed from a finished film.";

// asset id slug (stable key for a character / location / prop reference image)
export const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
// Reference-image prompts: clean, well-lit, neutral so they're reusable identity anchors.
export const charRefPrompt = (c) =>
  `A photorealistic character reference portrait of ${c.gender || "a person"}${c.look ? ", " + c.look : ""}. ` +
  `Neutral friendly expression, looking at camera, framed head to mid-torso, even soft studio lighting, plain light-grey background. Full colour, sharp, realistic skin and clothing. No text, no props, one person only.`;
export const locRefPrompt = (l) =>
  `A photorealistic establishing reference shot of ${l.label || l.id}${l.desc ? " — " + l.desc : ""}. ` +
  `Wide angle showing the whole space and its key features, natural lighting, full colour, realistic and detailed. NO people in the frame, no text.`;
export const propRefPrompt = (p) =>
  `A photorealistic reference shot of ${p.name}${p.desc ? " — " + p.desc : ""}. ` +
  `The single object centred on a plain neutral background, even lighting, full colour, realistic materials, product-photo clarity. No people, no text.`;

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
// The panel is graded against the shot card and, when present, a STAGING reference for continuity.
// There is NO style check — the look is a fixed photoreal cinematic frame. (action/caption are the
// source of truth for intent, not the prompt.)
export const QA_PROMPT = `You are a storyboard QA reviewer. You are shown a generated panel image (a photorealistic cinematic frame) and its shot card, and SOMETIMES a STAGING reference image (the wide frame of this location). Return ONLY a JSON object: {"pass": boolean, "issues": [string], "fix": string}.
Checks (any failure => pass=false):
1. CHARACTERS: every character named in the card is present, and each has a small readable name label in their assigned colour.
2. POSITIONS & FACING: left/right/depth and who-faces/approaches-whom match the action/caption intent (a figure walking toward the camera when they should engage others in-frame is a FAIL).
3. ACTION & FRAMING: the pose/action and shot type (close-up vs wide etc.) match the card.
4. CONTINUITY (apply ONLY when a STAGING reference is provided): the panel shares the SAME location and key props, and keeps the characters' left-to-right order consistent with the staging frame (someone left of another in staging must not appear right of them here unless it is a deliberate reverse angle). Skip this check entirely if no staging reference is given.
Do NOT judge art style or "realism" — the photoreal look is intended.
"issues": short specific problems naming the check (empty if pass). "fix": one concrete correction to append to the prompt on regeneration (empty if pass).`;

function extractText(r) { return (r.content || []).map(b => b.text || "").join("").trim(); }

// refs = { stagingB64 } — optional staging frame for the continuity check.
export async function qaPanel(imageB64, shot, refs = {}) {
  const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } }];
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

// ===================== asset reference storage (Netlify Blobs) =====================
// which = "char_<slug>" | "loc_<slug>" | "prop_<slug>"; an asset can hold MANY reference images
// (different angles), each addressed by a unique rid.
export const mkRid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const assetStore = () => getStore("assets");
const assetKey = (id, which, rid) => `${id}/${which}__${rid}`;
export async function saveAssetImg(id, which, rid, b64) {
  await assetStore().set(assetKey(id, which, rid), Buffer.from(b64, "base64"), { metadata: { contentType: "image/png" } });
}
export async function readAssetImg(id, which, rid) {
  return assetStore().get(assetKey(id, which, rid), { type: "arrayBuffer" });
}
export async function deleteAssetImg(id, which, rid) {
  try { await assetStore().delete(assetKey(id, which, rid)); } catch (_) {}
}

// ===================== prompt helpers =====================
// image_prompt now holds clean cinematic blocking; this just tidies any legacy text from old shots.
export function coreBlocking(imagePrompt) {
  return String(imagePrompt || "").split("Character name-label colors for this panel:")[0].replace(/\s+/g, " ").trim();
}
// Name labels overlaid on the photoreal frame, tied to the right FIGURE (by gender + position) so a
// NAME is only ever drawn label text — never the figure's identity. Reconciles with `characters`
// (editable in review): drops labels for removed characters, adds any extras.
export function labelInstruction(figures, characters, styles) {
  const map = styles || {};
  const names = (characters || []).filter(Boolean).map(String);
  const figs = (Array.isArray(figures) ? figures : []).filter(f => f && f.name && (!names.length || names.includes(String(f.name))));
  const parts = figs.map(f => {
    const who = [f.gender, f.pos && ("on the " + String(f.pos))].filter(Boolean).join(" ") || "figure";
    return `a small ${map[f.name] || "coloured"} text label reading '${String(f.name).toUpperCase()}' beside the ${who}`;
  });
  const covered = new Set(figs.map(f => String(f.name)));
  for (const c of names) if (!covered.has(c)) parts.push(`a small ${map[c] || "coloured"} text label reading '${c.toUpperCase()}'`);
  if (!parts.length) return "";
  return ` Overlay ${parts.join("; ")} — clean readable labels that do not cover faces.`;
}

// Maps a shot SIZE to a real lens + aperture — the cinematographer's "telephoto hack". For photoreal
// frames this is exactly right: 85mm+ flatters faces and throws the background into creamy bokeh.
export function lensFor(type) {
  const t = String(type || "").toUpperCase();
  if (/EXTREME CLOSE|\bECU\b/.test(t)) return "shot on a 100mm lens at f/1.8, ultra-shallow focus, only the eyes sharp";
  if (/MEDIUM CLOSE|\bMCU\b/.test(t)) return "shot on an 85mm portrait lens at f/2.8, shallow depth of field, background softly blurred";
  if (/CLOSE|\bCU\b|REACTION/.test(t)) return "shot on an 85mm portrait lens at f/2, shallow depth of field, creamy background bokeh, tack-sharp eyes";
  if (/INSERT|DETAIL|CUTAWAY/.test(t)) return "shot on a 100mm macro lens at f/4, tight on the detail, background melted into bokeh";
  if (/ESTABLISH|EXTREME WIDE|\bEWS\b/.test(t)) return "shot on a 24mm wide-angle lens, deep focus at f/8, the whole space sharp";
  if (/OVER-THE-SHOULDER|OVER THE SHOULDER|\bOTS\b/.test(t)) return "shot on an 85mm lens at f/2.8, the foreground shoulder soft, the facing figure sharp";
  if (/MEDIUM|TWO-SHOT|TWO SHOT|\bMS\b/.test(t)) return "shot on a 50mm lens at f/2.8, natural perspective, gentle background separation";
  if (/WIDE|FULL|TRACKING|DYNAMIC|\bPOV\b|\bWS\b|\bFS\b/.test(t)) return "shot on a 35mm lens at f/5.6, the figures full-length within the space";
  return "shot on a 50mm lens at f/2.8";
}

// One lighting anchor per setup (the setup's staging shot's mood), reused verbatim for continuity.
export function lightingAnchorFor(shots, shot) {
  if (shot && shot.setup) {
    const st = (shots || []).find(s => s.is_staging && s.setup === shot.setup);
    if (st && st.mood) return st.mood;
  }
  return (shot && shot.mood) || "";
}
