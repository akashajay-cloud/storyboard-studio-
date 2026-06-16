# Deploy Storyboard Studio to Netlify

This is **Step 1**: get the site + API skeleton live on Netlify. (Generation gets wired up in the
next steps.) No command line needed — we use the GitHub website + Netlify website.

## What's in this folder
- `public/` — the website (static; no build step).
- `netlify/functions/` — the backend (`hello.mjs` health check for now).
- `netlify.toml` — tells Netlify where things are and routes `/api/*` to the functions.

---

## A. Put the code on GitHub (browser only)
1. Go to **https://github.com/new** → create a repo named e.g. `storyboard-studio` → **Create**.
2. On the new repo page, click **“uploading an existing file”**.
3. In Finder, open the **`storyboard-web`** folder, select everything inside it
   (`public`, `netlify`, `netlify.toml`, `package.json`, `.gitignore`, `DEPLOY.md`) and **drag it
   onto the GitHub upload page**. (Skip `preview.html` — it's just a local preview.)
4. Click **Commit changes**.

> Prefer an app? **GitHub Desktop** (desktop.github.com) does the same with “Add local repository →
> Publish.”

## B. Connect Netlify
1. Go to **https://app.netlify.com** → **Add new site → Import an existing project → GitHub**.
2. Pick your `storyboard-studio` repo.
3. Netlify reads `netlify.toml` automatically — leave build settings as detected
   (**Publish directory: `public`**, no build command). Click **Deploy**.
4. After ~1 minute you'll get a URL like `https://your-site.netlify.app`.

## C. Set the API keys (environment variables)
In Netlify: **Site configuration → Environment variables → Add a variable**, add:
- `ANTHROPIC_API_KEY` = your Anthropic key
- `OPENAI_API_KEY` = your OpenAI key
- `APP_PASSWORD` = any password you choose (gates the app so visitors can't spend your keys)

Then **Deploys → Trigger deploy → Deploy site** so the new variables take effect.

> Keys live ONLY here, never in the code. (Netlify Blobs storage needs no setup — it's built in.)

---

## D. Verify Step 1 works
1. Open your `*.netlify.app` URL → the **UI loads** (Projects page) and the badge says **“API live”**.
2. Open **`https://your-site.netlify.app/api/hello`** → you should see JSON like:
   ```json
   { "ok": true, "service": "Storyboard Studio API", "step": 1,
     "hasAnthropicKey": true, "hasOpenAIKey": true, "time": "..." }
   ```
   - `hasAnthropicKey` / `hasOpenAIKey` = `true` confirms your env vars are set (the keys
     themselves are never shown).

If both work, the plumbing is good and we move to **Step 2** (real shot breakdown). If `/api/hello`
404s or the keys show `false`, tell me what you see and I'll fix it.
