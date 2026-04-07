/**
 * Jarvis Display — immersive voice interface on a dedicated port.
 *
 * Star field background, animated logo reacting to audio volume,
 * real-time text + voice streaming via WebSocket.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '../logger.js';

const log = createLogger('jarvis');

const wssInstances: WebSocketServer[] = [];
let server: http.Server | null = null;

interface JarvisConfig {
  botName: string;
  logoUrl?: string;
  accentColor: string;
  port: number;
  stars?: boolean;
  effects?: { reverb: number; delay: number; delayTime: number };
}

let _html = '';
let _config: JarvisConfig | null = null;

export function startJarvisDisplay(config: JarvisConfig): void {
  const { port, botName, logoUrl, accentColor } = config;
  _config = config;
  _html = buildJarvisHtml(botName, logoUrl, accentColor, config.stars);

  server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/jarvis') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(_html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const localWss = new WebSocketServer({ server });
  wssInstances.push(localWss);

  localWss.on('connection', (ws) => {
    log.info('Jarvis display client connected (local)');
    ws.send(
      JSON.stringify({ type: 'config', botName, accentColor, logoUrl, effects: config.effects }),
    );
    ws.on('close', () => log.info('Jarvis display client disconnected'));
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`Jarvis display running at http://localhost:${port}`);
  });
}

/** Get Jarvis HTML for embedding in the main HTTPS server */
export function getJarvisHtml(): string {
  return _html;
}

/** Attach Jarvis WebSocket to an existing HTTP/HTTPS server */
export function attachJarvisToServer(existingServer: http.Server): void {
  if (!_config) return;
  const { botName, accentColor, logoUrl } = _config;
  const mainWss = new WebSocketServer({ server: existingServer, path: '/jarvis-ws' });
  wssInstances.push(mainWss);
  mainWss.on('connection', (ws) => {
    log.info('Jarvis display client connected (HTTPS)');
    ws.send(
      JSON.stringify({ type: 'config', botName, accentColor, logoUrl, effects: _config?.effects }),
    );
    ws.on('close', () => log.info('Jarvis display client disconnected (HTTPS)'));
  });
}

/** Send text to all connected Jarvis displays */
export function jarvisSendText(text: string): void {
  broadcast({ type: 'text', text, ts: Date.now() });
}

/** Send audio bytes to all connected Jarvis displays */
export function jarvisSendAudio(audioBuffer: Buffer, format: string = 'mp3'): void {
  const base64 = audioBuffer.toString('base64');
  broadcast({ type: 'audio', data: base64, format, ts: Date.now() });
}

/** Send status update (thinking, speaking, idle) */
export function jarvisSendStatus(status: 'idle' | 'thinking' | 'speaking' | 'listening'): void {
  broadcast({ type: 'status', status, ts: Date.now() });
}

/** Check if any Jarvis client is connected */
export function hasJarvisClients(): boolean {
  for (const w of wssInstances) {
    for (const ws of w.clients) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
  }
  return false;
}

