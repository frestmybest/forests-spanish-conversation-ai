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
let muted = false;

let userBubble = null;
let aiBubble = null;
let transcriptLog = [];

let timerId = null;
let startedAt = 0;
let lastDayCount = null;

// Audio of the AI's current and previous turn, kept so it can be replayed.
let currentTurnAudio = [];
let lastTurnAudio = [];

/* Spanish varieties: prompt wording + the language code that locks
   transcription so it stops guessing at other languages. */
const DIALECTS = {
  latam: { prompt: 'neutral Latin American Spanish', lang: 'es-US' },
  mx:    { prompt: 'Mexican Spanish, using Mexican vocabulary and expressions', lang: 'es-MX' },
  es:    { prompt: 'peninsular Spanish from Spain, using vosotros and Spanish vocabulary', lang: 'es-ES' },
  ar:    { prompt: 'Argentine Spanish, using voseo and Rioplatense expressions', lang: 'es-US' }
};

const SETTINGS = ['level', 'scenario', 'dialect', 'voice', 'correction', 'rescue', 'extra'];

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

  const record = { who: label, text: '' };
  transcriptLog.push(record);
  return { body, record, node: div };
}

function clearTyping() {
  document.querySelectorAll('.msg.typing').forEach((n) => n.classList.remove('typing'));
}

function resetTranscript() {
  transcriptLog = [];
  userBubble = null;
  aiBubble = null;
  transcriptEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.id = 'empty';
  empty.textContent = 'Listening… start talking in Spanish whenever you\'re ready.';
  transcriptEl.appendChild(empty);
}

function appendText(target, text) {
  target.body.textContent += text;
  target.record.text += text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setLiveControls(on) {
  el('mute').disabled = !on;
  document.querySelectorAll('#quick button').forEach((b) => { b.disabled = !on; });
  if (!on) {
    muted = false;
    el('mute').classList.remove('on');
    el('mute').textContent = '🎤 Mute';
  }
}

/* ---------- Settings memory ---------- */

function saveSettings() {
  try {
    const data = {};
    SETTINGS.forEach((id) => { data[id] = el(id).value; });
    localStorage.setItem('settings', JSON.stringify(data));
  } catch (e) { /* private browsing, etc. */ }
}

function restoreSettings() {
  try {
    const raw = localStorage.getItem('settings');
    if (!raw) return;
    const data = JSON.parse(raw);
    SETTINGS.forEach((id) => {
      if (data[id] !== undefined && el(id)) el(id).value = data[id];
    });
  } catch (e) {}
}

restoreSettings();
SETTINGS.forEach((id) => el(id).addEventListener('change', saveSettings));

/* ---------- Practice history ----------
   Every finished session is appended to localStorage, so the chart survives
   refreshes and browser restarts. It lives on this device only — clearing your
   browser's site data for this site wipes it. */

const LOG_KEY = 'practiceLog';

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function saveLog(log) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch (e) {}
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function countMyWords() {
  return transcriptLog
    .filter((r) => r.who === 'You')
    .reduce((n, r) => n + r.text.trim().split(/\s+/).filter(Boolean).length, 0);
}

// Called once per session, from cleanup(). startedAt is zeroed so a single
// session can't be double-counted when both stop() and onclose fire.
function recordSession() {
  if (!startedAt) return;
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const start = startedAt;
  startedAt = 0;
  if (seconds < 10) return; // ignore accidental taps

  const log = loadLog();
  log.push({ start, seconds, words: countMyWords() });
  saveLog(log.slice(-500));
  renderStats();
}

function formatDuration(totalSeconds) {
  const m = Math.round(totalSeconds / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function currentStreak(log) {
  const days = new Set(log.map((s) => dayKey(s.start)));
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // A streak stays alive until you miss a whole day, so start from yesterday
  // if you haven't practiced yet today.
  if (!days.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// 14 bars are unreadable on a phone, so narrow layouts get a week instead.
function chartDays() {
  const mobileView = document.body.dataset.view === 'mobile';
  const narrowScreen = window.matchMedia('(max-width: 640px)').matches;
  return (mobileView || narrowScreen) ? 7 : 14;
}

function renderStats() {
  const log = loadLog();
  const days = chartDays();
  lastDayCount = days;

  const totalSeconds = log.reduce((n, s) => n + s.seconds, 0);
  const totalWords = log.reduce((n, s) => n + (s.words || 0), 0);
  el('statTotal').textContent = log.length ? formatDuration(totalSeconds) : '0m';
  el('statStreak').textContent = currentStreak(log);
  el('statSessions').textContent = log.length;
  el('statWords').textContent = totalWords.toLocaleString();

  el('chartNote').textContent = 'Last ' + days + ' days · minutes practiced per day';

  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.push({ date: d, key: dayKey(d.getTime()), seconds: 0 });
  }
  const byKey = {};
  buckets.forEach((b) => { byKey[b.key] = b; });
  log.forEach((s) => {
    const b = byKey[dayKey(s.start)];
    if (b) b.seconds += s.seconds;
  });

  const peak = Math.max(60, ...buckets.map((b) => b.seconds));
  const todayKey = dayKey(Date.now());
  const chart = el('chart');
  chart.innerHTML = '';

  buckets.forEach((b) => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (b.key === todayKey ? ' today' : '') + (b.seconds ? '' : ' empty');
    bar.title = b.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) +
      ' — ' + (b.seconds ? formatDuration(b.seconds) : 'no practice');

    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    track.appendChild(fill);

    const tag = document.createElement('em');
    tag.textContent = b.date.toLocaleDateString(undefined, { weekday: 'narrow' });

    bar.appendChild(track);
    bar.appendChild(tag);
    chart.appendChild(bar);

    // Set the height a frame later so the CSS transition actually animates.
    requestAnimationFrame(() => {
      fill.style.height = b.seconds ? Math.max(4, (b.seconds / peak) * 100) + '%' : '2px';
    });
  });

  const list = el('sessionList');
  list.innerHTML = '';
  const recent = log.slice(-6).reverse();
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'noData';
    li.textContent = 'No sessions yet. Your practice history will build up here.';
    list.appendChild(li);
    return;
  }
  recent.forEach((s) => {
    const d = new Date(s.start);
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const how = document.createElement('b');
    how.textContent = formatDuration(s.seconds) + (s.words ? ' · ' + s.words + ' words' : '');
    li.appendChild(when);
    li.appendChild(how);
    list.appendChild(li);
  });
}

el('clearStats').addEventListener('click', () => {
  if (!loadLog().length) return;
  if (!confirm('Delete your entire practice history? This cannot be undone.')) return;
  try { localStorage.removeItem(LOG_KEY); } catch (e) {}
  renderStats();
});

renderStats();

/* ---------- Entry screen: computer vs. mobile view ---------- */

const chooser = el('chooser');
const viewSelect = el('viewMode');

function applyView(mode) {
  document.body.dataset.view = mode === 'mobile' ? 'mobile' : 'desktop';
  try { localStorage.setItem('viewMode', document.body.dataset.view); } catch (e) {}
  renderStats(); // the chart shows fewer days on mobile, so redraw it
}

// Rotating a phone or resizing a window can cross the mobile threshold.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (chartDays() !== lastDayCount) renderStats();
  }, 180);
});

