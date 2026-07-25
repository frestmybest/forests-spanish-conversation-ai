# HablaYa — deploy guide

A Spanish-language website where Spanish speakers practice spoken English with a real-time AI.
No terminal needed. Everything below is free.

Total time: about 20 minutes.

---

## What you're deploying

```
hablaya/
├── public/
│   ├── index.html        the Spanish-language page
│   ├── app.js            mic capture, WebSocket to Gemini, audio playback
│   └── pcm-processor.js  audio helper that runs in the browser
├── api/
│   └── token.js          runs on Vercel's server, hides your API key
├── package.json
└── vercel.json
```

Keep this folder structure exactly as it is. Vercel treats `public/` as the website
and anything in `api/` as a mini server.

---

## Step 1 — Get a free Gemini API key

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account.
3. Click **Create API key** → **Create API key in new project**.
4. Copy the key and paste it somewhere safe for a minute (Notepad is fine).

No credit card required. Don't put this key in any of the code files — you'll paste it
into Vercel in Step 4, where it stays hidden from visitors.

---

## Step 2 — Put the code on GitHub

1. Go to **https://github.com** and create a free account (or sign in).
2. Click the **+** in the top-right → **New repository**.
3. Name it `hablaya`. Leave it **Public**. Don't check any of the "Initialize" boxes.
   Click **Create repository**.
4. On the next screen click the link **uploading an existing file**.
5. Unzip the `hablaya` folder on your computer. Open it, select **everything inside it**
   (the `public` folder, the `api` folder, `package.json`, `vercel.json`, `README.md`)
   and **drag it all onto the GitHub upload box**.
   - Drag the *contents* of `hablaya`, not the `hablaya` folder itself.
   - GitHub keeps the folder structure when you drag folders. Wait until you see
     `public/index.html` and `api/token.js` listed before continuing.
6. Scroll down, click **Commit changes**.

---

## Step 3 — Connect Vercel

1. Go to **https://vercel.com/signup** and choose **Continue with GitHub**. Approve access.
2. On your Vercel dashboard click **Add New…** → **Project**.
3. Find `hablaya` in the list and click **Import**.
   - If you don't see it, click **Adjust GitHub App Permissions** and grant access to the repo.
4. **Don't click Deploy yet.** Do Step 4 first, on this same screen.

---

## Step 4 — Add your API key

Still on the import screen:

1. Expand **Environment Variables**.
2. **Key:** `GEMINI_API_KEY`
3. **Value:** paste the key from Step 1.
4. Click **Add**.
5. Now click **Deploy**.

Wait about a minute. You'll get a live URL like `https://hablaya.vercel.app`.

> Forgot to add the key? Go to **Settings → Environment Variables**, add it, then
> **Deployments → ⋯ → Redeploy**. Environment variables only apply to new deployments.

---

## Step 5 — Test it

1. Open your Vercel URL in Chrome.
2. Click **Empezar conversación** and allow microphone access.
3. Wait a couple of seconds — the AI greets you in English first.
4. Talk. It replies out loud and the transcript appears on screen.

Use headphones. Without them, the AI hears its own voice and may interrupt itself.

---

## If something goes wrong

Press **F12** in Chrome and click the **Console** tab — the error message there tells you which of these it is.

| What you see | What to do |
|---|---|
| Red box: "Falta GEMINI_API_KEY" | The env var isn't set, or you set it after deploying. Add it, then redeploy. |
| Red box: "Error de la API: … model not found" | Google renamed the model. Add a second Vercel env var `GEMINI_LIVE_MODEL` with a current Live model name from https://ai.google.dev/gemini-api/docs/models, then redeploy. |
| Red box: "Error de la API: … quota" or 429 | You hit the free tier's daily limit. It resets every 24 hours. |
| "No se pudo acceder al micrófono" | Click the padlock icon in Chrome's address bar → allow Microphone. Mics only work over HTTPS, which Vercel gives you automatically. |
| Page loads but nothing happens on click | Check that `app.js` and `pcm-processor.js` are inside `public/` on GitHub, not at the top level. |
| Vercel build fails with "No Output Directory" | `vercel.json` didn't upload. Re-upload it to the top level of the repo. |

---

## Changing things

Edit files right on GitHub (open the file → pencil icon → **Commit changes**).
Vercel redeploys automatically within a minute.

- **The AI's personality, level handling, correction style:** `buildSystemInstruction()` in `public/app.js`.
- **Scenarios in the dropdown:** the `<option>` list in `public/index.html`. The Spanish text is
  what the user sees; the `value` is the English prompt sent to the AI.
- **Colors:** the `:root` block at the top of `public/index.html`.

---

## Things to know about "free"

- **Gemini free tier** has daily request limits that Google changes without notice, and Live API
  audio burns through quota faster than text. Fine for you and a handful of testers; it will not
  survive going viral. Check your usage at https://aistudio.google.com.
- **Vercel Hobby** is free but **prohibits commercial use**. If you ever charge for this or run
  ads, you need a paid plan.
- The Live API is officially a **preview** product, so Google may change or break it.
- Anyone who finds your URL can use your Gemini quota. If that becomes a problem, add a simple
  password check to `api/token.js` before it mints a token.
