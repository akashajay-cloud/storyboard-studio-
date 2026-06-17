// Storyboard Studio — frontend. DEMO mode (file:// or localhost) simulates the backend so every
// screen is fully clickable; on Netlify it calls /api/* instead.

const DEMO = location.protocol === "file:" || location.hostname === "localhost";
const STEPS = ["upload", "analyzing", "review", "staging", "generate", "board"];
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  step: "projects",
  file: null,
  current: null,          // active project
  projects: [],
  unlocked: 0,            // furthest step index the user may navigate to (gates skipping ahead)
  soundOn: localStorage.getItem("sb_sound") !== "0",
  lb: { list: [], i: 0 },
};

/* ============================ sounds (Web Audio, no files) ============================ */
let actx;
function tone(freqs, dur = 0.13, type = "sine", gain = 0.07) {
  if (!state.soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    let t = actx.currentTime;
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      const st = t + i * dur;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(gain, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
      o.start(st); o.stop(st + dur);
    });
  } catch (e) {}
}
const SOUNDS = {
  ready: () => tone([660, 880]),                          // shotlist ready
  done: () => tone([523, 659, 784], 0.15),                // all generations done
  error: () => tone([220, 165], 0.26, "square", 0.06),    // timeout / failure
  tick: () => tone([880], 0.05, "sine", 0.025),           // per-panel pass (soft)
};
const play = n => SOUNDS[n] && SOUNDS[n]();

const soundBtn = $("#soundToggle");
function renderSound() {
  $(".ic-on", soundBtn).classList.toggle("hidden", !state.soundOn);
  $(".ic-off", soundBtn).classList.toggle("hidden", state.soundOn);
  soundBtn.classList.toggle("muted-state", !state.soundOn);
}
soundBtn.addEventListener("click", () => {
  state.soundOn = !state.soundOn;
  localStorage.setItem("sb_sound", state.soundOn ? "1" : "0");
  renderSound();
  if (state.soundOn) play("ready");
});
renderSound();

/* ============================ navigation ============================ */
function go(step) {
  state.step = step;
  $$(".screen").forEach(s => s.classList.toggle("active", s.dataset.screen === step));
  // stepper only appears once we're past the script upload (from the shotlist onward)
  $("#stepper").style.visibility = ["review", "staging", "generate", "board"].includes(step) ? "visible" : "hidden";
  const idx = STEPS.indexOf(step);
  $$(".step").forEach(b => {
    const i = STEPS.indexOf(b.dataset.step);
    b.classList.toggle("current", i === idx);
    b.classList.toggle("done", i > -1 && i < idx);
    b.classList.toggle("locked", i > state.unlocked);   // can't jump ahead to an unfinished step
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
// Steps unlock only as their prerequisite finishes, so you can't reach (e.g.) Generate before the
// staging frames exist. `unlockStep` only ever moves forward; `resetUnlock` sets it (new project).
function applyStepLocks() {
  $$(".step").forEach(b => b.classList.toggle("locked", STEPS.indexOf(b.dataset.step) > state.unlocked));
}
function unlockStep(step) { state.unlocked = Math.max(state.unlocked, STEPS.indexOf(step)); applyStepLocks(); }
function resetUnlock(step) { state.unlocked = STEPS.indexOf(step); applyStepLocks(); }
$$(".step").forEach(b => b.addEventListener("click", () => {
  if (state.step === "projects") return;
  if (STEPS.indexOf(b.dataset.step) > state.unlocked) return;   // locked — finish the current step first
  go(b.dataset.step);
}));
$$("[data-goto]").forEach(b => b.addEventListener("click", () => go(b.dataset.goto)));
// Home = the script/upload screen (a fresh new project). "My Projects" opens the saved-projects grid.
$("#brandHome").addEventListener("click", () => newProject());
$("#myProjectsBtn")?.addEventListener("click", () => { renderProjects(); go("projects"); });
$("#newProjectBtn")?.addEventListener("click", () => newProject());

/* ============================ projects ============================ */
function loadProjects() {
  try { state.projects = JSON.parse(localStorage.getItem("sb_projects") || "[]"); }
  catch { state.projects = []; }
  if (DEMO && state.projects.length === 0) state.projects = demoProjects();
}
function saveProjects() {
  // keep storage light: don't persist big data-URL images in demo
  const slim = state.projects.map(p => ({ ...p, _imgs: undefined }));
  try { localStorage.setItem("sb_projects", JSON.stringify(slim)); } catch (e) {}
}
const STATUS_META = {
  ready:   { cls: "ready",   icon: "✓", label: "Shot list ready" },
  working: { cls: "stopped", icon: "⏸", label: "Stopped" },
  stopped: { cls: "stopped", icon: "⏸", label: "Stopped" },
  error:   { cls: "error",   icon: "⚠", label: "Error" },
  done:    { cls: "done",    icon: "✓", label: "Storyboard ready" },
};
function renderProjects() {
  loadProjects();
  const cards = state.projects.map(p => {
    const m = STATUS_META[p.status] || STATUS_META.ready;
    const total = p.panelsTotal || p.shotCount || 0, done = p.panelsDone || 0;
    const pct = total ? Math.round(done / total * 100) : 0;
    const showBar = p.status !== "error";
    return `<div class="pcard" data-id="${p.id}">
      <div class="kebab-wrap">
        <button class="kebab" title="Options">⋮</button>
        <div class="pmenu hidden">
          <button class="pm-rename">Rename</button>
          <button class="pm-delete">Delete</button>
        </div>
      </div>
      <p class="pname">${esc(p.name)}</p>
      ${p.location ? `<p class="ploc">${esc(p.location)}</p>` : ""}
      <p class="pstatus-line ${m.cls}">${m.icon} ${m.label}</p>
      ${showBar ? `<div class="ppanels"><span>${done}/${total} panels</span><span>${pct}%</span></div>
        <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>` : ""}
      <div class="pfoot"><span>🕐 ${esc(p.date || "")}</span><span class="open">Open →</span></div>
    </div>`;
  }).join("");
  $("#projectGrid").innerHTML = `<div class="pcard new" id="newCard"><div class="plus">＋</div><div>New project</div></div>` + cards;
  $("#newCard").addEventListener("click", newProject);
  $$("#projectGrid .pcard[data-id]").forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("click", () => openProject(id));
    const menu = card.querySelector(".pmenu");
    card.querySelector(".kebab").addEventListener("click", e => {
      e.stopPropagation();
      $$("#projectGrid .pmenu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
      menu.classList.toggle("hidden");
    });
    card.querySelector(".pm-rename").addEventListener("click", e => {
      e.stopPropagation(); menu.classList.add("hidden");
      const p = state.projects.find(x => x.id === id); if (!p) return;
      const name = prompt("Rename project", p.name);
      if (name && name.trim()) { p.name = name.trim(); saveProjects(); renderProjects(); }
    });
    card.querySelector(".pm-delete").addEventListener("click", e => {
      e.stopPropagation(); menu.classList.add("hidden");
      const p = state.projects.find(x => x.id === id); if (!p) return;
      if (confirm(`Delete “${p.name}”? This can't be undone.`)) {
        state.projects = state.projects.filter(x => x.id !== id);
        saveProjects(); renderProjects();
      }
    });
  });
}
// close any open card menu when clicking elsewhere
document.addEventListener("click", e => {
  if (!e.target.closest(".kebab-wrap")) $$("#projectGrid .pmenu").forEach(m => m.classList.add("hidden"));
});
function newProject() { state.current = null; state.file = null; resetUpload(); resetUnlock("upload"); go("upload"); }
function openProject(id) {
  const p = state.projects.find(x => x.id === id); if (!p) return;
  state.current = p;
  state.shots = p.shots || demoShots();
  state.allChars = unionChars(state.shots);
  resetUnlock(p.status === "done" ? "board" : "staging");   // finished projects open fully; others re-walk staging/generate
  if (p.status === "done") { buildBoard(true); }
  else { renderShots(); go("review"); }
}

/* ============================ upload ============================ */
const dz = $("#dropzone"), fileInput = $("#fileInput");
function resetUpload() {
  $(".dz-inner").classList.remove("hidden"); $("#dzFile").classList.add("hidden");
  $("#projectName").value = ""; state.file = null;
}
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
function setFile(f) {
  state.file = f;
  $("#dzFile").innerHTML = `<span class="pill gen">${f.name.split(".").pop().toUpperCase()}</span> ${esc(f.name)}`;
  $("#dzFile").classList.remove("hidden"); $(".dz-inner").classList.add("hidden");
}

// Script / Shortlist tabs
state.uploadMode = "script";
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.remove("active")); t.classList.add("active");
  state.uploadMode = t.dataset.tab;
  const shortlist = state.uploadMode === "shortlist";
  $("#uploadNote").textContent = shortlist
    ? "Import your existing shot list — we structure it and skip straight to drawing."
    : "We analyze the screenplay, build a shot list, then draw each panel.";
  $(".dz-text strong").textContent = shortlist ? "Drop your shot list here" : "Drop your script here";
  $(".dz-text span").textContent = shortlist ? "CSV, XLSX, PDF, DOCX, or TXT — up to 15 MB" : "PDF, DOCX, or TXT — up to 15 MB";
}));

