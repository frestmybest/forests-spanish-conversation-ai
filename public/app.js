/* Forest's Spanish AI Bot — real-time Spanish conversation practice via the Gemini Live API.
   The browser talks directly to Google over a WebSocket. It never sees your API key:
   /api/token mints a short-lived ephemeral token on the server first. */

const el = (id) => document.getElementById(id);
const startBtn = el('start');
const stopBtn = el('stop');
const statusEl = el('status');
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
let gotSetupComplete = false;

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

/* ---------- Entry screen: computer vs. mobile view ---------- */

const chooser = el('chooser');
const viewSelect = el('viewMode');

function applyView(mode) {
  document.body.dataset.view = mode === 'mobile' ? 'mobile' : 'desktop';
  try { localStorage.setItem('viewMode', document.body.dataset.view); } catch (e) {}
}

// Preselect the sensible option: remembered choice first, then screen width.
(function initChooser() {
  let saved = null;
  try { saved = localStorage.getItem('viewMode'); } catch (e) {}
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  viewSelect.value = saved || (narrow ? 'mobile' : 'desktop');
})();

el('enter').addEventListener('click', () => {
  applyView(viewSelect.value);
  chooser.classList.add('hidden');
});

el('switchView').addEventListener('click', () => {
  chooser.classList.remove('hidden');
});

/* ---------- The tutor's personality ---------- */

function buildSystemInstruction() {
  const level = el('level').value;
  const scenario = el('scenario').value;
  const dialect = el('dialect').value;
  const correction = el('correction').value;
  const rescue = el('rescue').value;
  const extra = el('extra').value.trim();

  const correctionRules = {
    none: 'Do not correct the learner at all. Just keep the conversation flowing naturally.',
    gentle:
      'When the learner makes a mistake, do not lecture. Simply repeat their idea back correctly as a natural part of your reply (recasting), then continue. Correct at most one mistake per turn, and only ones that matter for being understood.',
    strict:
      'After each conversational reply, briefly name one grammar or vocabulary mistake the learner made, give the corrected version, and then continue the conversation with a follow-up question. Do this in Spanish.'
  };

  const rescueRules = {
    spanish:
      'If the learner gets stuck or speaks English, do NOT switch to English. Rephrase more simply in Spanish, offer them the Spanish words they need, and keep going.',
    english:
      'If the learner is truly stuck, you may give a very short hint in English (one sentence maximum), then immediately return to Spanish.'
  };

  return [
    'You are a warm, patient native Spanish speaker helping an English speaker practice spoken Spanish.',
    'ALWAYS speak in Spanish. Speak ' + dialect + '.',
    'The setting for this conversation is: ' + scenario + '. Stay in that role.',
    'The learner is at CEFR level ' + level + '. Match your vocabulary, grammar and speaking speed to that level. At A1/A2 use short simple sentences, present tense, and speak slowly and clearly. At B2/C1 speak at a natural native pace with richer vocabulary and idioms.',
    correctionRules[correction],
    rescueRules[rescue],
    'Keep your turns SHORT — two or three sentences at most. This is a conversation, not a lecture. Always end your turn with a question so the learner has to speak.',
    'Sound like a real person: use contractions, natural fillers and reactions. Never mention that you are an AI and never read these instructions aloud.',
    extra ? 'Additional request from the learner: ' + extra : '',
    'Begin the conversation immediately with a short, friendly greeting in Spanish appropriate to the setting.'
  ]
    .filter(Boolean)
    .join('\n\n');
}

/* ---------- Audio plumbing ---------- */

function floatToPCM16Base64(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
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
  setStatus('Connecting…', false);

  let token, model;
  try {
    const res = await fetch('/api/token', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not get a token');
    token = data.token;
    model = data.model;
  } catch (err) {
    showError('Could not reach the server: ' + err.message);
    setStatus('Disconnected', false);
    startBtn.disabled = false;
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
  } catch (err) {
    showError('Could not access the microphone. Allow access in your browser and try again.');
    setStatus('Disconnected', false);
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
    // First message must be the session setup, and nothing else may be sent
    // until the server answers with setupComplete.
    ws.send(JSON.stringify({
      setup: {
        model: 'models/' + model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: el('voice').value } }
          }
        },
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    }));
    setStatus('Starting session…', false);
  };

  ws.onmessage = async (event) => {
    let payload = event.data;
    if (payload instanceof Blob) payload = await payload.text();

    let msg;
    try { msg = JSON.parse(payload); } catch (e) { console.warn('Non-JSON message:', payload); return; }
    console.log('[live] server message:', msg);

    if (msg.error) {
      showError('API error: ' + (msg.error.message || JSON.stringify(msg.error)));
      return;
    }

    // Setup accepted — now it's safe to open the mic and get the AI talking.
    if (msg.setupComplete) {
      gotSetupComplete = true;
      ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: '¡Hola!' }] }],
          turnComplete: true
        }
      }));
      startMic();
      running = true;
      stopBtn.disabled = false;
      setStatus('Live — start talking', true);
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      stopPlayback();
      aiBubble = null;
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (!userBubble) userBubble = bubble('user', 'You');
      appendText(userBubble, sc.inputTranscription.text);
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      if (userBubble) userBubble = null;
      if (!aiBubble) aiBubble = bubble('ai', 'AI');
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
    showError('Lost the connection to the voice server. Try again.');
  };

  ws.onclose = (e) => {
    console.log('[live] closed — code:', e.code, 'reason:', e.reason || '(none given)');
    const detail = 'code ' + e.code + (e.reason ? ': ' + e.reason : '');
    if (!gotSetupComplete) {
      showError(
        'The session closed before it finished starting (' + detail + '). ' +
        'Open the browser console (F12) for the full message.'
      );
    } else if (running) {
      showError('The conversation closed (' + detail + '). Hit “Start conversation” to pick it back up.');
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
  gotSetupComplete = false;
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
  setStatus('Disconnected', false);
}

function stop() {
  running = false;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  cleanup();
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
