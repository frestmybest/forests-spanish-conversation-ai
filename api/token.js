// Runs on Vercel's servers, not in the browser.
// It swaps your secret GEMINI_API_KEY for a short-lived token that the browser
// can safely use to open a Live API WebSocket. The key itself never reaches the user.

import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is missing. Add it in Vercel > Settings > Environment Variables, then redeploy.'
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();

    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
        liveConnectConstraints: { model: MODEL },
        httpOptions: { apiVersion: 'v1alpha' }
      }
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ token: token.name, model: MODEL });
  } catch (err) {
    console.error('Token creation failed:', err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
