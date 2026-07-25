# Forest's Spanish AI Bot — deploy guide

An English-language website where you practice **spoken Spanish** with a real-time AI.
The interface is in English; the conversation is entirely in Spanish.

No terminal needed. Everything below is free. About 20 minutes.

---

## What you're deploying

```
forests-spanish-ai-bot/
├── public/
│   ├── index.html        the page
│   ├── app.js            mic capture, WebSocket to Gemini, audio playback
│   └── pcm-processor.js  audio helper that runs in the browser
├── api/
│   └── token.js          runs on Vercel's server, hides your API key
├── package.json
└── vercel.json
```

Keep this structure exactly. Vercel serves `public/` as the website and turns
anything in `api/` into a mini server.

---

## Step 1 — Get a free Gemini API key

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account.
3. **Create API key** → **Create API key in new project**.
4. Copy it somewhere safe for a minute.

No credit card required. Never put this key in the code files — it goes into Vercel in Step 4.

---

## Step 2 — Put the code on GitHub

1. **https://github.com** → sign in → **+** (top right) → **New repository**.
2. Name it `forests-spanish-ai-bot`. Public. Don't check any "Initialize" boxes. **Create repository**.
3. Click **uploading an existing file**.
4. Extract the zip somewhere with a **short path** (e.g. your Desktop) — deep folders trigger
   Windows' "Destination Path Too Long" error.
5. Open the extracted folder and select the five things **inside** it (Ctrl+A):
   `public`, `api`, `package.json`, `vercel.json`, `README.md`. Drag them all onto the upload box.
6. **Before committing**, check the list shows `public/index.html`, `public/app.js`,
   `public/pcm-processor.js`, `api/token.js` — with slashes. Bare filenames means the folders
   got flattened; start over.
7. **Commit changes**.

> Dragged the whole outer folder by mistake? That's fixable — see "Root Directory" in Step 3.

---

## Step 3 — Connect Vercel

1. **https://vercel.com/signup** → **Continue with GitHub** → approve.
2. Dashboard → **Add New…** → **Project** → find the repo → **Import**.
   - Not listed? Click **Adjust GitHub App Permissions** and grant access.
   - If your files ended up nested one level deep, click **Edit** next to **Root Directory**
     and select the inner folder.
3. **Don't hit Deploy yet** — do Step 4 on this same screen.

---

## Step 4 — Add your API key

1. Expand **Environment Variables**.
2. **Key:** `GEMINI_API_KEY`
3. **Value:** the key from Step 1.
4. **Add**, then **Deploy**.

> Forgot? **Settings → Environment Variables**, add it, then **Deployments → ⋯ → Redeploy**.
> Environment variables only apply to deployments made after you add them.

---

## Step 5 — Test it

Open the URL in Chrome → **Start conversation** → allow the microphone. The AI greets you in
Spanish first. Talk back. Use headphones, or it hears itself and interrupts.

---

## Changing your Vercel URL

Vercel gives you `something.vercel.app` for free. Two ways to change it:

**Rename the project** (changes the default URL):
**Settings → General → Project Name** → type a new name → **Save**.
`forests-spanish-ai-bot` becomes `forests-spanish-ai-bot.vercel.app`. If that exact name is
taken globally, Vercel appends random characters — pick something more distinctive.

**Add another free .vercel.app subdomain:**
**Settings → Domains → Add** → type `whatever-you-want.vercel.app` → **Add**. If it's unclaimed
it's yours instantly, and the old URL keeps working too.

**Use your own domain** (e.g. `spanishbot.com`): connecting it to Vercel is free, but you have to
buy the domain itself — roughly $10–15/year from Namecheap, Cloudflare, or Vercel itself.
Then **Settings → Domains → Add**, and Vercel walks you through the DNS records.

---

## If something goes wrong

Press **F12** in Chrome → **Console** tab. The error there tells you which of these it is.

| What you see | What to do |
|---|---|
| "GEMINI_API_KEY is missing" | Env var not set, or set after deploying. Add it, then redeploy. |
| "API error: … model not found" | Google renamed the model. Add a Vercel env var `GEMINI_LIVE_MODEL` with a current Live model name from https://ai.google.dev/gemini-api/docs/models, then redeploy. |
| "API error: … quota" or 429 | Hit the free tier's daily limit. Resets every 24 hours. |
| "Could not access the microphone" | Padlock icon in Chrome's address bar → allow Microphone. Mics need HTTPS, which Vercel provides. |
| Page loads, button does nothing | `app.js` and `pcm-processor.js` must be inside `public/`, not at the top level. |
| Build fails: "No Output Directory" | `vercel.json` didn't upload. Add it to the top level of the repo. |

---

## Customizing

Edit files right on GitHub (open file → pencil icon → **Commit changes**). Vercel redeploys
automatically within a minute.

- **The AI's personality, level handling, corrections:** `buildSystemInstruction()` in `public/app.js`
- **Scenarios and dialects in the dropdowns:** the `<option>` lists in `public/index.html`.
  The text between the tags is what you see; the `value` is the English prompt sent to the AI.
- **Colors:** the `:root` block at the top of `public/index.html`
- **Title:** the `<h1>` and `<title>` tags in `public/index.html`

---

## Things to know about "free"

- **Gemini free tier** has daily limits Google changes without notice, and live audio burns quota
  much faster than text. Fine for you and a few friends; it won't survive going viral.
  Check usage at https://aistudio.google.com.
- **Vercel Hobby** is free but **prohibits commercial use**. Charging or running ads means a paid plan.
- The Live API is officially a **preview** product — Google may change or break it.
- Anyone with your URL spends your Gemini quota. If that becomes a problem, add a password check
  to `api/token.js` before it mints a token.