// Title-case a filename-derived name ("test-oneshot" -> "Test-Oneshot"), keeping separators.
const prettifyName = s => String(s || "").replace(/\b\w/g, c => c.toUpperCase());
$("#startBtn").addEventListener("click", async () => {
  const name = $("#projectName").value.trim() || (state.file ? prettifyName(state.file.name.replace(/\.[^.]+$/, "")) : "Untitled");
  if (!state.file && !DEMO) { dz.classList.add("drag"); setTimeout(() => dz.classList.remove("drag"), 600); return; }
  state.current = { id: "p" + Date.now(), name, scene: "01", format: "9:16", location: "",
                    status: "working", date: "just now", panelsDone: 0, panelsTotal: 0 };
  state.projects.unshift(state.current); saveProjects();
  resetUnlock("upload");                        // new run: re-gate everything ahead
  go("analyzing");
  state.shots = await runBreakdown();           // streams into the split screen
  state.allChars = unionChars(state.shots);
  state.current.shots = state.shots; state.current.shotCount = state.shots.length; saveProjects();
  renderShots();
  if (state.shots.length) unlockStep("staging");  // shot list ready -> Review + Staging reachable
  play("ready");
  go("review");
});

/* ============================ breakdown (split-screen) ============================ */
const STAGE_ORDER = ["reading", "breakdown", "editorial", "styling"];

async function runBreakdown() {
  const steps = $$("#analyzeSteps li");
  $("#analyzerDoc").innerHTML = Array.from({ length: 9 }, () => `<span style="width:${50 + Math.random() * 45}%"></span>`).join("");
  $("#liveShotlist").innerHTML = ""; $("#liveCount").textContent = "analyzing…";

  // Each step is GREEN only once its stage actually completes (driven by real backend status).
  const setStage = (stage) => {
    const idx = STAGE_ORDER.indexOf(stage);
    steps.forEach((s, j) => { s.classList.toggle("done", idx >= 0 && j < idx); s.classList.toggle("active", j === idx); });
  };
  const allDone = () => steps.forEach(s => { s.classList.add("done"); s.classList.remove("active"); });
  steps.forEach(s => s.classList.remove("done", "active"));

  // elapsed timer so the wait feels alive (and people don't restart mid-run)
  const t0 = Date.now();
  $("#analyzeTimer").textContent = "0:00 · usually 1–2 min";
  const timer = setInterval(() => { $("#analyzeTimer").textContent = `${fmtClock((Date.now() - t0) / 1000)} · usually 1–2 min`; }, 1000);

  let shots;
  if (DEMO) {
    for (const stg of STAGE_ORDER) { setStage(stg); await tick(750); }   // simulate stages
    shots = demoShots();
  } else {
    shots = await apiBreakdown(setStage);    // real: each poll updates the stage
  }

  clearInterval(timer);
  allDone();
  $("#liveCount").textContent = "building…";

  // stream the shotlist appearing
  for (let k = 0; k < shots.length; k++) {
    const s = shots[k];
    $("#liveShotlist").insertAdjacentHTML("beforeend",
      `<div class="live-row"><span class="num">#${s.shot}</span>
        <div><div class="lr-type">${esc(s.type)}${s.is_staging ? " · staging" : ""}</div>
        <div class="lr-body">${esc(s.caption || "")}</div></div></div>`);
    $("#liveCount").textContent = `${k + 1} shots`;
    $("#liveShotlist").scrollTop = $("#liveShotlist").scrollHeight;
    await tick(DEMO ? 280 : 40);
  }
  await tick(400);
  return shots;
}