(function initChooser() {
  let saved = null;
  try { saved = localStorage.getItem('viewMode'); } catch (e) {}
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  viewSelect.value = saved || (narrow ? 'mobile' : 'desktop');
})();

el('enter').addEventListener('click', () => {
  applyView(viewSelect.value);
  // Fade out, then remove from the layout once the transition has finished.
  chooser.classList.add('closing');
  setTimeout(() => chooser.classList.add('hidden'), 260);
});

el('switchView').addEventListener('click', () => {
  chooser.classList.remove('hidden');
  // One frame later, so the browser notices the change and animates it.
  requestAnimationFrame(() => chooser.classList.remove('closing'));
});

/* ---------- The tutor's personality ---------- */

function buildSystemInstruction() {
  const level = el('level').value;
  const scenario = el('scenario').value;
  const dialect = DIALECTS[el('dialect').value] || DIALECTS.latam;
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
    'CRITICAL: Every single word you say must be in Spanish. Speak ' + dialect.prompt + '. Never produce English text or English speech, with no exception other than the rule below about the learner getting stuck.',
    'The setting for this conversation is: ' + scenario + '. Stay in that role.',
    'The learner is at CEFR level ' + level + '. Match your vocabulary, grammar and speaking speed to that level. At A1/A2 use short simple sentences, present tense, and speak slowly and clearly. At B2/C1 speak at a natural native pace with richer vocabulary and idioms.',
    correctionRules[correction],
    rescueRules[rescue],
    'EXCEPTION: if the learner directly and explicitly asks you to explain something in English, give a brief English explanation (two sentences at most), then immediately return to Spanish and continue the conversation. This overrides the Spanish-only rule, but only when they ask outright.',
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

function base64ToFloat32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768;
  return float32;
}