function broadcast(data: Record<string, unknown>): void {
  const msg = JSON.stringify(data);
  for (const w of wssInstances) {
    for (const ws of w.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

/** Register an external WSS (created by the main HTTPS server) so broadcast reaches it */
export function registerExternalWss(externalWss: WebSocketServer): void {
  wssInstances.push(externalWss);
  log.info('External WSS registered for Argos Display');
}

/** Get config for sending to newly connected display clients */
export function getJarvisConfig(): Record<string, unknown> | null {
  if (!_config) return null;
  return {
    botName: _config.botName,
    accentColor: _config.accentColor,
    logoUrl: _config.logoUrl,
    effects: _config.effects,
  };
}

export function stopJarvisDisplay(): void {
  for (const w of wssInstances) w.close();
  wssInstances.length = 0;
  server?.close();
  server = null;
}

// ─── HTML ────────────────────────────────────────────────────────────────────

function buildJarvisHtml(botName: string, logoUrl: string | undefined, accent: string, stars = false): string {
  const initial = botName.charAt(0).toUpperCase();
  // Build the core center: either an image or the letter
  const coreContent = logoUrl
    ? `<image href="${logoUrl}" x="48" y="48" width="104" height="104" clip-path="url(#core-clip)" />`
    : `<!-- Letter glow layer -->
      <text x="100" y="125"
        font-family="'Orbitron', 'Arial Black', sans-serif"
        font-weight="900" font-size="72"
        fill="${accent}" text-anchor="middle"
        opacity="0.3" filter="url(#glow-xl)">${initial}</text>
      <!-- Letter main -->
      <text x="100" y="125"
        font-family="'Orbitron', 'Arial Black', sans-serif"
        font-weight="900" font-size="72"
        fill="url(#r-fill)" text-anchor="middle"
        filter="url(#glow-md)">${initial}</text>
      <!-- Letter edge highlight -->
      <text x="100" y="125"
        font-family="'Orbitron', 'Arial Black', sans-serif"
        font-weight="900" font-size="72"
        fill="none" stroke="${accent}"
        stroke-width="0.6" text-anchor="middle"
        opacity="0.7">${initial}</text>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${botName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:wght@300;400;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg: ${stars ? '#050510' : '#ffffff'};
    --text: ${stars ? '#e0e6ff' : '#1a1a2e'};
    --scan-color: ${stars ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.06)'};
    --vignette: ${stars ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.08)'};
    --flicker-color: ${stars ? 'white' : 'black'};
    --flicker-opacity: ${stars ? '0.008' : '0.003'};
  }
  html,body{
    margin:0;padding:0;
    background:transparent;color:var(--text);
    font-family:'JetBrains Mono',monospace;
    overflow:hidden;height:100vh;width:100vw;
    display:flex;flex-direction:column;
    align-items:center;justify-content:center;
  }
  canvas#stars{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:0;display:block}
  /* Ambient neon glow — pulsing */
  .ambient-glow{
    position:fixed;top:50%;left:50%;
    width:700px;height:700px;
    transform:translate(-50%,-50%);
    background:radial-gradient(circle, ${accent}18 0%, ${accent}0a 35%, transparent 65%);
    z-index:2;pointer-events:none;
    animation:ambient-pulse 3.5s ease-in-out infinite;
  }
  @keyframes ambient-pulse{0%,100%{opacity:.7;transform:translate(-50%,-50%) scale(1)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.15)}}
  /* CRT scan lines — visible but not heavy */
  .scanlines{
    position:fixed;top:0;left:0;width:100vw;height:100vh;
    background:repeating-linear-gradient(0deg,
      transparent 0px, transparent 2px,
      var(--scan-color) 2px, var(--scan-color) 4px
    );
    z-index:100;pointer-events:none;
  }
  /* CRT flicker — subtle screen scintillation */
  .crt-flicker{
    position:fixed;top:0;left:0;width:100%;height:100%;
    z-index:99;pointer-events:none;
    animation:crt-flick 0.15s infinite;
    opacity:var(--flicker-opacity);
    background:var(--flicker-color);
  }
  @keyframes crt-flick{
    0%{opacity:var(--flicker-opacity)}
    50%{opacity:calc(var(--flicker-opacity) * 2)}
    100%{opacity:var(--flicker-opacity)}
  }
  /* Vignette — dark edges */
  .vignette{
    position:fixed;top:0;left:0;width:100%;height:100%;
    background:radial-gradient(ellipse at center, transparent 50%, var(--vignette) 100%);
    z-index:98;pointer-events:none;
  }
  .container{
    position:relative;z-index:10;
    display:flex;flex-direction:column;
    align-items:center;gap:1.2rem;
  }
  #logoWrap{
    width:340px;height:340px;
    filter:drop-shadow(0 0 60px ${accent}55) drop-shadow(0 0 120px ${accent}30);
    transition:transform 0.08s ease-out;
  }
  #logoWrap svg{width:100%;height:100%}
  .status{
    font-family:'Orbitron','JetBrains Mono',monospace;
    font-size:1.1rem;font-weight:700;letter-spacing:0.25em;
    color:${accent};text-transform:uppercase;
    text-shadow:0 0 15px ${accent}80, 0 0 30px ${accent}40;
  }
  .synth-bars{
    display:flex;gap:3px;height:48px;
    align-items:flex-end;
  }
  .synth-bars .bar{
    width:4px;border-radius:2px;
    background:linear-gradient(to top, ${accent}40, ${accent});
    box-shadow:0 0 8px ${accent}aa, 0 0 20px ${accent}44;
    transition:height 0.06s ease-out;
  }
  .text-display{
    max-width:700px;max-height:150px;
    overflow-y:auto;
    text-align:center;font-size:1rem;
    line-height:1.8;color:var(--text);
    opacity:0;transition:opacity 0.6s;
    padding:0 2rem;
    text-shadow:0 0 8px ${accent}30;
  }
  .text-display.visible{opacity:1}
  .click-hint{
    position:fixed;bottom:2.5rem;
    font-family:'Orbitron',monospace;
    font-size:0.85rem;font-weight:700;letter-spacing:0.2em;
    color:${accent};text-transform:uppercase;
    text-shadow:0 0 12px ${accent}60;
    animation:pulse-hint 2s ease-in-out infinite;
  }
  @keyframes pulse-hint{0%,100%{opacity:.4}50%{opacity:.9}}
</style>
</head>
<body>
<canvas id="stars"></canvas>
<div class="ambient-glow"></div>
<div class="vignette"></div>
<div class="crt-flicker"></div>
<div class="scanlines"></div>

<div class="container">
  <div id="logoWrap">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
      <defs>
        <filter id="glow-xl" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b1"/>
          <feGaussianBlur stdDeviation="8" result="b2"/>
          <feMerge><feMergeNode in="b2"/><feMergeNode in="b1"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-md" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glow-sm">
          <feGaussianBlur stdDeviation="1.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient id="bg-grad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#001833" stop-opacity="1"/>
          <stop offset="70%" stop-color="#000d1a" stop-opacity="1"/>
          <stop offset="100%" stop-color="#000508" stop-opacity="1"/>
        </radialGradient>
        <linearGradient id="r-fill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${accent}"/>
          <stop offset="50%" stop-color="${accent}cc"/>
          <stop offset="100%" stop-color="${accent}88"/>
        </linearGradient>
        <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${accent}" stop-opacity="0"/>
          <stop offset="40%" stop-color="${accent}" stop-opacity="1"/>
          <stop offset="60%" stop-color="${accent}" stop-opacity="1"/>
          <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
        </linearGradient>
        <clipPath id="circle-clip"><circle cx="100" cy="100" r="96"/></clipPath>
        <clipPath id="core-clip"><circle cx="100" cy="100" r="50"/></clipPath>
      </defs>

      <!-- Outer border circle -->
      <circle cx="100" cy="100" r="98" fill="none" stroke="${accent}" stroke-width="0.5" opacity="0.4"/>
      <circle cx="100" cy="100" r="98" fill="none" stroke="${accent}" stroke-width="0.5" opacity="0.2" filter="url(#glow-md)"/>

      <!-- Background -->
      <circle cx="100" cy="100" r="96" fill="url(#bg-grad)"/>

      <!-- Grid overlay -->
      <g clip-path="url(#circle-clip)" opacity="0.07">
        <line x1="0" y1="25" x2="200" y2="25" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="50" x2="200" y2="50" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="75" x2="200" y2="75" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="125" x2="200" y2="125" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="150" x2="200" y2="150" stroke="${accent}" stroke-width="0.5"/>
        <line x1="0" y1="175" x2="200" y2="175" stroke="${accent}" stroke-width="0.5"/>
        <line x1="25" y1="0" x2="25" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="50" y1="0" x2="50" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="75" y1="0" x2="75" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="125" y1="0" x2="125" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="150" y1="0" x2="150" y2="200" stroke="${accent}" stroke-width="0.5"/>
        <line x1="175" y1="0" x2="175" y2="200" stroke="${accent}" stroke-width="0.5"/>
      </g>

      <!-- Rotating outer dashed ring -->
      <g style="transform-origin:100px 100px;animation:spin-slow 12s linear infinite">
        <circle cx="100" cy="100" r="86" fill="none" stroke="${accent}" stroke-width="1"
          stroke-dasharray="6 3 2 3" opacity="0.5"/>
        <circle cx="100" cy="14" r="3.5" fill="${accent}" filter="url(#glow-md)"/>
        <circle cx="186" cy="100" r="2.5" fill="${accent}" filter="url(#glow-sm)"/>
        <circle cx="100" cy="186" r="3.5" fill="${accent}" filter="url(#glow-md)"/>
        <circle cx="14" cy="100" r="2.5" fill="${accent}" filter="url(#glow-sm)"/>
      </g>

      <!-- Counter-rotating inner ring -->
      <g style="transform-origin:100px 100px;animation:spin-rev 8s linear infinite">
        <circle cx="100" cy="100" r="70" fill="none" stroke="${accent}" stroke-width="0.8"
          stroke-dasharray="14 4 3 4" opacity="0.6"/>
        <polygon points="100,31 103,34 100,37 97,34" fill="${accent}" filter="url(#glow-sm)"/>
        <polygon points="169,100 166,103 169,106 172,103" fill="${accent}" filter="url(#glow-sm)"/>
        <polygon points="100,169 103,166 100,163 97,166" fill="${accent}" filter="url(#glow-sm)"/>
        <polygon points="31,100 34,103 31,106 28,103" fill="${accent}" filter="url(#glow-sm)"/>
      </g>

      <!-- Hex outline -->
      <polygon points="100,44 148,72 148,128 100,156 52,128 52,72"
        fill="none" stroke="${accent}" stroke-width="1.2" opacity="0.5" filter="url(#glow-sm)"/>

      <!-- Inner core circle -->
      <circle cx="100" cy="100" r="52" fill="#000d1f" stroke="${accent}" stroke-width="1.5" opacity="0.9"/>
      <circle cx="100" cy="100" r="52" fill="none" stroke="${accent}" stroke-width="1" filter="url(#glow-md)" opacity="0.5"/>

      <!-- Pulsing aura -->
      <circle cx="100" cy="100" r="52" fill="none" stroke="${accent}" stroke-width="8"
        opacity="0.06" style="animation:aura-pulse 3s ease-in-out infinite"/>

      <!-- Circuit traces -->
      <g stroke="${accent}" stroke-width="0.8" fill="none" opacity="0.5">
        <polyline points="100,44 100,36 115,36 115,28"/>
        <polyline points="148,72 156,68 162,68"/>
        <polyline points="148,128 156,132 162,132"/>
        <polyline points="100,156 100,164 85,164 85,172"/>
        <polyline points="52,128 44,132 38,132"/>
        <polyline points="52,72 44,68 38,68"/>
        <circle cx="115" cy="28" r="2" fill="${accent}"/>
        <circle cx="162" cy="68" r="2" fill="${accent}"/>
        <circle cx="162" cy="132" r="2" fill="${accent}"/>
        <circle cx="85" cy="172" r="2" fill="${accent}"/>
        <circle cx="38" cy="132" r="2" fill="${accent}"/>
        <circle cx="38" cy="68" r="2" fill="${accent}"/>
      </g>

      <!-- Core content (letter or image) -->
      ${coreContent}

      <!-- Corner HUD marks -->
      <g stroke="${accent}" stroke-width="1.5" fill="none" opacity="0.7">
        <polyline points="12,28 12,12 28,12" filter="url(#glow-sm)"/>
        <polyline points="188,28 188,12 172,12" filter="url(#glow-sm)"/>
        <polyline points="12,172 12,188 28,188" filter="url(#glow-sm)"/>
        <polyline points="188,172 188,188 172,188" filter="url(#glow-sm)"/>
      </g>

      <!-- Bottom label — glow layer -->
      <text x="100" y="184"
        font-family="'Orbitron','Arial Black',sans-serif"
        font-weight="700" font-size="11" fill="${accent}"
        text-anchor="middle" letter-spacing="4"
        opacity="0.3" filter="url(#glow-md)">${botName.toUpperCase()}</text>
      <!-- Bottom label — main -->
      <text x="100" y="184"
        font-family="'Orbitron','Arial Black',sans-serif"
        font-weight="700" font-size="11" fill="${accent}"
        text-anchor="middle" letter-spacing="4"
        stroke="white" stroke-width="0.3" opacity="0.9">${botName.toUpperCase()}</text>

      <style>
        @keyframes spin-slow{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes spin-rev{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}
        @keyframes aura-pulse{0%,100%{opacity:.04}50%{opacity:.14}}
      </style>
    </svg>
  </div>

  <div class="status" id="status">ONLINE</div>
  <div class="synth-bars" id="synthBars"></div>
  <div class="text-display" id="textDisplay"></div>
</div>

<div class="click-hint" id="clickHint">Click anywhere to activate audio</div>

<script>
(function(){
// ── Star field (canvas) ───────────────────────────────────────────────
const STARS_ENABLED = ${stars ? 'true' : 'false'};
const canvas = document.getElementById('stars');
const ctx = canvas.getContext('2d');
let stars = [];
const STAR_COUNT = 500;

function initStars(){
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  stars = [];
  for(let i = 0; i < STAR_COUNT; i++){
    const isBig = Math.random() < 0.03; // 3% big bright stars
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: isBig ? (Math.random() * 2 + 1.5) : (Math.random() * 1.2 + 0.3),
      speed: Math.random() * 0.2 + 0.02,
      alpha: isBig ? (Math.random() * 0.3 + 0.7) : (Math.random() * 0.6 + 0.3),
      twinkleSpeed: (Math.random() * 0.02 + 0.008) * (Math.random() < 0.5 ? 1 : -1),
      isBig: isBig,
      hue: isBig ? Math.random() * 40 + 200 : 0, // blue-ish tint for big stars
    });
  }
}

function drawStars(){
  ctx.fillStyle = STARS_ENABLED ? '#050510' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if(!STARS_ENABLED){ requestAnimationFrame(drawStars); return; }
  for(const s of stars){
    s.alpha += s.twinkleSpeed;
    if(s.alpha > 1){ s.alpha = 1; s.twinkleSpeed *= -1; }
    if(s.alpha < 0.2){ s.alpha = 0.2; s.twinkleSpeed *= -1; }
    s.y -= s.speed;
    if(s.y < -5){ s.y = canvas.height + 5; s.x = Math.random() * canvas.width; }
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    if(s.isBig){
      // Bright star with glow
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 3);
      grad.addColorStop(0, 'rgba(200,220,255,' + (s.alpha).toFixed(3) + ')');
      grad.addColorStop(0.4, 'rgba(150,180,255,' + (s.alpha * 0.4).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(100,140,255,0)');
      ctx.fillStyle = grad;
      ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
    } else {
      ctx.fillStyle = 'rgba(200,215,255,' + s.alpha.toFixed(3) + ')';
    }
    ctx.fill();
  }
  requestAnimationFrame(drawStars);
}

initStars();
drawStars();
window.addEventListener('resize', initStars);

// ── Synth bars (32 bars) ───────────────────────────────────────────────
const barsContainer = document.getElementById('synthBars');
const BAR_COUNT = 32;
for(let i = 0; i < BAR_COUNT; i++){
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.height = '2px';
  barsContainer.appendChild(bar);
}
const bars = barsContainer.querySelectorAll('.bar');

function setBarLevels(levels){
  for(let i = 0; i < bars.length; i++){
    const h = Math.max(2, (levels[i] || 0) * 48);
    bars[i].style.height = h + 'px';
  }
}

// ── Audio engine (Web Audio API) ───────────────────────────────────────
let audioCtx = null;
let analyser = null;
let freqData = null;
let dryGain = null, delayNode = null, delayGain = null, convolverNode = null, reverbGain = null;
let fxReverb = 0, fxDelay = 0, fxDelayTime = 0.3;
let audioReady = false;

function initAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 64;
  freqData = new Uint8Array(analyser.frequencyBinCount);

  // Dry path: source → dryGain → analyser → destination
  dryGain = audioCtx.createGain();
  dryGain.connect(analyser);
  analyser.connect(audioCtx.destination);

  // Delay
  delayNode = audioCtx.createDelay(2);
  delayNode.delayTime.value = fxDelayTime;
  delayGain = audioCtx.createGain();
  delayGain.gain.value = fxDelay / 100;
  delayNode.connect(delayGain);
  delayGain.connect(analyser);

  // Reverb (convolution with generated impulse response, 2s decay)
  try{
    const len = audioCtx.sampleRate * 2;
    const impulse = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
    for(let ch = 0; ch < 2; ch++){
      const d = impulse.getChannelData(ch);
      for(let i = 0; i < len; i++){
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      }
    }
    convolverNode = audioCtx.createConvolver();
    convolverNode.buffer = impulse;
    reverbGain = audioCtx.createGain();
    reverbGain.gain.value = fxReverb / 100;
    convolverNode.connect(reverbGain);
    reverbGain.connect(analyser);
  }catch(e){ console.warn('Reverb init failed:', e); }

  audioReady = true;
  const hint = document.getElementById('clickHint');
  if(hint) hint.style.display = 'none';
}

function updateEffects(effects){
  if(!effects) return;
  fxReverb = effects.reverb ?? 0;
  fxDelay = effects.delay ?? 0;
  fxDelayTime = effects.delayTime ?? 0.3;
  if(delayNode) delayNode.delayTime.value = fxDelayTime;
  if(delayGain) delayGain.gain.value = fxDelay / 100;
  if(reverbGain) reverbGain.gain.value = fxReverb / 100;
}

// ── Animation loop (60fps) ─────────────────────────────────────────────
const logoWrap = document.getElementById('logoWrap');
let animating = false;

function animateVolume(){
  if(!animating || !analyser) return;
  analyser.getByteFrequencyData(freqData);
  const levels = [];
  for(let i = 0; i < BAR_COUNT; i++){
    levels.push((freqData[i] || 0) / 255);
  }
  setBarLevels(levels);

  // Scale logo based on average volume (1.0 to 1.15)
  let sum = 0;
  for(let i = 0; i < levels.length; i++) sum += levels[i];
  const avg = sum / levels.length;
  const scale = 1 + avg * 0.15;
  logoWrap.style.transform = 'scale(' + scale.toFixed(4) + ')';

  requestAnimationFrame(animateVolume);
}

// ── Audio playback ─────────────────────────────────────────────────────
let currentSource = null;
let currentFadeTimeout = null;

function stopCurrentAudio(){
  if(currentSource){
    try { currentSource.onended = null; currentSource.stop(0); } catch(e){}
    try { currentSource.disconnect(); } catch(e){}
    currentSource = null;
  }
  if(currentFadeTimeout){
    clearTimeout(currentFadeTimeout);
    currentFadeTimeout = null;
  }
}

async function playAudio(base64, format){
  if(!audioCtx) initAudio();
  if(audioCtx.state === 'suspended') await audioCtx.resume();

  // Cut current audio — new message takes precedence
  stopCurrentAudio();

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  try{
    const buffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    currentSource = source;

    source.connect(dryGain);
    if(delayNode) source.connect(delayNode);
    if(convolverNode) source.connect(convolverNode);

    setStatusUI('speaking');
    animating = true;
    animateVolume();

    source.onended = function(){
      if(currentSource === source) currentSource = null;
      // Gradual fade-out: keep animating for 1.5s (reverb/delay tail)
      currentFadeTimeout = setTimeout(function(){
        animating = false;
        // Smooth bar fade-out over 500ms
        var fadeSteps = 10;
        var step = 0;
        var fadeInterval = setInterval(function(){
          step++;
          var factor = 1 - (step / fadeSteps);
          if(factor <= 0){
            clearInterval(fadeInterval);
            setBarLevels(new Array(BAR_COUNT).fill(0));
            logoWrap.style.transform = 'scale(1)';
            setStatusUI('idle');
          } else {
            // Reduce current bar levels gradually
            if(analyser && freqData){
              analyser.getByteFrequencyData(freqData);
              var levels = [];
              for(var i=0;i<BAR_COUNT;i++) levels.push((freqData[i]||0)/255*factor);
              setBarLevels(levels);
              logoWrap.style.transform = 'scale(' + (1 + factor * 0.05) + ')';
            }
          }
        }, 50);
      }, 1500);
    };
    source.start();
  }catch(e){
    console.error('Audio decode error:', e);
    setStatusUI('idle');
  }
}

// ── UI updates ─────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');
const textEl = document.getElementById('textDisplay');
let textTimer = null;

function setStatusUI(status){
  const label = {idle:'ONLINE', thinking:'THINKING', speaking:'SPEAKING', listening:'LISTENING'}[status] || status.toUpperCase();
  statusEl.textContent = label;
}

function showText(text){
  textEl.textContent = text;
  textEl.className = 'text-display visible';
  if(textTimer) clearTimeout(textTimer);
  // Duration based on word count: ~200ms per word, min 5s, max 60s
  var words = text.split(/\s+/).length;
  var duration = Math.max(5000, Math.min(60000, words * 200 + 3000));
  textTimer = setTimeout(function(){ textEl.className = 'text-display'; }, duration);
}

// ── WebSocket ──────────────────────────────────────────────────────────
function connectWS(){
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsPath = location.pathname.startsWith('/display') ? '/jarvis-ws' : '';
  const ws = new WebSocket(proto + '//' + location.host + wsPath);

  ws.onmessage = function(e){
    try{
    const msg = JSON.parse(e.data);
    switch(msg.type){
      case 'config':
        document.title = msg.botName || document.title;
        try{ if(msg.effects) updateEffects(msg.effects); }catch(err){ console.warn('effects error',err); }
        break;
      case 'text':
        showText(msg.text);
        break;
      case 'audio':
        if(!audioCtx) initAudio();
        playAudio(msg.data, msg.format);
        break;
      case 'status':
        setStatusUI(msg.status);
        break;
    }
    }catch(err){ console.error('WS message error:', err); }
  };

  ws.onclose = function(){
    statusEl.textContent = 'DISCONNECTED';
    setTimeout(connectWS, 5000);
  };

  ws.onerror = function(){
    ws.close();
  };
}

connectWS();

// ── Init audio immediately + resume on interaction ──────────────────────
initAudio();
// Browsers block autoplay until user interaction — resume on any click/touch/key
['click','touchstart','keydown'].forEach(function(evt){
  document.addEventListener(evt, function(){
    if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    var hint = document.getElementById('clickHint');
    if(hint) hint.style.display = 'none';
  }, { once: true });
});

})();
</script>
</body>
</html>`;
}