/* ============================ review shot list ============================ */
const PALETTE = ["#e0524f", "#4f8fe0", "#3fae6a", "#e8a23f", "#9b6ad8", "#3fb8a9", "#d85fb0", "#a9744f", "#9aa83f", "#3f5fae"];
const initial = n => (n || "?").trim().charAt(0).toUpperCase();
const unionChars = shots => { const o = []; shots.forEach(s => (s.characters || []).forEach(c => { if (!o.includes(c)) o.push(c); })); return o; };
function charColor(name) {
  const i = (state.allChars || []).indexOf(name);
  return PALETTE[(i < 0 ? (state.allChars || []).length : i) % PALETTE.length];
}
const dot = n => `<span class="char-dot" style="background:${charColor(n)}">${initial(n)}</span>`;
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function renderShots() {
  if (!state.allChars) state.allChars = unionChars(state.shots);
  state.shots.forEach(s => (s.characters || []).forEach(c => { if (!state.allChars.includes(c)) state.allChars.push(c); }));

  $("#reviewTitle").textContent = state.current?.name || "Project";
  $("#reviewMetaLine").innerHTML =
    `Scene ${esc(state.current?.scene || "01")} <span class="dot">·</span> ${state.shots.length} shots ` +
    `<span class="dot">·</span> ${state.allChars.length} characters`;
  renderLegend();

  $("#shotGrid").innerHTML = state.shots.map((s, i) => `
    <div class="shotcard2" data-i="${i}">
      <div class="sc-top">
        <span class="movebtns"><button class="mv up" title="Move up">↑</button><button class="mv down" title="Move down">↓</button></span>
        <span class="num">${String(s.shot).padStart(2, "0")}</span>
        <div class="sc-type"><label>Shot type</label><input class="type-input" data-f="type" value="${esc(s.type)}"></div>
        <button class="ins" title="Insert a shot below">＋ Insert below</button>
        <button class="del" title="Delete shot">${TRASH}</button>
      </div>
      <div class="sc-grid">
        <div class="fieldblock"><label>Scene description</label><textarea data-f="caption" rows="3">${esc(s.caption || "")}</textarea></div>
        <div class="fieldblock"><label>Action</label><textarea data-f="action" rows="3">${esc(s.action || "")}</textarea></div>
        <div class="fieldblock"><label>Setting</label><input data-f="setting" value="${esc(s.setting || "")}"></div>
        <div class="fieldblock"><label>Mood</label><input data-f="mood" value="${esc(s.mood || "")}"></div>
      </div>
      <div class="sc-chars"><label>Characters in shot</label>
        <div class="chiprow">
          ${(s.characters || []).map(c => `<span class="mini-chip">${dot(c)}${esc(c)}<span class="x" data-c="${esc(c)}">✕</span></span>`).join("")}
          <input class="addchar" placeholder="Add…">
        </div>
      </div>
      <details class="imgprompt"><summary>Image prompt (advanced)</summary>
        <textarea data-f="image_prompt" rows="3">${esc(s.image_prompt || "")}</textarea></details>
    </div>`).join("");
}

function renderLegend() {
  $("#legendChips").innerHTML = (state.allChars || []).map(c =>
    `<span class="char-chip">${dot(c)}${esc(c)}<span class="x" data-c="${esc(c)}">✕</span></span>`).join("");
  $$("#legendChips .x").forEach(x => x.addEventListener("click", () => {
    const c = x.dataset.c;
    state.allChars = state.allChars.filter(n => n !== c);
    state.shots.forEach(s => s.characters = (s.characters || []).filter(n => n !== c));
    renderShots(); markDirty();
  }));
}

function markDirty() {
  $("#saveState").textContent = "Unsaved changes…";
  if (state.current) { state.current.shots = state.shots; state.current.shotCount = state.shots.length; }
}
function saveNow() { if (state.current) { state.current.shots = state.shots; saveProjects(); } $("#saveState").textContent = "All changes saved."; }

// --- delegated editing on the shot list ---
const grid = $("#shotGrid");
grid.addEventListener("input", e => {
  const f = e.target.dataset.f; if (!f) return;
  const i = +e.target.closest(".shotcard2").dataset.i;
  state.shots[i][f] = e.target.value; markDirty();
});
const blankShot = (setup) => ({ shot: 0, type: "MEDIUM SHOT", caption: "", action: "",
  setting: "", mood: "", characters: [], image_prompt: "", setup: setup || "scene", is_staging: false });
const renumber = () => state.shots.forEach((s, k) => { s.shot = k + 1; });

grid.addEventListener("click", e => {
  const card = e.target.closest(".shotcard2"); if (!card) return;
  const i = +card.dataset.i;
  if (e.target.closest(".del")) {
    state.shots.splice(i, 1); renumber(); renderShots(); markDirty(); return;
  }
  if (e.target.closest(".mv.up")) {
    if (i > 0) { [state.shots[i - 1], state.shots[i]] = [state.shots[i], state.shots[i - 1]]; renumber(); renderShots(); markDirty(); }
    return;
  }
  if (e.target.closest(".mv.down")) {
    if (i < state.shots.length - 1) { [state.shots[i + 1], state.shots[i]] = [state.shots[i], state.shots[i + 1]]; renumber(); renderShots(); markDirty(); }
    return;
  }
  if (e.target.closest(".ins")) {
    state.shots.splice(i + 1, 0, blankShot(state.shots[i]?.setup)); renumber(); renderShots(); markDirty(); return;
  }
  const x = e.target.closest(".mini-chip .x");
  if (x) {
    const i = +x.closest(".shotcard2").dataset.i, c = x.dataset.c;
    state.shots[i].characters = (state.shots[i].characters || []).filter(n => n !== c);
    renderShots(); markDirty();
  }
});
grid.addEventListener("keydown", e => {
  if (e.target.classList.contains("addchar") && e.key === "Enter") {
    e.preventDefault();
    const i = +e.target.closest(".shotcard2").dataset.i, v = e.target.value.trim();
    if (!v) return;
    state.shots[i].characters = state.shots[i].characters || [];
    if (!state.shots[i].characters.includes(v)) state.shots[i].characters.push(v);
    if (!state.allChars.includes(v)) state.allChars.push(v);
    renderShots(); markDirty();
  }
});

$("#charAddBtn").addEventListener("click", () => {
  const v = $("#charInput").value.trim(); if (!v) return;
  if (!state.allChars.includes(v)) state.allChars.push(v);
  $("#charInput").value = ""; renderLegend(); markDirty();
});
$("#charInput").addEventListener("keydown", e => { if (e.key === "Enter") $("#charAddBtn").click(); });
$("#addShotBtn").addEventListener("click", () => {
  state.shots.push({ shot: state.shots.length + 1, type: "MEDIUM SHOT", caption: "", action: "",
    setting: "", mood: "", characters: [], image_prompt: "", setup: state.shots[0]?.setup || "scene", is_staging: false });
  renderShots(); markDirty();
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
});
$("#saveShots").addEventListener("click", saveNow);
$("#toStaging").addEventListener("click", async () => { saveNow(); unlockStep("staging"); go("staging"); await renderStaging(); });