function queueForPlayback(float32) {
  if (!playCtx || !float32.length) return;
  const buffer = playCtx.createBuffer(1, float32.length, 24000);
  buffer.copyToChannel(float32, 0);

  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playCtx.destination);

  const startAt = Math.max(playCtx.currentTime + 0.06, playHead);
  src.start(startAt);
  playHead = startAt + buffer.duration;

  liveSources.push(src);
  src.onended = () => { liveSources = liveSources.filter((s) => s !== src); };
}

function stopPlayback() {
  liveSources.forEach((s) => {
    try { s.stop(); } catch (e) {}
  });
  liveSources = [];
  playHead = playCtx ? playCtx.currentTime : 0;
}

function replayLastTurn() {
  if (!lastTurnAudio.length || !playCtx) return;
  stopPlayback();
  const total = lastTurnAudio.reduce((n, a) => n + a.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of lastTurnAudio) { joined.set(chunk, offset); offset += chunk.length; }
  queueForPlayback(joined);
}

/* ---------- Toolbar ---------- */

el('mute').addEventListener('click', () => {
  muted = !muted;
  el('mute').classList.toggle('on', muted);
  el('mute').textContent = muted ? '🔇 Muted' : '🎤 Mute';
  setStatus(muted ? 'Muted — it can\'t hear you' : 'Live — start talking', !muted);
});

el('replay').addEventListener('click', replayLastTurn);

el('hideTranscript').addEventListener('change', (e) => {
  transcriptEl.classList.toggle('hidden-text', e.target.checked);
});

el('download').addEventListener('click', () => {
  const lines = transcriptLog
    .filter((r) => r.text.trim())
    .map((r) => r.who + ': ' + r.text.trim());
  if (!lines.length) return;
  const header = 'Spanish practice — ' + new Date().toLocaleString() + '\n\n';
  const blob = new Blob([header + lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'spanish-practice-' + new Date().toISOString().slice(0, 10) + '.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.querySelectorAll('#quick button').forEach((btn) => {
  btn.disabled = true;
  btn.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    stopPlayback();
    ws.send(JSON.stringify({ realtimeInput: { text: btn.dataset.say } }));
    const b = bubble('user', 'You');
    appendText(b, btn.dataset.say);
    userBubble = null;
  });
});

function startTimer() {
  startedAt = Date.now();
  el('timer').textContent = '00:00';
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    el('timer').textContent = mm + ':' + ss;
  }, 1000);
}

function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}

/* ---------- Session lifecycle ---------- */

async function start() {
  clearError();
  resetTranscript();
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
    const dialect = DIALECTS[el('dialect').value] || DIALECTS.latam;
    // First message must be the session setup, and nothing else may be sent
    // until the server answers with setupComplete.
    ws.send(JSON.stringify({
      setup: {
        model: 'models/' + model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            // languageCode also pins the transcription language, which stops the
            // transcript drifting into English or other languages.
            languageCode: dialect.lang,
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
      startTimer();
      running = true;
      stopBtn.disabled = false;
      el('download').disabled = false;
      setLiveControls(true);
      setStatus('Live — start talking', true);
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      stopPlayback();
      clearTyping();
      aiBubble = null;
      currentTurnAudio = [];
    }

    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (!userBubble) userBubble = bubble('user', 'You');
      appendText(userBubble, sc.inputTranscription.text);
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      if (userBubble) userBubble = null;
      if (!aiBubble) {
        aiBubble = bubble('ai', 'AI');
        aiBubble.node.classList.add('typing');
      }
      appendText(aiBubble, sc.outputTranscription.text);
    }

    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          const audio = base64ToFloat32(part.inlineData.data);
          currentTurnAudio.push(audio);
          queueForPlayback(audio);
        }
      }
    }

    if (sc.turnComplete) {
      clearTyping();
      if (currentTurnAudio.length) {
        lastTurnAudio = currentTurnAudio;
        currentTurnAudio = [];
        el('replay').disabled = false;
      }
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
    if (muted || !ws || ws.readyState !== WebSocket.OPEN) return;
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
  recordSession(); // must run before the transcript is touched
  stopPlayback();
  stopTimer();
  clearTyping();
  setLiveControls(false);

  if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (micCtx) { micCtx.close().catch(() => {}); micCtx = null; }
  if (playCtx) { playCtx.close().catch(() => {}); playCtx = null; }
  ws = null;

  userBubble = null;
  aiBubble = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  el('replay').disabled = true;
  setStatus('Disconnected', false);
}

function stop() {
  running = false;
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  cleanup();
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
// Closing the tab mid-session still counts the practice time.
window.addEventListener('beforeunload', () => {
  recordSession();
  if (ws) ws.close();
});
