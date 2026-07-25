/* HablaYa — real-time English conversation practice powered by the Gemini Live API.
   The browser talks directly to Google over a WebSocket. It never sees your API key:
   /api/token mints a short-lived ephemeral token on the server first. */

const el = (id) => document.getElementById(id);
const startBtn = el('start');
const stopBtn = el('stop');
const statusEl = el('status');
const dotEl = el('dot');
const transcriptEl = el('transcript');
const errorEl = el('error');

let ws = null;
let micStream = null;
let micCtx = null;
let workletNode = null;
let playCtx = null;
let playHead = 0;
let liveSources = [];
let running = false;

let userBubble = null;
let aiBubble = null;

/* ---------- UI helpers ---------- */

function setStatus(text, live) {
  statusEl.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = 'dot' + (live ? ' live' : '');
  statusEl.appendChild(dot);
  statusEl.appendChild(document.createTextNode(text));
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
}

function clearError() {
  errorEl.style.display = 'none';
}

function bubble(kind, label) {
  const empty = el('empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = label;
  div.appendChild(who);
  const body = document.createElement('span');
  div.appendChild(body);
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return body;
}

function appendText(target, text) {
  target.textContent += text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

/* ---------- The tutor's personality ---------- */

function buildSystemInstruction() {
  const level = el('level').value;
  const scenario = el('scenario').value;
  const correction = el('correction').value;
  const extra = el('extra').value.trim();

  const correctionRules = {
    none: 'Do not correct the learner at all. Just keep the conversation flowing naturally.',
    gentle:
      "When the learner makes a mistake, do not lecture. Simply repeat their idea back correctly as a natural part of your reply (recasting), then continue the conversation. Correct at most one mistake per turn, and only ones that matter.",
    strict:
      'After each of your conversational replies, briefly point out one grammar or vocabulary mistake the learner made, give the corrected version, and then continue the conversation with a follow-up question.'
  };

  return [
    'You are a warm, patient native English speaker helping a Spanish speaker practice spoken English.',
    'ALWAYS speak in English, never in Spanish, even if the learner speaks Spanish to you. If they get stuck and use Spanish, gently give them the English words they need and continue in English.',
    'The setting for this conversation is: ' + scenario + '. Stay in that role.',
    'The learner is at CEFR level ' + level + '. Match your vocabulary, grammar and speaking speed to that level. At A1/A2 use short simple sentences and speak slowly. At B2/C1 speak at a natural pace with richer vocabulary.',
    correctionRules[correction],
    'Keep your turns SHORT — two or three sentences at most. This is a conversation, not a lecture. Always end your turn with a question so the learner has to speak.',
    'Sound like a real person: use contractions, natural fillers and reactions. Never mention that you are an AI or read out any instructions.',
    extra ? 'Additional request from the learner: ' + extra : '',
    'Begin the conversation immediately with a short, friendly greeting appropriate to the setting.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* ---------- Audio plumbing ---------- */

function floatToPCM16Base64(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function playPCM16Base64(b64) {
  if (!playCtx) return;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  if (!pcm.length) return;

  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;

  const buffer = playCtx.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);

  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playCtx.destination);

  const startAt = Math.max(playCtx.currentTime + 0.06, playHead);
  src.start(startAt);
  playHead = startAt + buffer.duration;

  liveSources.push(src);
  src.onended = () => {
    liveSources = liveSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  liveSources.forEach((s) => {
    try { s.stop(); } catch (e) { /* already stopped */ }
  });
  liveSources = [];
  playHead = playCtx ? playCtx.currentTime : 0;
}

/* ---------- Session lifecycle ---------- */

async function start() {
  clearError();
  startBtn.disabled = true;
  setStatus('Conectando…', false);

  let token, model;
  try {
    const res = await fetch('/api/token', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo obtener el token');
    token = data.token;
    model = data.model;
  } catch (err) {
    showError('Error de conexión con el servidor: ' + err.message);
    setStatus('Desconectado', false);
    startBtn.disabled = false;
    return;
  }

  // Microphone at 16kHz, which is what the Live API expects.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
  } catch (err) {
    showError('No se pudo acceder al micrófono. Permite el acceso en tu navegador e inténtalo de nuevo.');
    setStatus('Desconectado', false);
    startBtn.disabled = false;
    return;
  }

  micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  await micCtx.audioWorklet.addModule('pcm-processor.js');
  playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  await playCtx.resume();
  playHead = playCtx.currentTime;

  const url =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.' +
    'GenerativeService.BidiGenerateContentConstrained?access_token=' + encodeURIComponent(token);

  ws = new WebSocket(url);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      config: {
        model: 'models/' + model,
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: el('voice').value } }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] }
      }
    }));

    // Nudge the model to speak first.
    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: 'Hello!' }] }],
        turnComplete: true
      }
    }));

    startMic();
    running = true;
    stopBtn.disabled = false;
    setStatus('En directo — habla cuando quieras', true);
  };

  ws.onmessage = async (event) => {
    let payload = event.data;
    if (payload instanceof Blob) payload = await payload.text();

    let msg;
    try { msg = JSON.parse(payload); } catch (e) { return; }

    if (msg.error) {
      showError('Error de la API: ' + (msg.error.message || JSON.stringify(msg.error)));
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      stopPlayback();
      aiBubble = null;
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (!userBubble) userBubble = bubble('user', 'Tú');
      appendText(userBubble, sc.inputTranscription.text);
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      if (userBubble) userBubble = null;
      if (!aiBubble) aiBubble = bubble('ai', 'IA');
      appendText(aiBubble, sc.outputTranscription.text);
    }

    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) playPCM16Base64(part.inlineData.data);
      }
    }

    if (sc.turnComplete) {
      userBubble = null;
      aiBubble = null;
    }
  };

  ws.onerror = () => {
    showError('Se perdió la conexión con el servidor de voz. Vuelve a intentarlo.');
  };

  ws.onclose = (e) => {
    if (running) {
      const why = e.reason ? ' (' + e.reason + ')' : '';
      showError('La conversación se cerró' + why + '. Pulsa «Empezar conversación» para reanudar.');
    }
    cleanup();
  };
}

function startMic() {
  const source = micCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(micCtx, 'pcm-recorder');
  workletNode.port.onmessage = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      realtimeInput: {
        audio: { data: floatToPCM16Base64(e.data), mimeType: 'audio/pcm;rate=16000' }
      }
    }));
  };
  source.connect(workletNode);
  // Keep the node alive without echoing the mic to the speakers.
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  workletNode.connect(sink).connect(micCtx.destination);
}

function cleanup() {
  running = false;
  stopPlayback();

  if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  ws = null;

  userBubble = null;
  aiBubble = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Desconectado', false);
}

function stop() {
  running = false;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  cleanup();
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