/* ============================ staging (edit / regenerate / upload) ============================ */
const sp = shot => $(`.spanel[data-shot="${shot}"]`);
function spanelHTML(s) {
  const img = s._img;
  return `<div class="spanel" data-shot="${s.shot}">
    <div class="simg ${img ? "" : "empty"}" ${img ? `style="background-image:url('${img}')"` : ""} data-state="${img ? "" : "drawing…"}"></div>
    <div class="smeta">#${s.shot} · ${esc(s.type)} · staging</div>
    <div class="sactions">
      <button class="sbtn regen">↻ Regenerate</button>
      <button class="sbtn edit">✎ Edit</button>
      <button class="sbtn del" title="Delete this frame so you can upload your own or regenerate">🗑 Delete</button>
    </div>
    <div class="seditor hidden">
      <label>Staging description — edit, then regenerate</label>
      <textarea rows="3">${esc(s.image_prompt || s.caption || "")}</textarea>
      <button class="sbtn primary applyedit">↻ Regenerate with changes</button>
    </div>
  </div>`;
}
function setStagingImg(shot, img) {
  const p = sp(shot); if (!p) return;
  stopCountdown("s" + shot);
  const im = p.querySelector(".simg"); im.classList.remove("empty", "loading"); im.dataset.state = ""; im.style.backgroundImage = `url('${img}')`;
}
function startStagingLoad(shot, label) {
  const p = sp(shot); if (!p) return;
  const im = p.querySelector(".simg"); im.classList.add("empty"); im.style.backgroundImage = "";
  startCountdown("s" + shot, im, DEMO ? 4 : 75, label);   // shimmer + estimated-time countdown
}
function setStagingQueued(shot) {
  const p = sp(shot); if (!p) return;
  stopCountdown("s" + shot);
  const im = p.querySelector(".simg"); im.classList.add("empty"); im.classList.remove("loading"); im.style.backgroundImage = ""; im.dataset.state = "Queued";
}
function setStagingPending(shot, text) {   // honest live placeholder
  const p = sp(shot); if (!p) return;
  stopCountdown("s" + shot);
  const im = p.querySelector(".simg"); im.classList.add("empty"); im.classList.remove("loading"); im.style.backgroundImage = ""; im.dataset.state = text;
}
function clearStaging(shot) {               // delete the frame so the user can upload their own / regenerate
  const s = state.shots.find(x => x.shot === shot); if (s) s._img = null;
  setStagingPending(shot, "Deleted — upload your own or regenerate");
  play("tick");
}
function regenStaging(shot) {
  const s = state.shots.find(x => x.shot === shot);
  startStagingLoad(shot, "Redrawing");
  if (DEMO) { setTimeout(() => { s._img = demoImg(shot); setStagingImg(shot, s._img); play("tick"); }, 1600); return; }
  genPanelReal(shot, {}, stage => { if (stage === "qa") startCountdown("s" + shot, sp(shot)?.querySelector(".simg"), 25, "QA"); }).then(r => {
    if (r.status === "error") return setStagingPending(shot, "Error — retry");
    s._img = panelURL(shot); setStagingImg(shot, s._img); play("tick");
  });
}
async function generateOneStaging(s) {
  startStagingLoad(s.shot, "Drawing");                 // shimmer + ETA on THIS panel only
  if (DEMO) { await tick(1500 + Math.random() * 900); s._img = demoImg(s.shot); setStagingImg(s.shot, s._img); play("tick"); return; }
  const r = await genPanelReal(s.shot, {}, stage => { if (stage === "qa") startCountdown("s" + s.shot, sp(s.shot)?.querySelector(".simg"), 25, "QA"); });
  if (r.status === "error") return setStagingPending(s.shot, "Error — retry");
  s._img = panelURL(s.shot); setStagingImg(s.shot, s._img); play("tick");
}
async function renderStaging() {
  // Generate is locked until every staging frame exists — derived panels must anchor to them.
  const gbtn = $("#toGenerate");
  if (gbtn) { gbtn.disabled = true; gbtn.title = "Drawing the staging frames first…"; }
  const staging = state.shots.filter(s => s.is_staging);
  $("#stagingBoard").innerHTML = staging.map(spanelHTML).join("");
  setupStagingUpload(staging);                          // the separate drop-area below the panels
  const pending = staging.filter(s => !s._img);
  pending.forEach(s => setStagingQueued(s.shot));      // everything starts as "Queued"
  await runQueue(pending, 2, generateOneStaging);      // 2 at a time; next starts as one finishes
  if (gbtn) { gbtn.disabled = false; gbtn.title = ""; } // all staging frames ready
  unlockStep("generate");
}
// Separate upload drop-area (below the panels): drop/pick your own frame to replace a location's
// staging reference. Persists server-side via /api/upload-panel so derived shots anchor to it.
function setupStagingUpload(staging) {
  const wrap = $("#stagingUpload"); if (!wrap) return;
  wrap.classList.toggle("hidden", staging.length === 0);
  const sel = $("#suTarget");
  sel.innerHTML = staging.map(s => `<option value="${s.shot}">#${s.shot} · ${esc(s.setting || s.type)}</option>`).join("");
  $("#suTargetWrap").classList.toggle("hidden", staging.length <= 1);
}
async function applyStagingUpload(file) {
  if (!file) return;
  const shot = +($("#suTarget")?.value) || (state.shots.find(s => s.is_staging)?.shot);
  const s = state.shots.find(x => x.shot === shot); if (!s) return;
  if (DEMO) { const r = new FileReader(); r.onload = () => { s._img = r.result; setStagingImg(shot, s._img); play("tick"); }; r.readAsDataURL(file); return; }
  startStagingLoad(shot, "Uploading");
  const fd = new FormData(); fd.append("id", state.current.id); fd.append("shot", String(shot)); fd.append("image", file);
  try { await fetch("/api/upload-panel", { method: "POST", headers: apiHeaders(), body: fd }); } catch (_) {}
  s._img = panelURL(shot); setStagingImg(shot, s._img); play("tick");
}
(() => {
  const drop = $("#suDrop"), file = $("#suFile"); if (!drop || !file) return;
  file.addEventListener("change", () => { if (file.files[0]) { applyStagingUpload(file.files[0]); file.value = ""; } });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("drag"); if (e.dataTransfer.files[0]) applyStagingUpload(e.dataTransfer.files[0]); });
})();
const sboard = $("#stagingBoard");
sboard.addEventListener("click", e => {
  const card = e.target.closest(".spanel"); if (!card) return;
  const shot = +card.dataset.shot;
  if (e.target.closest(".regen")) return regenStaging(shot);
  if (e.target.closest(".del")) return clearStaging(shot);
  if (e.target.closest(".edit")) return card.querySelector(".seditor").classList.toggle("hidden");
  if (e.target.closest(".applyedit")) {
    state.shots.find(x => x.shot === shot).image_prompt = card.querySelector(".seditor textarea").value;
    card.querySelector(".seditor").classList.add("hidden"); return regenStaging(shot);
  }
  const im = e.target.closest(".simg");
  if (im && !im.classList.contains("empty")) { const s = state.shots.find(x => x.shot === shot); if (s._img) openLightbox([s._img], 0); }
});
$("#toGenerate").addEventListener("click", () => { if ($("#toGenerate").disabled) return; go("generate"); runGeneration(); });

