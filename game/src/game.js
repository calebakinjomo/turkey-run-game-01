// Gobble Run: Thanksgiving Escape — an original side-scrolling farmyard chase.
// Tom the turkey has escaped the pen on Thanksgiving morning. Outrun the farmer across
// the farm to the safety of the forest 1000 m away: jump fences, hay bales and the oven,
// slide under low branches, dodge falling carving knives, grab corn on the way.
// All art is drawn in code on a 2D canvas; all sound is synthesized WebAudio.
// No external files, no network requests. Keyboard + mouse/touch controls.
// Deterministic screenshot staging: ?shot=start|play|end|escaped&seed=N freezes a
// staged scene so screenshots are identical on every run.

(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const testEl = document.getElementById('testout');

  const W = 960, H = 540;
  const GROUND_Y = 468;
  const GOAL_M = 1000;
  const PX_PER_M = 40;
  const GRAVITY = 2400;
  const JUMP_V = -835;

  const params = new URLSearchParams(location.search);
  const shotMode = params.get('shot');           // 'start' | 'play' | 'end' | 'escaped' | null
  const seedParam = Number(params.get('seed') || 1) || 1;

  // Seeded RNG (mulberry32) so staged scenes and world generation are deterministic.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(seedParam * 2654435761);

  // ---- error capture (for headless verification) ----
  window.__errors = [];
  window.addEventListener('error', (e) => { window.__errors.push(String(e.message || e.error)); });
  const origConsoleError = console.error.bind(console);
  console.error = (...a) => { window.__errors.push(a.map(String).join(' ')); origConsoleError(...a); };

  // ---- audio: synthesized WebAudio, no files ----
  let audioCtx = null, muted = false;
  function audio() {
    if (muted || shotMode) return null;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      return audioCtx;
    } catch { return null; }
  }
  function tone(freq, dur, type, vol, slideTo, delay) {
    const ac = audio(); if (!ac) return;
    try {
      const t0 = ac.currentTime + (delay || 0);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(ac.destination);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch { /* sound must never block play */ }
  }
  function noiseBurst(dur, vol, low) {
    const ac = audio(); if (!ac) return;
    try {
      const n = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, n, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ac.createBufferSource(); src.buffer = buf;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = low || 900;
      const g = ac.createGain(); g.gain.value = vol || 0.2;
      src.connect(f); f.connect(g); g.connect(ac.destination); src.start();
    } catch { /* ignore */ }
  }
  const sfx = {
    jump() { tone(520, 0.12, 'square', 0.07, 880); tone(660, 0.1, 'square', 0.05, 990, 0.05); },
    gobble() { tone(300, 0.07, 'square', 0.08, 210); tone(260, 0.07, 'square', 0.08, 180, 0.07); tone(300, 0.08, 'square', 0.08, 200, 0.14); },
    cluck() { tone(880, 0.06, 'triangle', 0.1, 1320); },
    feather() { tone(660, 0.09, 'sine', 0.1, 990); tone(990, 0.12, 'sine', 0.1, 1320, 0.09); },
    thud() { tone(140, 0.22, 'sine', 0.22, 55); noiseBurst(0.15, 0.18, 500); },
    caught() { tone(392, 0.25, 'sawtooth', 0.09, 370); tone(311, 0.25, 'sawtooth', 0.09, 294, 0.25); tone(233, 0.5, 'sawtooth', 0.1, 220, 0.5); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, null, i * 0.13)); tone(1319, 0.4, 'triangle', 0.1, null, 0.55); },
    click() { tone(700, 0.05, 'square', 0.05); },
  };

  // ---- game state ----
  const S = {
    state: 'title',           // title | play | paused | caught | escaped
    time: 0,                  // global animation clock
    distancePx: 0,
    score: 0,
    lives: 3,
    speed: 0,
    turkey: { x: 190, y: 0, vy: 0, sliding: false, slideT: 0, runPhase: 0, invuln: 0, dead: false },
    obstacles: [],
    pickups: [],
    particles: [],
    leaves: [],
    spawnIn: 420,
    shake: 0,
    endReason: '',
    flash: 0,
    scoreBonus: 0,
  };
  let best = 0;
  try { best = Number(localStorage.getItem('gobble-run-best') || 0) || 0; } catch { best = 0; }

  function distanceM() { return S.distancePx / PX_PER_M; }
  function speedNow() { return Math.min(620, 250 + distanceM() * 0.36); }

  function reset() {
    S.state = 'play';
    S.distancePx = 0; S.score = 0; S.scoreBonus = 0; S.lives = 3;
    S.obstacles = []; S.pickups = []; S.particles = [];
    S.spawnIn = 520;
    S.turkey = { x: 190, y: 0, vy: 0, sliding: false, slideT: 0, runPhase: 0, invuln: 0, dead: false };
    S.shake = 0; S.flash = 0; S.endReason = '';
    rng = mulberry32(seedParam * 2654435761 + 7);
    setStatus('Running! Jump the fences, slide under branches, dodge the knives.');
  }

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  // ---- spawning ----
  const OBSTACLE_KINDS = ['fence', 'hay', 'branch', 'oven', 'knife', 'fence', 'hay', 'branch'];
  function spawnObstacle() {
    const kind = OBSTACLE_KINDS[Math.floor(rng() * OBSTACLE_KINDS.length)];
    const x = W + 80 + rng() * 120;
    if (kind === 'knife') {
      S.obstacles.push({ kind, x: x + 140, targetX: x + 140, tipY: -40, phase: 'warn', t: 0, hit: false });
    } else {
      S.obstacles.push({ kind, x, hit: false });
    }
    // Corn: an arc over jumpable obstacles, a ground line after branches.
    const n = 3 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const cx = x + 30 + i * 34;
      const cy = kind === 'branch' ? GROUND_Y - 26 : GROUND_Y - 96 - Math.sin((i / (n - 1)) * Math.PI) * 46;
      S.pickups.push({ kind: 'corn', x: cx, y: cy, taken: false, bob: rng() * 6.28 });
    }
    if (rng() < 0.16) {
      S.pickups.push({ kind: 'feather', x: x + 200 + rng() * 120, y: GROUND_Y - 150 - rng() * 40, taken: false, bob: rng() * 6.28 });
    }
    S.spawnIn = 300 + rng() * 300;
  }

  // ---- particles ----
  function burst(x, y, n, colors, speed, up) {
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      S.particles.push({
        x, y, vx: Math.cos(a) * speed * (0.4 + rng() * 0.8),
        vy: Math.sin(a) * speed * 0.6 - (up || 60),
        life: 0.6 + rng() * 0.7, t: 0,
        color: colors[Math.floor(rng() * colors.length)],
        size: 2 + rng() * 4, spin: rng() * 6.28, vr: (rng() - 0.5) * 8,
      });
    }
  }
  function initLeaves() {
    S.leaves = [];
    for (let i = 0; i < 26; i++) {
      S.leaves.push({
        x: rng() * W, y: rng() * H * 0.7, s: 3 + rng() * 5,
        vy: 12 + rng() * 22, vx: 8 + rng() * 18, ph: rng() * 6.28,
        color: ['#e07840', '#d9a441', '#b4552d', '#c97b2e'][Math.floor(rng() * 4)],
      });
    }
  }
  initLeaves();

  // ---- collision boxes ----
  function turkeyBox() {
    const t = S.turkey;
    const h = t.sliding ? 26 : 52;
    return { x: t.x + 4, y: GROUND_Y + t.y - h, w: 50, h };
  }
  function obstacleBox(o) {
    if (o.kind === 'fence') return { x: o.x, y: GROUND_Y - 62, w: 26, h: 62 };
    if (o.kind === 'hay') return { x: o.x, y: GROUND_Y - 48, w: 56, h: 48 };
    if (o.kind === 'branch') return { x: o.x - 6, y: GROUND_Y - 58, w: 96, h: 12 };
    if (o.kind === 'oven') return { x: o.x, y: GROUND_Y - 108, w: 92, h: 108 };
    if (o.kind === 'knife') {
      if (o.phase === 'stuck') return { x: o.targetX - 7, y: GROUND_Y - 66, w: 14, h: 66 };
      if (o.phase === 'fall' && o.tipY > GROUND_Y - 150) return { x: o.targetX - 7, y: o.tipY - 74, w: 14, h: 74 };
      return null;
    }
    return null;
  }
  function overlap(a, b) {
    return a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ---- hits, pickups, end states ----
  function onHit(o) {
    if (S.turkey.invuln > 0 || S.state !== 'play') return;
    o.hit = true;
    S.lives -= 1;
    S.turkey.invuln = 1.3;
    S.shake = 9; S.flash = 0.35;
    sfx.thud();
    burst(S.turkey.x + 30, GROUND_Y + S.turkey.y - 30, 16, ['#ffffff', '#e8c88a', '#b4552d', '#7a4a21'], 190, 120);
    setStatus(S.lives > 0 ? `Ouch! ${S.lives} ${S.lives === 1 ? 'life' : 'lives'} left — the farmer is closing in!` : 'Caught!');
    if (S.lives <= 0) endGame('caught');
  }
  function endGame(kind) {
    S.state = kind;
    const m = Math.floor(distanceM());
    if (m > best) { best = m; try { localStorage.setItem('gobble-run-best', String(best)); } catch { /* ignore */ } }
    if (kind === 'caught') { sfx.caught(); S.endReason = 'The farmer caught Tom!'; setStatus(`Caught! You ran ${m} m and scored ${S.score}. Press R to run again.`); }
    else { sfx.win(); S.endReason = 'Tom reached the forest — free at last!'; setStatus(`Escaped! You ran ${m} m and scored ${S.score}. Press R to run again.`); burst(S.turkey.x + 30, GROUND_Y - 90, 40, ['#ffd76a', '#ff9d5c', '#7ec850', '#ffffff'], 260, 180); }
  }

  // ---- update ----
  function update(dt) {
    S.time += dt;
    if (S.state === 'title') {
      S.turkey.runPhase += dt * 9;
      for (const l of S.leaves) { l.x -= (l.vx + 30) * dt; l.y += l.vy * dt; l.ph += dt * 2; if (l.y > H) { l.y = -10; l.x = rng() * W; } if (l.x < -20) l.x = W + 10; }
      return;
    }
    if (S.state !== 'play') {
      for (const p of S.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.spin += p.vr * dt; }
      S.particles = S.particles.filter((p) => p.t < p.life);
      return;
    }

    const speed = speedNow();
    S.speed = speed;
    S.distancePx += speed * dt;
    S.score = Math.floor(distanceM()) + S.scoreBonus;
    const t = S.turkey;
    t.runPhase += dt * (7 + speed / 60);
    if (t.invuln > 0) t.invuln -= dt;
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 30);
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 1.4);

    // vertical physics
    if (t.y < 0 || t.vy !== 0) {
      t.vy += GRAVITY * dt;
      t.y += t.vy * dt;
      if (t.y >= 0) { t.y = 0; t.vy = 0; if (t.wasAir) { burst(t.x + 20, GROUND_Y, 6, ['#c9a06a', '#a67c52'], 70, 40); t.wasAir = false; } }
      else t.wasAir = true;
    }
    // slide timer
    if (t.sliding) { t.slideT -= dt; if (t.slideT <= 0) t.sliding = false; }
    // dust while running on the ground
    if (t.y === 0 && rng() < dt * 14) {
      S.particles.push({ x: t.x + 6, y: GROUND_Y - 2, vx: -60 - rng() * 60, vy: -20 - rng() * 40, life: 0.5, t: 0, color: '#c9a06a', size: 2 + rng() * 3, spin: 0, vr: 0 });
    }
    // leaves drift
    for (const l of S.leaves) { l.x -= (l.vx + speed * 0.25) * dt; l.y += l.vy * dt; l.ph += dt * 2; if (l.y > H) { l.y = -10; l.x = rng() * W; } if (l.x < -20) l.x = W + 10; }

    // spawn
    S.spawnIn -= speed * dt;
    if (S.spawnIn <= 0) spawnObstacle();

    // obstacles
    for (const o of S.obstacles) {
      o.x -= speed * dt;
      if (o.kind === 'knife') {
        o.t += dt;
        if (o.phase === 'warn' && o.t > 0.55) { o.phase = 'fall'; o.t = 0; }
        else if (o.phase === 'fall') { o.tipY += 1500 * dt; if (o.tipY >= GROUND_Y - 6) { o.tipY = GROUND_Y - 6; o.phase = 'stuck'; o.t = 0; noiseBurst(0.08, 0.1, 1200); } }
        else if (o.phase === 'stuck' && o.t > 0.9) { o.phase = 'gone'; }
      }
    }
    S.obstacles = S.obstacles.filter((o) => o.x > -160 && o.phase !== 'gone');

    // pickups
    for (const p of S.pickups) { p.x -= speed * dt; p.bob += dt * 3; }
    S.pickups = S.pickups.filter((p) => p.x > -60 && !p.taken);

    // particles
    for (const p of S.particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 320 * dt; p.spin += p.vr * dt; }
    S.particles = S.particles.filter((p) => p.t < p.life);

    // collisions
    const tb = turkeyBox();
    for (const o of S.obstacles) {
      if (!o.hit && overlap(tb, obstacleBox(o))) { onHit(o); if (S.state !== 'play') break; }
    }
    if (S.state === 'play') {
      for (const p of S.pickups) {
        if (!p.taken && Math.abs(p.x - (S.turkey.x + 30)) < 34 && Math.abs(p.y - (GROUND_Y + S.turkey.y - 30)) < 38) {
          p.taken = true;
          if (p.kind === 'corn') { S.scoreBonus += 25; sfx.cluck(); burst(p.x, p.y, 8, ['#ffd76a', '#ffb347'], 120, 90); }
          else { S.scoreBonus += 150; sfx.feather(); burst(p.x, p.y, 14, ['#ffd76a', '#ffffff', '#ff9d5c'], 160, 120); }
        }
      }
    }

    // win check
    if (distanceM() >= GOAL_M) endGame('escaped');
  }

  // ---- input ----
  function doJump() {
    if (S.state === 'title') { sfx.click(); reset(); return; }
    if (S.state === 'caught' || S.state === 'escaped') { sfx.click(); reset(); return; }
    if (S.state !== 'play') return;
    const t = S.turkey;
    if (t.y === 0 && t.vy === 0) { t.vy = JUMP_V; t.sliding = false; sfx.jump(); }
  }
  function doSlide() {
    if (S.state !== 'play') return;
    const t = S.turkey;
    if (t.y === 0) { t.sliding = true; t.slideT = 0.55; }
  }
  function togglePause() {
    if (S.state === 'play') { S.state = 'paused'; setStatus('Paused. Press P to keep running.'); }
    else if (S.state === 'paused') { S.state = 'play'; setStatus('Running!'); }
  }
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { e.preventDefault(); doJump(); }
    else if (e.code === 'ArrowDown' || e.code === 'KeyS') { e.preventDefault(); doSlide(); }
    else if (e.code === 'KeyP') togglePause();
    else if (e.code === 'KeyR') { if (S.state === 'caught' || S.state === 'escaped' || S.state === 'paused') { sfx.click(); reset(); } }
    else if (e.code === 'KeyM') { muted = !muted; setStatus(muted ? 'Sound off.' : 'Sound on.'); }
  });
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (S.state === 'title' || S.state === 'caught' || S.state === 'escaped') { doJump(); return; }
    // bottom half of the screen = slide, top half = jump (mouse/touch players)
    if (e.clientY > window.innerHeight * 0.62) doSlide(); else doJump();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.state === 'play') togglePause(); });
  window.addEventListener('blur', () => { if (S.state === 'play' && !shotMode) togglePause(); });

  // ================= RENDERING =================
  function fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = window.innerWidth, ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    // Scale the logical 960x540 stage to fit, centred (letterboxed).
    const s = Math.min(canvas.width / W, canvas.height / H);
    const tx = (canvas.width - W * s) / 2, ty = (canvas.height - H * s) / 2;
    ctx.setTransform(s, 0, 0, s, tx, ty);
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function ellipse(x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
  function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  // Parallax offsets derived from distance so the world scrolls with the run.
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3d1e4d');
    g.addColorStop(0.35, '#8a3b4d');
    g.addColorStop(0.62, '#e07840');
    g.addColorStop(0.85, '#f7b267');
    g.addColorStop(1, '#f7c873');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // low sun
    const sx = 760, sy = 330;
    const sg = ctx.createRadialGradient(sx, sy, 10, sx, sy, 150);
    sg.addColorStop(0, 'rgba(255, 236, 170, 0.95)');
    sg.addColorStop(0.35, 'rgba(255, 190, 90, 0.55)');
    sg.addColorStop(1, 'rgba(255, 190, 90, 0)');
    ctx.fillStyle = sg; ctx.fillRect(sx - 160, sy - 160, 320, 320);
    ctx.fillStyle = '#ffdf8a'; circle(sx, sy, 42);
    // clouds
    ctx.fillStyle = 'rgba(255, 214, 170, 0.5)';
    const coff = (S.distancePx * 0.05) % (W + 300);
    for (let i = 0; i < 4; i++) {
      const cx = ((i * 317 + 90 - coff) % (W + 300) + W + 300) % (W + 300) - 150;
      const cy = 56 + i * 34;
      ellipse(cx, cy, 62, 15); ellipse(cx + 34, cy + 6, 44, 12); ellipse(cx - 38, cy + 7, 38, 11);
    }
  }
  function drawHills() {
    const off = (S.distancePx * 0.12) % 480;
    ctx.fillStyle = '#6b3a52';
    ctx.beginPath(); ctx.moveTo(0, GROUND_Y);
    for (let x = -480; x <= W + 480; x += 60) {
      const px = x - off;
      const py = GROUND_Y - 60 - Math.sin((x * 0.021) + 1.2) * 34 - Math.sin(x * 0.008) * 22;
      ctx.lineTo(px, py);
    }
    ctx.lineTo(W, GROUND_Y); ctx.closePath(); ctx.fill();
    // tree line
    ctx.fillStyle = '#4a2a3e';
    for (let i = 0; i < 14; i++) {
      const tx = ((i * 173 + 40 - S.distancePx * 0.22) % (W + 120) + W + 120) % (W + 120) - 60;
      const th = 34 + ((i * 37) % 26);
      ctx.beginPath(); ctx.moveTo(tx, GROUND_Y - 46 - th); ctx.lineTo(tx - 16, GROUND_Y - 46); ctx.lineTo(tx + 16, GROUND_Y - 46); ctx.closePath(); ctx.fill();
    }
  }
  function drawBarnAndFence() {
    const off = (S.distancePx * 0.45) % 960;
    // red barn, far side of the field
    const bx = 700 - off;
    if (bx > -260 && bx < W + 60) {
      ctx.fillStyle = '#8e2f26';
      ctx.fillRect(bx, GROUND_Y - 150, 190, 110);
      ctx.beginPath(); ctx.moveTo(bx - 12, GROUND_Y - 150); ctx.lineTo(bx + 95, GROUND_Y - 205); ctx.lineTo(bx + 202, GROUND_Y - 150); ctx.closePath();
      ctx.fillStyle = '#6e211b'; ctx.fill();
      ctx.fillStyle = '#f7c873'; ctx.fillRect(bx + 78, GROUND_Y - 96, 34, 56);
      ctx.strokeStyle = '#f7c873'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(bx + 78, GROUND_Y - 68); ctx.lineTo(bx + 112, GROUND_Y - 68); ctx.moveTo(bx + 95, GROUND_Y - 96); ctx.lineTo(bx + 95, GROUND_Y - 40); ctx.stroke();
      ctx.fillStyle = '#3a1c14'; ctx.fillRect(bx + 18, GROUND_Y - 132, 30, 26); ctx.fillRect(bx + 142, GROUND_Y - 132, 30, 26);
    }
    // fence posts marching past
    ctx.fillStyle = '#7a4a21';
    const foff = (S.distancePx * 1) % 120;
    for (let x = -foff; x < W + 120; x += 120) {
      ctx.fillRect(x, GROUND_Y - 44, 8, 44);
      ctx.fillRect(x - 4, GROUND_Y - 48, 16, 6);
    }
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(0, GROUND_Y - 30, W, 5);
    ctx.fillRect(0, GROUND_Y - 16, W, 4);
  }
  function drawGround() {
    ctx.fillStyle = '#5d3a1e'; ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = '#7a4f27'; ctx.fillRect(0, GROUND_Y, W, 10);
    ctx.fillStyle = '#8fae4e'; ctx.fillRect(0, GROUND_Y - 4, W, 8);
    // grass tufts + pebbles scrolling with the world
    const off = S.distancePx % 90;
    ctx.fillStyle = '#6f8f3a';
    for (let x = -off; x < W + 90; x += 90) {
      ctx.beginPath(); ctx.moveTo(x, GROUND_Y - 2); ctx.lineTo(x + 3, GROUND_Y - 12); ctx.lineTo(x + 6, GROUND_Y - 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(x + 44, GROUND_Y - 2); ctx.lineTo(x + 47, GROUND_Y - 10); ctx.lineTo(x + 50, GROUND_Y - 2); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#4a2c14';
    for (let x = -off; x < W + 90; x += 90) {
      ellipse(x + 62, GROUND_Y + 34, 5, 3); ellipse(x + 22, GROUND_Y + 56, 4, 2.5);
    }
  }

  function drawTurkey(x, groundContactY, opts) {
    const o = opts || {};
    const ph = S.time * 10 + (o.phase || 0);
    const air = o.air || false;
    const sliding = !!o.sliding;
    const blink = o.invuln && Math.floor(S.time * 14) % 2 === 0;
    ctx.save();
    if (blink) ctx.globalAlpha = 0.35;
    ctx.translate(x, groundContactY);
    if (sliding) {
      // low crouch, legs stretched forward, tail up
      ctx.fillStyle = '#7a4a21'; ellipse(6, -14, 26, 13);           // body low
      ctx.fillStyle = '#5d3413'; ellipse(-18, -22, 14, 7);          // tail
      ctx.fillStyle = '#8a5a2b'; circle(30, -20, 11);               // head
      ctx.fillStyle = '#f7b267'; ctx.beginPath(); ctx.moveTo(40, -22); ctx.lineTo(52, -18); ctx.lineTo(40, -15); ctx.closePath(); ctx.fill(); // beak
      ctx.fillStyle = '#c0392b'; ellipse(34, -12, 3, 5);            // wattle
      ctx.fillStyle = '#2a1608'; circle(32, -24, 2.2);              // eye
      ctx.strokeStyle = '#e8a34c'; ctx.lineWidth = 4;               // legs forward
      ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(22, 0); ctx.moveTo(-6, -6); ctx.lineTo(14, 0); ctx.stroke();
    } else {
      const legSwing = air ? 0.5 : Math.sin(ph);
      const legSwing2 = air ? -0.4 : Math.sin(ph + Math.PI);
      // legs
      ctx.strokeStyle = '#e8a34c'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-4, -16); ctx.lineTo(-4 + legSwing * 12, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(8, -16); ctx.lineTo(8 + legSwing2 * 12, 0); ctx.stroke();
      // tail fan
      const fan = air ? 0.9 : 0.55 + Math.sin(ph * 0.5) * 0.06;
      for (let i = -2; i <= 2; i++) {
        const a = -Math.PI / 2 + i * 0.34 * fan * 2.4;
        const fx = -22 + Math.cos(a) * 30, fy = -30 + Math.sin(a) * 30;
        ctx.strokeStyle = i === 0 ? '#8a5a2b' : '#a06a35'; ctx.lineWidth = 9; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-16, -28); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.fillStyle = i % 2 ? '#c97b2e' : '#7a4a21'; circle(fx, fy, 5);
      }
      // body
      ctx.fillStyle = '#7a4a21'; ellipse(4, -28, 26, 20);
      ctx.fillStyle = '#8a5a2b'; ellipse(10, -24, 18, 13);
      // wing (flaps)
      const flap = air ? Math.sin(S.time * 22) * 0.9 : Math.sin(ph) * 0.35;
      ctx.save(); ctx.translate(2, -30); ctx.rotate(-0.5 - flap * 0.5);
      ctx.fillStyle = '#5d3413'; ellipse(-8, -4, 16, 7); ctx.restore();
      // neck + head
      ctx.fillStyle = '#8a5a2b'; ctx.fillRect(24, -52, 9, 26);
      ctx.fillStyle = '#c97b2e'; circle(30, -54, 11);
      ctx.fillStyle = '#e07840'; circle(30, -62, 4);               // snood
      ctx.fillStyle = '#f7b267'; ctx.beginPath(); ctx.moveTo(40, -56); ctx.lineTo(53, -52); ctx.lineTo(40, -48); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c0392b'; ellipse(36, -44, 3.5, 6);          // wattle
      ctx.fillStyle = '#1d0f04'; circle(33, -57, 2.4);              // eye
      ctx.fillStyle = '#fff'; circle(34, -58, 0.9);
    }
    ctx.restore();
  }

  function drawFarmer(x, groundContactY, phase) {
    ctx.save(); ctx.translate(x, groundContactY);
    const s1 = Math.sin(phase), s2 = Math.sin(phase + Math.PI);
    // legs (running)
    ctx.strokeStyle = '#2e4a6b'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-2, -34); ctx.lineTo(-2 + s1 * 14, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, -34); ctx.lineTo(8 + s2 * 14, 0); ctx.stroke();
    // overalls
    ctx.fillStyle = '#2e4a6b'; ctx.fillRect(-12, -72, 28, 40);
    ctx.fillStyle = '#b03a2e'; ctx.fillRect(-12, -72, 28, 14);      // shirt
    ctx.fillStyle = '#2e4a6b'; ctx.fillRect(-8, -84, 6, 14); ctx.fillRect(10, -84, 6, 14); // straps
    // arms reaching forward, one holding a pitchfork
    ctx.strokeStyle = '#e8b88a'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(10, -66); ctx.lineTo(30, -58 + s1 * 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, -66); ctx.lineTo(26, -46); ctx.stroke();
    // pitchfork
    ctx.strokeStyle = '#8a6d3b'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(28, -96); ctx.lineTo(38, -30); ctx.stroke();
    ctx.strokeStyle = '#c0c0c0'; ctx.lineWidth = 3;
    for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(28 + i * 6, -96); ctx.lineTo(30 + i * 6, -110); ctx.stroke(); }
    // head + straw hat
    ctx.fillStyle = '#e8b88a'; circle(4, -92, 12);
    ctx.fillStyle = '#d9a441'; ellipse(4, -100, 20, 6);             // hat brim
    ctx.fillStyle = '#c9973a'; ctx.fillRect(-6, -116, 20, 16);      // hat top
    ctx.fillStyle = '#1d0f04'; circle(8, -94, 2.2); circle(0, -94, 2.2); // eyes
    ctx.strokeStyle = '#1d0f04'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-2, -84); ctx.lineTo(10, -84); ctx.stroke(); // angry mouth
    // beard
    ctx.fillStyle = '#e8e0d0'; ctx.beginPath(); ctx.moveTo(-6, -86); ctx.lineTo(14, -86); ctx.lineTo(4, -74); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawFence(o) {
    ctx.fillStyle = '#7a4a21';
    ctx.fillRect(o.x, GROUND_Y - 62, 5, 62); ctx.fillRect(o.x + 21, GROUND_Y - 62, 5, 62);
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(o.x - 4, GROUND_Y - 56, 34, 6); ctx.fillRect(o.x - 4, GROUND_Y - 34, 34, 6);
    ctx.fillStyle = '#a06a35'; ctx.fillRect(o.x - 4, GROUND_Y - 62, 34, 5);
  }
  function drawHay(o) {
    ctx.fillStyle = '#d9a441'; ellipse(o.x + 28, GROUND_Y - 24, 30, 24);
    ctx.fillStyle = '#c9973a'; ellipse(o.x + 28, GROUND_Y - 28, 24, 16);
    ctx.strokeStyle = '#8a6d3b'; ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(o.x + 28 + i * 10, GROUND_Y - 44); ctx.lineTo(o.x + 28 + i * 12, GROUND_Y - 8); ctx.stroke(); }
    ctx.fillStyle = '#b4552d'; circle(o.x + 28, GROUND_Y - 46, 4);
  }
  function drawBranch(o) {
    ctx.fillStyle = '#5d3413';
    ctx.fillRect(o.x, GROUND_Y - 58, 6, 58); ctx.fillRect(o.x + 84, GROUND_Y - 58, 6, 58);
    ctx.fillStyle = '#6b4423'; ctx.fillRect(o.x - 6, GROUND_Y - 62, 102, 10);
    ctx.fillStyle = '#4a7a2e';
    for (let i = 0; i < 7; i++) { ellipse(o.x + 8 + i * 13, GROUND_Y - 48 + ((i % 2) * 4), 8, 5); }
    ctx.fillStyle = '#c0392b'; circle(o.x + 30, GROUND_Y - 46, 4); circle(o.x + 66, GROUND_Y - 48, 4);
  }
  function drawOven(o) {
    // big farm oven on wheels, chimney puffing smoke
    ctx.fillStyle = '#3a3a42'; rr(o.x, GROUND_Y - 108, 92, 108, 8); ctx.fill();
    ctx.fillStyle = '#4a4a55'; rr(o.x + 6, GROUND_Y - 102, 80, 96, 6); ctx.fill();
    ctx.fillStyle = '#1d1d22'; rr(o.x + 16, GROUND_Y - 88, 60, 62, 5); ctx.fill(); // door
    ctx.fillStyle = '#ff9d45'; rr(o.x + 26, GROUND_Y - 78, 40, 26, 4); ctx.fill(); // glowing window
    ctx.fillStyle = '#ffd76a'; circle(o.x + 46, GROUND_Y - 65, 7);
    ctx.fillStyle = '#c0c0c0'; ctx.fillRect(o.x + 20, GROUND_Y - 22, 52, 5);      // handle
    ctx.fillStyle = '#2a2a30'; ctx.fillRect(o.x + 66, GROUND_Y - 138, 16, 36);    // chimney
    ctx.fillStyle = '#55555f'; ctx.fillRect(o.x + 62, GROUND_Y - 142, 24, 6);
    // smoke puffs
    for (let i = 0; i < 3; i++) {
      const ph = (S.time * 0.7 + i * 0.33) % 1;
      ctx.fillStyle = `rgba(220, 220, 220, ${0.5 * (1 - ph)})`;
      circle(o.x + 74 + Math.sin(ph * 9) * 6, GROUND_Y - 150 - ph * 46, 6 + ph * 10);
    }
    // wheels
    ctx.fillStyle = '#1d1d22'; circle(o.x + 18, GROUND_Y - 2, 9); circle(o.x + 74, GROUND_Y - 2, 9);
    ctx.fillStyle = '#55555f'; circle(o.x + 18, GROUND_Y - 2, 3.5); circle(o.x + 74, GROUND_Y - 2, 3.5);
  }
  function drawPine(x, baseY, h, color) {
    ctx.fillStyle = color;
    const w = h * 0.42;
    // three stacked tiers, apex at the top
    for (let tier = 0; tier < 3; tier++) {
      const ty = baseY - h * (0.28 + tier * 0.26);
      const tw = w * (1 - tier * 0.22);
      ctx.beginPath(); ctx.moveTo(x, ty - h * 0.3); ctx.lineTo(x - tw / 2, ty); ctx.lineTo(x + tw / 2, ty); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#5d3413'; ctx.fillRect(x - 4, baseY - 12, 8, 12);
  }
  function drawKnife(o) {
    if (o.phase === 'warn') {
      // telegraph: a knife silhouette dropping in from the sky, a dashed guide
      // line down to a pulsing ground marker where it will land.
      const pulse = 0.5 + 0.5 * Math.sin(S.time * 10);
      ctx.strokeStyle = `rgba(255, 220, 120, ${0.45 + 0.4 * pulse})`;
      ctx.lineWidth = 3; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(o.targetX, 30); ctx.lineTo(o.targetX, GROUND_Y - 8); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(230, 57, 70, ${0.25 + 0.25 * pulse})`;
      ellipse(o.targetX, GROUND_Y + 4, 26 + pulse * 8, 6);
      ctx.save(); ctx.translate(o.targetX, 66);
      const grad = ctx.createLinearGradient(-8, -34, 8, 0);
      grad.addColorStop(0, '#e8ecf0'); grad.addColorStop(1, '#9aa2ab');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(-7, -34); ctx.lineTo(7, -34); ctx.lineTo(7, -6); ctx.lineTo(0, 6); ctx.lineTo(-7, -6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#5d3413'; rr(-5, -48, 10, 16, 3); ctx.fill();
      ctx.restore();
      return;
    }
    if (o.phase === 'fall' || o.phase === 'stuck') {
      ctx.save(); ctx.translate(o.targetX, o.tipY);
      ctx.rotate(o.phase === 'stuck' ? 0.06 : 0.02);
      // blade
      const grad = ctx.createLinearGradient(-8, -74, 8, 0);
      grad.addColorStop(0, '#e8ecf0'); grad.addColorStop(1, '#9aa2ab');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.moveTo(-7, -74); ctx.lineTo(7, -74); ctx.lineTo(7, -12); ctx.lineTo(0, 0); ctx.lineTo(-7, -12); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(-4, -70, 2, 52);
      // handle
      ctx.fillStyle = '#5d3413'; rr(-5, -92, 10, 20, 3); ctx.fill();
      ctx.fillStyle = '#c0c0c0'; ctx.fillRect(-8, -74, 16, 4);
      ctx.restore();
      if (o.phase === 'stuck') { ctx.fillStyle = 'rgba(20,10,5,0.4)'; ellipse(o.targetX, GROUND_Y + 4, 16, 4); }
    }
  }
  function drawCorn(p) {
    const bob = Math.sin(p.bob) * 3;
    ctx.save(); ctx.translate(p.x, p.y + bob);
    ctx.fillStyle = '#3f7a2e';
    ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(-7, 16); ctx.lineTo(7, 16); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd76a'; ellipse(0, 0, 9, 14);
    ctx.fillStyle = '#e8b13c';
    for (let i = -1; i <= 1; i++) { ctx.fillRect(i * 5 - 1, -11, 2, 22); }
    ctx.fillStyle = '#fff3c4'; ellipse(-3, -6, 3, 4);
    ctx.restore();
  }
  function drawFeatherPickup(p) {
    const bob = Math.sin(p.bob) * 4;
    ctx.save(); ctx.translate(p.x, p.y + bob); ctx.rotate(Math.sin(p.bob * 0.7) * 0.3);
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    g.addColorStop(0, 'rgba(255, 215, 106, 0.9)'); g.addColorStop(1, 'rgba(255, 215, 106, 0)');
    ctx.fillStyle = g; circle(0, 0, 26);
    ctx.fillStyle = '#ffd76a';
    ctx.beginPath(); ctx.moveTo(0, -18); ctx.quadraticCurveTo(12, -4, 4, 14); ctx.quadraticCurveTo(-8, 2, 0, -18); ctx.fill();
    ctx.strokeStyle = '#c9973a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(2, 14); ctx.stroke();
    ctx.restore();
  }
  function drawParticles() {
    for (const p of S.particles) {
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
      ctx.translate(p.x, p.y); ctx.rotate(p.spin);
      ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    }
  }
  function drawLeaves() {
    for (const l of S.leaves) {
      ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(Math.sin(l.ph) * 0.8);
      ctx.fillStyle = l.color; ctx.fillRect(-l.s / 2, -l.s / 4, l.s, l.s / 2);
      ctx.restore();
    }
  }

  // ---- HUD & screens ----
  function heart(x, y, full) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = full ? '#e63946' : 'rgba(230, 57, 70, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.bezierCurveTo(-11, -4, -6, -12, 0, -5);
    ctx.bezierCurveTo(6, -12, 11, -4, 0, 6);
    ctx.fill(); ctx.restore();
  }
  function drawHUD() {
    ctx.save();
    // top bar
    ctx.fillStyle = 'rgba(20, 10, 5, 0.45)'; rr(12, 10, W - 24, 46, 10); ctx.fill();
    ctx.fillStyle = '#fff3d6'; ctx.font = 'bold 22px "Trebuchet MS", Verdana, sans-serif'; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE ${S.score}`, 26, 34);
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.floor(distanceM())} m  /  ${GOAL_M} m`, W / 2, 34);
    ctx.textAlign = 'right';
    ctx.fillText(muted ? 'SOUND OFF (M)' : 'SOUND ON (M)', W - 26, 34);
    // hearts under the score
    for (let i = 0; i < 3; i++) heart(30 + i * 28, 76, i < S.lives);
    ctx.fillStyle = '#fff3d6'; ctx.font = 'bold 15px "Trebuchet MS", Verdana, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('LIVES', 104, 76);
    // farmer proximity bar (right side)
    const closeness = 1 - S.lives / 3; // 0 = far, 1 = on top of you
    ctx.fillStyle = 'rgba(20, 10, 5, 0.45)'; rr(W - 246, 64, 234, 26, 8); ctx.fill();
    const fillW = 222 * closeness;
    if (fillW > 4) { ctx.fillStyle = '#e63946'; rr(W - 240, 70, fillW, 14, 6); ctx.fill(); }
    ctx.fillStyle = '#fff3d6'; ctx.font = 'bold 13px "Trebuchet MS", Verdana, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('FARMER', W - 129, 77);
    ctx.restore();
  }
  function panel(x, y, w, h) {
    ctx.fillStyle = 'rgba(24, 12, 4, 0.78)'; rr(x, y, w, h, 16); ctx.fill();
    ctx.strokeStyle = '#f7b267'; ctx.lineWidth = 3; rr(x, y, w, h, 16); ctx.stroke();
  }
  function drawTitle() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff3d6';
    ctx.font = 'bold 84px "Trebuchet MS", Verdana, sans-serif';
    ctx.shadowColor = '#7a2d12'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 6;
    ctx.fillText('GOBBLE RUN', W / 2, 138);
    ctx.shadowOffsetY = 0;
    ctx.font = 'bold 30px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillStyle = '#ffd76a';
    ctx.fillText('— THANKSGIVING ESCAPE —', W / 2, 182);
    ctx.font = '20px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillStyle = '#fff3d6';
    ctx.fillText('Thanksgiving morning. Tom the turkey has escaped the pen —', W / 2, 224);
    ctx.fillText('outrun the farmer, dodge the oven and the carving knives,', W / 2, 250);
    ctx.fillText('and reach the forest 1000 m away!', W / 2, 276);
    // start prompt (pulsing)
    const a = 0.65 + 0.35 * Math.sin(S.time * 4);
    ctx.globalAlpha = a;
    ctx.font = 'bold 28px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillStyle = '#ffd76a';
    ctx.fillText('PRESS SPACE OR CLICK TO RUN', W / 2, 330);
    ctx.globalAlpha = 1;
    ctx.font = '17px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillStyle = '#ffe9c4';
    ctx.fillText('SPACE / ↑ / CLICK — jump      ↓ — slide      P — pause      M — sound', W / 2, 372);
    ctx.fillText('Jump fences, hay bales and the oven · Slide under low branches · Grab corn (+25) and golden feathers (+150)', W / 2, 398);
    if (best > 0) {
      ctx.font = 'bold 19px "Trebuchet MS", Verdana, sans-serif';
      ctx.fillStyle = '#ffd76a';
      ctx.fillText(`BEST ESCAPE: ${best} m`, W / 2, 436);
    }
    ctx.restore();
  }
  function drawEnd() {
    const escaped = S.state === 'escaped';
    ctx.save();
    // dim the field
    ctx.fillStyle = escaped ? 'rgba(20, 60, 20, 0.35)' : 'rgba(40, 8, 4, 0.45)';
    ctx.fillRect(0, 0, W, H);
    panel(W / 2 - 300, 92, 600, 330);
    ctx.textAlign = 'center';
    ctx.fillStyle = escaped ? '#7ec850' : '#ff6b5e';
    ctx.font = 'bold 64px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText(escaped ? 'ESCAPED!' : 'CAUGHT!', W / 2, 176);
    ctx.fillStyle = '#fff3d6'; ctx.font = '22px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText(S.endReason, W / 2, 216);
    ctx.font = 'bold 26px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText(`SCORE  ${S.score}`, W / 2, 268);
    ctx.font = '22px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText(`Distance  ${Math.floor(distanceM())} m   ·   Corn bonus included`, W / 2, 302);
    if (Math.floor(distanceM()) >= best && best > 0) {
      ctx.fillStyle = '#ffd76a'; ctx.font = 'bold 20px "Trebuchet MS", Verdana, sans-serif';
      ctx.fillText('★ NEW BEST DISTANCE ★', W / 2, 336);
    }
    const a = 0.65 + 0.35 * Math.sin(S.time * 4);
    ctx.globalAlpha = a;
    ctx.font = 'bold 24px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillStyle = '#ffd76a';
    ctx.fillText('PRESS R OR CLICK TO RUN AGAIN', W / 2, 388);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  function drawPaused() {
    ctx.save();
    ctx.fillStyle = 'rgba(20, 10, 5, 0.55)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#fff3d6';
    ctx.font = 'bold 54px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText('PAUSED', W / 2, H / 2 - 10);
    ctx.font = '20px "Trebuchet MS", Verdana, sans-serif';
    ctx.fillText('Press P to keep running', W / 2, H / 2 + 34);
    ctx.restore();
  }

  function drawFarmerChase() {
    // Farmer position: closes in as lives drop. Off-screen left when lives are full.
    const gapPx = 26 + S.lives * 62;
    const fx = S.turkey.x - gapPx;
    if (fx > -70) drawFarmer(fx, GROUND_Y, S.time * 10);
  }

  function render() {
    fit();
    ctx.save();
    if (S.shake > 0) ctx.translate((rng() - 0.5) * S.shake, (rng() - 0.5) * S.shake);
    drawSky();
    drawHills();
    drawBarnAndFence();
    if (S.state === 'escaped') {
      // the farm gives way to deep forest behind the action
      const fg = ctx.createLinearGradient(0, GROUND_Y - 200, 0, GROUND_Y);
      fg.addColorStop(0, 'rgba(26, 74, 32, 0.92)');
      fg.addColorStop(1, 'rgba(14, 46, 20, 0.97)');
      ctx.fillStyle = fg; ctx.fillRect(0, GROUND_Y - 200, W, 200);
      for (let i = 0; i < 11; i++) drawPine(i * 96 + 10, GROUND_Y, 130 + ((i * 47) % 70), '#1d4a22');
    }
    drawGround();
    drawLeaves();

    if (S.state === 'title') {
      // title: turkey runs in place on the field, farmer chasing
      drawTurkey(300, GROUND_Y, { phase: 0 });
      drawFarmer(300 - 150, GROUND_Y, S.time * 10);
      drawHay({ x: 640 }); drawFence({ x: 800 });
      drawTitle();
    } else {
      for (const o of S.obstacles) {
        if (o.kind === 'fence') drawFence(o);
        else if (o.kind === 'hay') drawHay(o);
        else if (o.kind === 'branch') drawBranch(o);
        else if (o.kind === 'oven') drawOven(o);
        else if (o.kind === 'knife') drawKnife(o);
      }
      for (const p of S.pickups) {
        if (p.kind === 'corn') drawCorn(p); else drawFeatherPickup(p);
      }
      drawParticles();
      if (S.state === 'caught') {
        // caught: farmer has the turkey
        drawFarmer(S.turkey.x - 8, GROUND_Y, 0);
        ctx.save(); ctx.translate(S.turkey.x + 34, GROUND_Y - 66); ctx.rotate(0.5);
        drawTurkey(0, 0, { air: true });
        ctx.restore();
        // In real play there is no staged oven nearby, so add one for
        // atmosphere; the staged shot already places its own oven.
        if (!shotMode) drawOven({ x: 700 });
      } else if (S.state === 'escaped') {
        // forest edge celebration: pines framing the turkey
        for (let i = 0; i < 5; i++) drawPine(70 + i * 200, GROUND_Y, 150, '#2e5d23');
        drawTurkey(S.turkey.x, GROUND_Y, { air: false });
      } else {
        drawFarmerChase();
        const t = S.turkey;
        drawTurkey(t.x, GROUND_Y + t.y, { air: t.y < 0, sliding: t.sliding, invuln: t.invuln > 0 });
      }
      drawHUD();
      if (S.state === 'paused') drawPaused();
      if (S.state === 'caught' || S.state === 'escaped') drawEnd();
    }
    if (S.flash > 0) { ctx.fillStyle = `rgba(255, 60, 40, ${S.flash * 0.5})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }

  // ---- deterministic screenshot staging ----
  function stageShot(kind) {
    // Freeze the world: fixed clock, fixed scene, no updates.
    S.time = 2.35;
    S.scoreBonus = 0;
    if (kind === 'start') {
      S.state = 'title';
      initLeaves();
    } else if (kind === 'play') {
      S.state = 'play';
      // 320 m puts the barn at x=700 (behind the oven), so the fence at 300
      // is clear of it; lives=2 puts the farmer visibly on Tom's tail.
      S.distancePx = 320 * PX_PER_M;
      S.score = 1250; S.scoreBonus = 0; S.lives = 2;
      S.turkey = { x: 190, y: -110, vy: -300, sliding: false, slideT: 0, runPhase: 2.1, invuln: 0, dead: false };
      S.obstacles = [
        { kind: 'fence', x: 300, hit: false },
        { kind: 'knife', x: 480, targetX: 480, tipY: -40, phase: 'warn', t: 0.2, hit: false },
        { kind: 'hay', x: 600, hit: false },
        { kind: 'oven', x: 790, hit: false },
      ];
      S.pickups = [
        { kind: 'corn', x: 320, y: GROUND_Y - 96, taken: false, bob: 0.4 },
        { kind: 'corn', x: 354, y: GROUND_Y - 128, taken: false, bob: 1.1 },
        { kind: 'corn', x: 388, y: GROUND_Y - 96, taken: false, bob: 2.0 },
        { kind: 'corn', x: 540, y: GROUND_Y - 26, taken: false, bob: 0.9 },
        { kind: 'feather', x: 680, y: GROUND_Y - 160, taken: false, bob: 0.2 },
      ];
      S.particles = [];
      initLeaves();
    } else if (kind === 'end') {
      S.state = 'caught';
      S.distancePx = 587 * PX_PER_M;
      S.score = 2140; S.scoreBonus = 0; S.lives = 0;
      // panel spans x 180..780: put the farmer + Tom in the right strip,
      // the oven in the left strip, so the scene stays visible.
      S.turkey = { x: 840, y: 0, vy: 0, sliding: false, slideT: 0, runPhase: 0, invuln: 0, dead: true };
      S.obstacles = [{ kind: 'oven', x: 40, hit: false }];
      S.pickups = [];
      S.endReason = 'The farmer caught Tom!';
      S.particles = [];
      initLeaves();
    } else if (kind === 'escaped') {
      S.state = 'escaped';
      S.distancePx = GOAL_M * PX_PER_M;
      S.score = 4860; S.scoreBonus = 0; S.lives = 2;
      S.turkey = { x: 840, y: 0, vy: 0, sliding: false, slideT: 0, runPhase: 0, invuln: 0, dead: false };
      S.obstacles = [];
      S.pickups = [];
      S.endReason = 'Tom reached the forest — free at last!';
      S.particles = [];
      for (let i = 0; i < 26; i++) {
        S.particles.push({ x: 740 + rng() * 180, y: 120 + rng() * 200, vx: (rng() - 0.5) * 60, vy: -40 - rng() * 60, life: 3, t: rng() * 1.5, color: ['#ffd76a', '#ff9d5c', '#7ec850', '#ffffff'][i % 4], size: 3 + rng() * 4, spin: rng() * 6, vr: 2 });
      }
      initLeaves();
    }
  }

  // ---- main loop ----
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!shotMode) update(dt);
    render();
    requestAnimationFrame(loop);
  }

  if (shotMode) {
    stageShot(shotMode);
    setStatus(`Gobble Run — staged ${shotMode} scene.`);
  } else {
    setStatus('Gobble Run: Thanksgiving Escape. Press Space or click to run.');
  }
  requestAnimationFrame(loop);

  // ---- test hooks (headless verification only) ----
  window.__gobble = {
    get state() { return S.state; },
    get score() { return S.score; },
    get distanceM() { return Math.floor(distanceM()); },
    get lives() { return S.lives; },
    get best() { return best; },
    get obstacles() { return S.obstacles.length; },
    start() { if (S.state === 'title') reset(); },
    jump: doJump,
    slide: doSlide,
    pause: togglePause,
    restart() { reset(); },
    forceHit() { if (S.state === 'play') { S.turkey.invuln = 0; onHit({ hit: false }); } },
    forceWin() { if (S.state === 'play') { S.distancePx = GOAL_M * PX_PER_M; } },
    setMuted(m) { muted = !!m; },
  };
})();