/* ============================ drawing panels (status card + QA pills) ============================ */
const gp = shot => $(`.gpanel[data-shot="${shot}"]`);
function gpanelHTML(s) {
  return `<div class="gpanel" data-shot="${s.shot}">
    <div class="gimg empty" data-state="${s.is_staging ? "" : "queued"}"><span class="gnum">${String(s.shot).padStart(2, "0")}</span></div>
    <div class="gmeta"><span class="gtype">${esc(s.type)}</span><span class="gright"></span></div>
    <div class="gactions">
      <button class="gact dl" title="Download this panel">⬇ Download</button>
      <button class="gact retry" title="Redraw with the same prompt">↻ Retry</button>
      <button class="gact editbtn">✎ Edit</button>
      <button class="gact approve hidden" title="Keep this shot even though QA flagged it">✓ Approve anyway</button>
    </div>
    <div class="geditor hidden">
      <label>Edit the prompt and/or add feedback, then regenerate</label>
      <textarea class="gprompt" rows="3">${esc(s.image_prompt || "")}</textarea>
      <input class="gfeedback" placeholder="Feedback — e.g. “Carter faces left, looser linework, no shading”" />
      <button class="gact primary regenfb">↻ Regenerate with changes</button>
    </div></div>`;
}
function setGenState(shot, st) { const p = gp(shot); if (p) p.querySelector(".gimg").dataset.state = st; }
function setGenPill(shot, cls, text) {
  const p = gp(shot); if (!p) return;
  if (cls !== "flagged") p.classList.remove("fail");
  p.querySelector(".gright").innerHTML = `<span class="pill ${cls}">${text}</span>`;
}
function setGenImg(shot, img) {
  const p = gp(shot); if (!p || !img) return;
  const im = p.querySelector(".gimg"); im.classList.remove("empty"); im.style.backgroundImage = `url('${img}')`;
  im.onclick = () => { const imgs = state.shots.map(x => x._img).filter(Boolean); openLightbox(imgs, Math.max(0, imgs.indexOf(img))); };
}
function setGenFlagged(shot, reason) {
  const p = gp(shot); if (!p) return; p.classList.add("fail");
  p.querySelector(".gright").innerHTML = `<span class="pill flagged">QA flagged</span>`;
  p.querySelector(".approve")?.classList.remove("hidden");   // offer "approve anyway"
  if (!p.querySelector(".greason")) p.querySelector(".gmeta").insertAdjacentHTML("afterend", `<div class="greason">${esc(reason)}</div>`);
}
function clearGreason(shot) { const p = gp(shot); if (p) { p.classList.remove("fail"); p.querySelector(".greason")?.remove(); p.querySelector(".approve")?.classList.add("hidden"); } }

async function runGeneration() {
  const all = state.shots, staging = all.filter(s => s.is_staging), derived = all.filter(s => !s.is_staging), totalPanels = all.length;
  $("#genTitle").textContent = state.current?.name || "Project";
  $("#genSub").textContent = `Scene ${state.current?.scene || "01"}` + (state.current?.location ? ` — ${state.current.location}` : "");
  $("#genStateLabel").textContent = "Generating…";
  $("#genActions").classList.remove("hidden"); $("#resumeBtn").classList.add("hidden");
  // Two groups: the staging frames (already locked in) and the actual shots being drawn from them.
  const groupHdr = t => `<div class="genGroup">${t}</div>`;
  $("#genBoard").innerHTML =
    (staging.length ? groupHdr("Staging frames · scene references") + staging.map(gpanelHTML).join("") : "")
    + groupHdr("Shots") + derived.map(gpanelHTML).join("");

  let approved = 0, flagged = 0, done = 0;
  const stagingCount = all.filter(s => s.is_staging).length;
  all.filter(s => s.is_staging).forEach(s => {
    s._img = DEMO ? s._img : panelURL(s.shot);
    if (s._img) setGenImg(s.shot, s._img); setGenPill(s.shot, "approved", "Approved"); approved++; done++;
  });
  const setProg = () => {
    const pct = Math.round(done / totalPanels * 100);
    $("#progressFill").style.width = pct + "%"; $("#progressPct").textContent = pct + "%";
    $("#progressCount").textContent = `${done} of ${totalPanels} panels`;
    $("#genApproved").textContent = `${approved} approved`; $("#genFlagged").textContent = `${flagged} flagged`;
  };
  setProg();
  const t0 = Date.now();
  const eta = () => { const per = (Date.now() - t0) / Math.max(1, done - stagingCount); $("#progressEta").textContent = done < totalPanels ? `~${Math.round(per * (totalPanels - done) / 1000)}s left` : "all panels done"; };

  if (DEMO) {
    for (const s of derived) {
      const im = gp(s.shot)?.querySelector(".gimg");
      setGenPill(s.shot, "gen", "Drawing…"); startCountdown("g" + s.shot, im, 4, "Drawing"); await tick(420);
      setGenPill(s.shot, "gen", "QA ×3…"); startCountdown("g" + s.shot, im, 2, "QA"); await tick(340);
      if (s.shot === 5 && !s._tried) {
        s._tried = true; stopCountdown("g" + s.shot, im);
        setGenFlagged(s.shot, "STYLE: figure shaded like finished art instead of a rough sketch.");
        flagged++; setProg(); play("error"); await tick(1100);
        setGenPill(s.shot, "gen", "Redrawing…"); startCountdown("g" + s.shot, im, 4, "Drawing"); flagged--; setProg(); await tick(500);
      }
      stopCountdown("g" + s.shot, im); s._img = demoImg(s.shot);
      setGenImg(s.shot, s._img); clearGreason(s.shot); setGenPill(s.shot, "approved", "Approved");
      approved++; done++; play("tick"); eta(); setProg();
    }
  } else {
    await fetch("/api/start-generation", { method: "POST", headers: { ...apiHeaders(), "content-type": "application/json" }, body: JSON.stringify({ id: state.current.id }) }).catch(() => {});
    await runQueue(derived, 3, async (s) => {                 // 3 panels at a time; rest queued
      const im = gp(s.shot)?.querySelector(".gimg");
      setGenPill(s.shot, "gen", "Drawing…"); startCountdown("g" + s.shot, im, 60, "Drawing");
      const r = await genPanelReal(s.shot, {}, stage => { if (stage === "qa") { setGenPill(s.shot, "gen", "QA…"); startCountdown("g" + s.shot, im, 25, "QA"); } });
      stopCountdown("g" + s.shot, im);
      if (r.status === "approved") { s._img = panelURL(s.shot); setGenImg(s.shot, s._img); clearGreason(s.shot); setGenPill(s.shot, "approved", "Approved"); approved++; }
      else if (r.status === "flagged") { s._img = panelURL(s.shot); setGenImg(s.shot, s._img); setGenFlagged(s.shot, r.reason || "QA flagged"); flagged++; play("error"); }
      else { setGenPill(s.shot, "flagged", "Error"); setGenFlagged(s.shot, r.reason || "Generation failed"); flagged++; play("error"); }
      done++; play("tick"); eta(); setProg();
    });
  }
  $("#genStateLabel").textContent = "All panels done — review them, then create your storyboard.";
  $("#createBoardBtn").classList.remove("hidden");
  play("done");
  unlockStep("board");
  if (state.current) { state.current.status = "done"; state.current.panelsDone = totalPanels; state.current.panelsTotal = totalPanels; saveProjects(); }
}
$("#createBoardBtn").addEventListener("click", () => buildBoard());

function regenPanel(shot, opts) {
  const s = state.shots.find(x => x.shot === shot);
  const im = gp(shot)?.querySelector(".gimg");
  setGenPill(shot, "gen", "Redrawing…"); clearGreason(shot);
  if (DEMO) {
    startCountdown("g" + shot, im, 4, "Drawing");
    setTimeout(() => { stopCountdown("g" + shot, im); s._img = demoImg(shot); setGenImg(shot, s._img); setGenPill(shot, "approved", "Approved"); play("tick"); }, 1500);
    return;
  }
  startCountdown("g" + shot, im, 60, "Drawing");
  genPanelReal(shot, opts, stage => { if (stage === "qa") { setGenPill(shot, "gen", "QA…"); startCountdown("g" + shot, im, 25, "QA"); } }).then(r => {
    stopCountdown("g" + shot, im);
    if (r.status === "error") { setGenPill(shot, "flagged", "Error"); setGenFlagged(shot, r.reason || "Generation failed"); return; }
    s._img = panelURL(shot); setGenImg(shot, s._img);
    if (r.status === "flagged") setGenFlagged(shot, r.reason || "QA flagged");
    else { clearGreason(shot); setGenPill(shot, "approved", "Approved"); play("tick"); }
  });
}
// per-panel actions: download · retry · edit (prompt + feedback) → regenerate
$("#genBoard").addEventListener("click", e => {
  const card = e.target.closest(".gpanel"); if (!card) return;
  const shot = +card.dataset.shot, s = state.shots.find(x => x.shot === shot);
  if (e.target.closest(".dl")) {
    if (s._img) dl(s._img, `${(state.current?.name || "panel").replace(/\s+/g, "_")}_shot${String(shot).padStart(2, "0")}.png`);
    return;
  }
  if (e.target.closest(".retry")) return regenPanel(shot);
  if (e.target.closest(".approve")) {                 // keep a QA-flagged shot anyway
    clearGreason(shot); setGenPill(shot, "approved", "Approved");
    if (s) s.panelStatus = "approved";
    const a = $("#genApproved"), f = $("#genFlagged");
    if (a && f) { a.textContent = `${(parseInt(a.textContent) || 0) + 1} approved`; f.textContent = `${Math.max(0, (parseInt(f.textContent) || 0) - 1)} flagged`; }
    play("tick"); return;
  }
  if (e.target.closest(".editbtn")) return card.querySelector(".geditor").classList.toggle("hidden");
  if (e.target.closest(".regenfb")) {
    const prompt = card.querySelector(".gprompt").value;
    const feedback = card.querySelector(".gfeedback").value;
    s.image_prompt = prompt; s._feedback = feedback;
    card.querySelector(".geditor").classList.add("hidden");
    return regenPanel(shot, { prompt, feedback });
  }
});

/* ============================ storyboard ============================ */
// Storyboard sheet: 6 panels per page, header (PROJECT · SCENE · FORMAT · page), caption under each.
const BOARD_PER_PAGE = 6;
const boardImg = s => DEMO ? demoImg(s.shot) : panelURL(s.shot);
function boardPages() {
  const shots = state.shots || [], pages = [];
  for (let i = 0; i < shots.length; i += BOARD_PER_PAGE) pages.push(shots.slice(i, i + BOARD_PER_PAGE));
  return pages;
}
function buildBoard(jump) {
  go("board");
  const proj = state.current?.name || "Project", scene = state.current?.scene || "01";
  $("#boardMeta").textContent = `${proj} · scene ${scene}`;
  const pages = boardPages();
  state.boardPages = pages;
  $("#pages").innerHTML = pages.map((pg, pi) => {
    const cells = pg.map(s => {
      const url = boardImg(s);
      return `<div class="cell">
        <div class="cellimg" data-url="${url}" style="background-image:url('${url}')"></div>
        <div class="cellcap"><b>#${String(s.shot).padStart(2, "0")} · ${esc(s.type)}</b><p>${esc(s.caption || s.action || "")}</p></div>
      </div>`;
    }).join("");
    return `<div class="sheet">
      <div class="sheethead"><span>${esc(proj)}</span><span>Scene ${esc(scene)}</span><span>9:16</span><span>Page ${pi + 1} / ${pages.length}</span></div>
      <div class="sheetgrid">${cells}</div></div>`;
  }).join("");
  const urls = [...$$("#pages .cellimg")].map(e => e.dataset.url);
  $$("#pages .cellimg").forEach((el, i) => el.addEventListener("click", () => openLightbox(urls, i)));
}

/* ---- compose each page to a downloadable storyboard sheet PNG (header + frames + captions) ---- */
const loadImg = src => new Promise(res => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
function drawCover(ctx, im, x, y, w, h) {
  const ir = im.width / im.height, r = w / h; let sw, sh, sx, sy;
  if (ir > r) { sh = im.height; sw = sh * r; sx = (im.width - sw) / 2; sy = 0; }
  else { sw = im.width; sh = sw / r; sx = 0; sy = (im.height - sh) / 2; }
  ctx.drawImage(im, sx, sy, sw, sh, x, y, w, h);
}
function wrapText(ctx, text, x, y, maxW, lh, maxLines) {
  const words = String(text).split(/\s+/); let line = "", n = 0;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y); y += lh; line = w; if (++n >= maxLines) return;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, y);
}
async function composeSheet(pg, proj, scene, pi, total) {
  const cols = 3, rows = 2, pad = 48, gap = 28, headH = 72, capH = 132, Fw = 560, Fh = Math.round(Fw * 16 / 9);
  const W = pad * 2 + cols * Fw + (cols - 1) * gap, H = pad * 2 + headH + rows * (Fh + capH) + (rows - 1) * gap;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#111"; ctx.font = "700 30px Inter, Arial, sans-serif";
  ctx.fillText(proj.toUpperCase(), pad, pad + 34);
  ctx.font = "500 22px Inter, Arial, sans-serif"; ctx.fillStyle = "#666"; ctx.textAlign = "right";
  ctx.fillText(`SCENE ${scene}   ·   9:16   ·   PAGE ${pi + 1} / ${total}`, W - pad, pad + 34);
  ctx.textAlign = "left";
  ctx.strokeStyle = "#ddd"; ctx.beginPath(); ctx.moveTo(pad, pad + headH - 10); ctx.lineTo(W - pad, pad + headH - 10); ctx.stroke();
  const imgs = await Promise.all(pg.map(s => loadImg(boardImg(s))));
  for (let i = 0; i < pg.length; i++) {
    const s = pg[i], x = pad + (i % cols) * (Fw + gap), y = pad + headH + ((i / cols) | 0) * (Fh + capH + gap);
    ctx.fillStyle = "#000"; ctx.fillRect(x, y, Fw, Fh);
    if (imgs[i]) drawCover(ctx, imgs[i], x, y, Fw, Fh);
    ctx.strokeStyle = "#ccc"; ctx.strokeRect(x + 0.5, y + 0.5, Fw, Fh);
    ctx.fillStyle = "#111"; ctx.font = "700 16px ui-monospace, monospace";
    ctx.fillText(`#${String(s.shot).padStart(2, "0")} · ${s.type}`, x, y + Fh + 28);
    ctx.fillStyle = "#555"; ctx.font = "400 15px Inter, Arial, sans-serif";
    wrapText(ctx, (s.caption || s.action || "").replace(/\s*\n\s*/g, " "), x, y + Fh + 52, Fw, 20, 4);
  }
  return c.toDataURL("image/png");
}
$("#downloadAll").addEventListener("click", async () => {
  const pages = state.boardPages || boardPages(); if (!pages.length) return;
  const proj = state.current?.name || "Storyboard", scene = state.current?.scene || "01";
  const btn = $("#downloadAll"), label = btn.textContent; btn.disabled = true; btn.textContent = "Composing…";
  try {
    for (let i = 0; i < pages.length; i++) {
      const data = await composeSheet(pages[i], proj, scene, i, pages.length);
      dl(data, `${proj.replace(/\s+/g, "_")}_storyboard_p${String(i + 1).padStart(2, "0")}.png`);
      await tick(150);
    }
  } finally { btn.disabled = false; btn.textContent = label; }
});

/* ============================ lightbox (prev / next) ============================ */
const lb = $("#lightbox"), lbImg = $("#lightboxImg"), lbCount = $("#lbCount");
function openLightbox(list, i) { state.lb = { list, i }; showLb(); }
function showLb() {
  const { list, i } = state.lb; if (!list.length) return;
  lbImg.src = list[i]; lb.classList.add("open");
  lbCount.textContent = `${i + 1} / ${list.length}`;
  $("#lbPrev").style.visibility = i > 0 ? "visible" : "hidden";
  $("#lbNext").style.visibility = i < list.length - 1 ? "visible" : "hidden";
}
$("#lbPrev").addEventListener("click", e => { e.stopPropagation(); if (state.lb.i > 0) { state.lb.i--; showLb(); } });
$("#lbNext").addEventListener("click", e => { e.stopPropagation(); if (state.lb.i < state.lb.list.length - 1) { state.lb.i++; showLb(); } });
lb.addEventListener("click", e => { if (e.target === lb || e.target === lbImg) lb.classList.remove("open"); });
document.addEventListener("keydown", e => {
  if (!lb.classList.contains("open")) return;
  if (e.key === "Escape") lb.classList.remove("open");
  if (e.key === "ArrowLeft") $("#lbPrev").click();
  if (e.key === "ArrowRight") $("#lbNext").click();
});

/* ============================ panel helpers ============================ */
function panelHTML(s, img, st = "", dot = "") {
  return `<div class="panel" data-shot="${s.shot}">
    <div class="img ${img ? "" : "empty"}" ${img ? `style="background-image:url('${img}')"` : ""} data-state="${st}">
      ${dot ? `<span class="statusdot ${dot}"></span>` : ""}</div>
    <div class="cap">#${s.shot} · ${s.type}${s.is_staging ? " · staging" : ""}</div></div>`;
}
function setDot(shot, cls, label) {
  const p = $(`.panel[data-shot="${shot}"]`); if (!p) return;
  const im = p.querySelector(".img"); im.dataset.state = label;
  im.innerHTML = `<span class="statusdot ${cls}"></span>`;
}
function setPanelImg(shot, img, dot) {
  const p = $(`.panel[data-shot="${shot}"]`); if (!p) return;
  p.classList.remove("fail");
  const im = p.querySelector(".img"); im.classList.remove("empty");
  if (img) im.style.backgroundImage = `url('${img}')`;
  im.innerHTML = dot ? `<span class="statusdot ${dot}"></span>` : "";
  im.style.cursor = "zoom-in";
  im.onclick = () => { const imgs = state.shots.map(x => x._img).filter(Boolean); openLightbox(imgs, imgs.indexOf(img)); };
}
function showFail(shot, reason) {
  const p = $(`.panel[data-shot="${shot}"]`); if (!p) return;
  p.classList.add("fail");
  p.querySelector(".img").innerHTML = `<span class="statusdot fail"></span>`;
  p.querySelector(".img").dataset.state = "QA flagged";
  if (!p.querySelector(".reason")) {
    const m = reason.match(/^([A-Z &]+):/);
    const html = m ? `<b>${m[1]}</b>${reason.slice(m[0].length)}` : reason;
    p.insertAdjacentHTML("beforeend", `<div class="reason">${html}</div>`);
  }
}
function clearReason(shot) { const p = $(`.panel[data-shot="${shot}"]`); p && p.querySelector(".reason")?.remove(); }
function bindBoardZoom(sel) {
  $$(`${sel} .panel .img`).forEach(el => el.addEventListener("click", () => {
    const bg = el.style.backgroundImage; if (!bg) return;
    openLightbox([bg.slice(5, -2)], 0);
  }));
}

/* ============================ utils ============================ */
const tick = ms => new Promise(r => setTimeout(r, ms));
const fmtClock = s => { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

// per-panel loading shimmer + estimated-time countdown (staging + generation)
const _counters = {};
function startCountdown(key, imgEl, seconds, label) {
  stopCountdown(key);
  if (!imgEl) return;
  imgEl.classList.add("loading");
  let left = seconds;
  const paint = () => { imgEl.dataset.state = `${label} · ~${Math.max(1, Math.round(left))}s`; };
  paint();
  _counters[key] = setInterval(() => { left = Math.max(1, left - 1); paint(); }, 1000);
}
function stopCountdown(key, imgEl) {
  if (_counters[key]) { clearInterval(_counters[key]); delete _counters[key]; }
  if (imgEl) imgEl.classList.remove("loading");
}

// Run `worker` over `items` with at most `concurrency` in flight (queue: next starts as one ends).
async function runQueue(items, concurrency, worker) {
  let i = 0;
  const lane = async () => { while (i < items.length) { const it = items[i++]; await worker(it); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}
const panelURL = shot => `/api/panel?id=${encodeURIComponent(state.current.id)}&shot=${shot}&t=${Date.now()}`;
// Dispatch the per-panel background worker, then poll its status until it's done.
// onStage(stage) fires when the backend phase changes ("drawing" -> "qa") so the UI can show it.
async function genPanelReal(shotNum, opts = {}, onStage) {
  await fetch("/.netlify/functions/panel-background", {
    method: "POST", headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ id: state.current.id, shot: shotNum, qa: true, prompt: opts.prompt, feedback: opts.feedback }),
  }).catch(() => {});
  let last = null;
  for (let n = 0; n < 300; n++) {            // poll up to ~12 min
    await tick(2500);
    let st; try { st = await (await fetch(`/api/status?id=${state.current.id}`, { headers: apiHeaders() })).json(); } catch { continue; }
    const s = (st.shots || []).find(x => x.shot === shotNum);
    if (!s) continue;
    if (onStage && s.panelStatus && s.panelStatus !== last) { last = s.panelStatus; onStage(s.panelStatus); }
    if (["approved", "flagged", "error"].includes(s.panelStatus)) return { status: s.panelStatus, reason: s.reason };
  }
  return { status: "error", reason: "timed out" };
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const today = () => new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
function dl(url, name) { const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

/* ============================ backend contract (used when deployed) ============================ */
function appPw() {
  let p = localStorage.getItem("sb_pw");
  if (!p) { p = prompt("Enter the app password:") || ""; if (p) localStorage.setItem("sb_pw", p); }
  return p;
}
const apiHeaders = () => ({ "x-app-password": appPw() });

async function apiBreakdown(onStage) {
  onStage && onStage("reading");
  const form = new FormData();
  if (state.file) form.append("script", state.file);
  form.append("project", state.current.name);
  form.append("format", state.current.format);
  form.append("editorial", "1");
  form.append("mode", state.uploadMode || "script");
  const res = await fetch("/api/breakdown", { method: "POST", body: form, headers: apiHeaders() });
  if (res.status === 401) { localStorage.removeItem("sb_pw"); play("error"); alert("Wrong app password — reload and try again."); return []; }
  if (!res.ok) { play("error"); alert("Breakdown failed: " + (await res.text()).slice(0, 200)); return []; }
  const { id, error } = await res.json();
  if (error) { play("error"); alert(error); return []; }
  state.current.id = id;
  // Trigger the background worker DIRECTLY (returns 202 and runs server-side).
  await fetch("/.netlify/functions/breakdown-background", {
    method: "POST", headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => {});
  for (;;) {
    await tick(2500);
    const st = await (await fetch(`/api/status?id=${id}`, { headers: apiHeaders() })).json();
    if (st.stage && onStage) onStage(st.stage);   // light up the real stage
    if (st.status === "shots_ready") {
      if (st.scene) state.current.scene = st.scene;
      if (st.location) state.current.location = st.location;
      return st.shots;
    }
    if (st.status === "error") { play("error"); alert(st.message || "Breakdown failed"); return []; }
  }
}

/* ============================ demo data ============================ */
const DEMO_ASSETS = (typeof window !== "undefined" && window.DEMO_ASSETS) || null;
function demoImg(n) { return DEMO_ASSETS ? DEMO_ASSETS["panel" + (((n - 1) % 4) + 1)] : `demo/panel${((n - 1) % 4) + 1}.png`; }
function demoPages() { return DEMO_ASSETS ? [DEMO_ASSETS.page1, DEMO_ASSETS.page2] : ["demo/page1.png", "demo/page2.png"]; }
function demoShots() {
  const S = (shot, type, is_staging, caption, action, setting, mood, characters, image_prompt) =>
    ({ shot, type, setup: "lab_floor", is_staging, caption, action, setting, mood, characters, image_prompt });
  return [
    S(1, "WIDE ESTABLISHING", true,
      "The lab floor at night.\nFour figures spread across the cold, vast space.\nThe phoenix turbine glows behind them.",
      "Establishes the lab and everyone's position before the confrontation begins.",
      "High-tech aerospace lab, night, wide from the entrance",
      "Cold, sterile, charged with tension",
      ["Carter", "Tiffany", "John", "Alexander"],
      "Wide establishing staging shot of the lab; JOHN far-left crouched with a mop, CARTER center-left, TIFFANY center, ALEXANDER far-right facing into the scene."),
    S(2, "MEDIUM", false,
      "Carter and Tiffany stand close by the glass partition.\nA charged, quiet beat between them.",
      "Carter leans toward Tiffany; she holds her ground, arms crossed.",
      "Beside the floor-to-ceiling glass partition",
      "Cool rim light, intimate tension",
      ["Carter", "Tiffany"],
      "Medium two-shot, CARTER left and TIFFANY right facing each other near the glass."),
    S(3, "CLOSE UP", false,
      "Carter's face tightens — outrage, barely held.",
      "Carter's expression hardens as he registers the insult.",
      "Tight on Carter, lab bokeh behind",
      "Hard key light, simmering anger",
      ["Carter"],
      "Close-up on CARTER, jaw tight, eyes narrowed."),
    S(4, "INSERT", false,
      "A mop and metal bucket on the wet floor.",
      "Cutaway to the janitor's bucket — the spill that started it all.",
      "Low angle on the lab floor",
      "Flat practical light, mundane",
      [],
      "Insert: a mop and metal bucket on the wet floor, turbine soft behind."),
    S(5, "REACTION", false,
      "John looks up from his work, uneasy.",
      "John pauses mid-mop, sensing the room shift.",
      "Far side of the lab floor",
      "Dim, watchful",
      ["John"],
      "Reaction medium on JOHN crouched with the mop, looking up toward the group."),
    S(6, "WIDE", false,
      "Alexander strides toward the group, surveying the room.",
      "Alexander enters and walks toward Carter and Tiffany, gaze sweeping the floor.",
      "Lab floor, from behind Alexander",
      "Commanding, cold authority",
      ["Alexander", "Carter", "Tiffany", "John"],
      "Wide shot, ALEXANDER far-right seen from a three-quarter back angle moving toward the group at center-left."),
  ];
}
function demoProjects() {
  return [
    { id: "d1", name: "Episode 1 The Track Breaker", scene: "01", location: "South Mumbai", status: "ready", panelsDone: 0, panelsTotal: 32, date: "4d ago" },
    { id: "d2", name: "Episode 1 The Track Breaker", scene: "01", location: "South Mumbai Streets & Speedway Prime", status: "stopped", panelsDone: 6, panelsTotal: 16, date: "4d ago" },
    { id: "d3", name: "Episode 2 The Ghost Drift", scene: "01", location: "Race Track", status: "ready", panelsDone: 0, panelsTotal: 32, date: "4d ago" },
    { id: "d4", name: "Zero Day Payback", scene: "01", location: "The lab", status: "done", panelsDone: 6, panelsTotal: 6, date: "5d ago" },
  ];
}

/* ============================ boot ============================ */
const badge = $("#demoBadge");
if (DEMO) { badge.textContent = "demo"; badge.classList.remove("hidden"); }
else {
  // deployed: ping the API so we can see the backend is live
  fetch("/api/hello").then(r => r.ok ? r.json() : null).then(d => {
    if (d && d.ok) {
      badge.textContent = "API live"; badge.style.color = "var(--ok)";
      badge.style.borderColor = "oklch(0.6 0.1 150 / 0.5)"; badge.classList.remove("hidden");
    }
  }).catch(() => {});
}
loadProjects();           // so "My Projects" has data; landing page is the upload screen
resetUpload();
resetUnlock("upload");
go("upload");
