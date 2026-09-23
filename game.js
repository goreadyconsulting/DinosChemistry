(function () {
'use strict';

const $ = id => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false });
const hud = $('hud'), controls = $('controls'), powerEl = $('power');
const TAU = Math.PI * 2;
const FINISH = 47000, DRAW_DISTANCE = 2200, ROAD_HALF = 150;
const LANES = [-100, 0, 100];
const CAMERA_DISTANCE = 300, STEP = 1 / 60;
let VW = 390, VH = 844, HORIZON = 192, CAMERA_HEIGHT = 450;
let dpr = 1, last = 0, accumulator = 0, roadTime = 0;
let state = 'start', paused = false, countdown = 0, finishTime = 0;
let muted = false, audioCtx = null, masterGain = null;
let shake = 0, collected = 0, bumps = 0, currentZone = -1, hudTime = 0;
let toastLeft = 0, zoneLeft = 0, pickupPulse = 0, pickupColor = '#f18ca7';
let hazards = [], pickups = [], scenery = [], particles = [], rings = [];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const player = {
  lane: 1, x: 0, targetX: 0, progress: 0, speed: 145, lean: 0,
  jumpY: 0, jumpV: 0, grounded: true, jumpPrep: 0, jumpBuffer: 0,
  landing: 0, hitFlash: 0, invulnerable: 0, slow: 0, shieldFlash: 0,
  boost: 0, shield: 0, glow: 0, magnet: 0
};

const zones = [
  {name: 'Garden Road', sky1: '#b7dfd8', sky2: '#fff0ce', road: '#596779', edge: '#f9e6ca', ground: '#8bb786', hill: '#699681', accent: '#e49395'},
  {name: 'Chem Lab Pass', sky1: '#96cfd6', sky2: '#e5efdf', road: '#53677b', edge: '#dcefe1', ground: '#83aca1', hill: '#628e99', accent: '#b5dbd2'},
  {name: 'Sunset Bend', sky1: '#dd91a5', sky2: '#ffcb9a', road: '#675e7b', edge: '#f6d5b6', ground: '#b2828b', hill: '#886b8c', accent: '#ecb197'},
  {name: 'Neon Night', sky1: '#202c50', sky2: '#725477', road: '#363e59', edge: '#c5bfe6', ground: '#394664', hill: '#2d3656', accent: '#a08bcb'}
];
const powers = [
  {symbol: 'O', label: 'Oxygen boost', short: 'Boost', kind: 'boost', color: '#f7bc76', duration: 6},
  {symbol: 'C', label: 'Carbon shield', short: 'Shield', kind: 'shield', color: '#a9dbdf', duration: 9},
  {symbol: 'Ne', label: 'Neon glow', short: 'Glow', kind: 'glow', color: '#ef8cce', duration: 8},
  {symbol: 'Fe', label: 'Iron magnet', short: 'Magnet', kind: 'magnet', color: '#df9a82', duration: 8}
];
const effectLevel = {boost: 0, shield: 0, glow: 0, magnet: 0};
const powerNodes = powers.map(p => {
  const item = document.createElement('div');
  item.className = 'effect';
  item.innerHTML = '<b>' + p.symbol + '</b><span>' + p.short + '</span>';
  item.style.setProperty('--tint', p.color);
  item.hidden = true;
  powerEl.appendChild(item);
  return item;
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const ease = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
const laneValue = lane => LANES[clamp(lane, 0, 2)];
const zoneIndex = p => clamp(Math.floor(p / (FINISH / 4)), 0, 3);

function resize() {
  const r = canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  // One uniform pixel scale keeps cars and capsules round on every aspect ratio.
  VW = 390;
  VH = VW * r.height / Math.max(1, r.width);
  HORIZON = VH * .225;
  const controlTop = (controls.getBoundingClientRect().top - r.top) * VW / r.width;
  const playerY = Math.max(HORIZON + 105, Math.min(VH * .79, controlTop - 34));
  CAMERA_HEIGHT = playerY - HORIZON;
}
window.addEventListener('resize', resize, {passive: true});
if (window.visualViewport) window.visualViewport.addEventListener('resize', resize, {passive: true});

function roadCurveAt(p) {
  return Math.sin(p / 1200) * 56 + Math.sin(p / 2800 + 1.3) * 31;
}

// The road, its stripes, world objects and the car all use this same camera.
// Relative distance zero is both the car's ground contact and collision plane.
function roadGeom(distance) {
  const scale = CAMERA_DISTANCE / (CAMERA_DISTANCE + distance);
  const bend = roadCurveAt(player.progress + distance) - roadCurveAt(player.progress);
  return {scale, center: VW / 2 + bend * scale * 1.8,
    y: HORIZON + CAMERA_HEIGHT * scale, half: ROAD_HALF * scale};
}
function project(progress, x = 0, height = 0) {
  const d = progress - player.progress;
  if (d < -135 || d > DRAW_DISTANCE) return null;
  const g = roadGeom(d);
  return {x: g.center + x * g.scale, y: g.y - height * g.scale,
    groundY: g.y, scale: g.scale, half: g.half, distance: d};
}

function blendColor(a, b, t) {
  const na = parseInt(a.slice(1), 16), nb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp(na >> 16, nb >> 16, t));
  const g = Math.round(lerp((na >> 8) & 255, (nb >> 8) & 255, t));
  const bl = Math.round(lerp(na & 255, nb & 255, t));
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}
function palette() {
  const position = clamp(player.progress / (FINISH / 4), 0, 3.999);
  const index = Math.min(3, Math.floor(position));
  const next = zones[Math.min(3, index + 1)], a = zones[index];
  const mix = smooth((position - index - .78) / .22);
  const z = {night: index === 3 ? 1 : index === 2 ? mix : 0};
  ['sky1', 'sky2', 'road', 'edge', 'ground', 'hill', 'accent'].forEach(k => z[k] = blendColor(a[k], next[k], mix));
  return z;
}

function initAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = muted ? 0 : 1;
      masterGain.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (_) { /* Sound is optional, including when audio is unavailable. */ }
}
function sound(freq, duration = .12, type = 'sine', volume = .025, delay = 0, endFreq = freq) {
  if (muted || !audioCtx || paused || document.hidden) return;
  const time = audioCtx.currentTime + delay;
  const oscillator = audioCtx.createOscillator(), gain = audioCtx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(freq, time);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFreq), time + duration);
  gain.gain.setValueAtTime(.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + .008);
  gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
  oscillator.connect(gain).connect(masterGain);
  oscillator.start(time); oscillator.stop(time + duration + .01);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
}
function vibrate(ms) { if (navigator.vibrate && !reducedMotion) navigator.vibrate(ms); }
function showToast(message, duration = 2.3) {
  $('toast').textContent = message; $('toast').classList.add('show'); toastLeft = duration;
}
function showZone(name) {
  $('zone').textContent = name; $('zone').classList.add('show'); zoneLeft = 2.6;
}

const obstacleSpec = {
  cone: {width: 17, clear: 25}, crate: {width: 24, clear: 40},
  barrier: {width: 35, clear: 34}, oil: {width: 30, clear: 5}
};
function buildTrack() {
  hazards = []; pickups = []; scenery = []; particles = []; rings = [];
  const addHazard = (p, lane, type) => hazards.push({progress: p, x: laneValue(lane), lane, type, hit: false, passed: false});
  const addPickup = (p, lane, powerIndex, height = 18) => pickups.push({
    progress: p, lane, x: laneValue(lane), height, power: powers[powerIndex % 4],
    got: false, missed: false, attracting: false, phase: p * .13
  });
  // The opening teaches one decision at a time, with rewards on safe lines.
  addPickup(550, 1, 1);
  addHazard(1100, 1, 'cone'); addPickup(1100, 1, 2, 78);
  addPickup(1730, 0, 0);
  addHazard(2400, 0, 'crate'); addPickup(2400, 1, 3);
  addPickup(2750, 2, 2); addPickup(2930, 0, 1);
  addHazard(3340, 0, 'cone'); addHazard(3340, 2, 'cone'); addPickup(3340, 1, 0);
  addHazard(4100, 1, 'oil'); addPickup(4500, 2, 1);

  let cursor = 5100, pattern = 0;
  while (cursor < FINISH - 2900) {
    const section = zoneIndex(cursor);
    // Even at 195 units/s the closest rows leave >1.3 s for a full lane change / jump.
    const rowGap = [380, 335, 300, 270][section];
    const rest = [430, 350, 300, 260][section];
    const a = (pattern * 2 + 1) % 3, b = (a + 1) % 3, c = (a + 2) % 3;
    const types = ['cone', 'crate', 'barrier', 'oil'];
    switch (pattern % 6) {
      case 0:
        addHazard(cursor, a, 'cone'); addHazard(cursor, b, 'crate');
        addPickup(cursor, c, pattern);
        addHazard(cursor + rowGap, c, 'oil');
        break;
      case 1:
        addHazard(cursor, a, 'barrier'); addPickup(cursor, a, pattern, 82);
        addHazard(cursor + rowGap, b, 'crate'); addPickup(cursor + rowGap, c, pattern + 1);
        break;
      case 2:
        addHazard(cursor, 0, 'crate'); addHazard(cursor, 1, 'cone');
        addHazard(cursor + rowGap, 1, 'barrier'); addHazard(cursor + rowGap, 2, 'cone');
        addPickup(cursor, 2, pattern); addPickup(cursor + rowGap, 0, pattern + 1);
        break;
      case 3:
        addHazard(cursor, a, 'oil'); addHazard(cursor + rowGap, c, 'barrier');
        addPickup(cursor - 145, b, 3);
        addPickup(cursor + rowGap, a, pattern); addPickup(cursor + rowGap + 135, b, pattern + 1);
        break;
      case 4:
        addHazard(cursor, a, types[section]); addPickup(cursor, a, pattern, 83);
        addHazard(cursor + rowGap, c, 'cone'); addPickup(cursor + rowGap, b, pattern + 1);
        break;
      default:
        addHazard(cursor, b, 'crate'); addHazard(cursor, c, 'barrier');
        addHazard(cursor + rowGap, a, 'cone'); addHazard(cursor + rowGap, b, 'oil');
        addPickup(cursor, a, pattern); addPickup(cursor + rowGap, c, pattern + 1);
    }
    cursor += rowGap + rest;
    pattern++;
  }
  // A clear final approach lets the chequered arch and deceleration have space.
  [1700, 1350, 1000].forEach((d, i) => addPickup(FINISH - d, 1, i === 2 ? 2 : 1));
  for (let p = 180, i = 0; p < FINISH + 1800; p += 155, i++) {
    const zone = zoneIndex(p), side = i % 2 ? -1 : 1;
    const choices = zone === 1 ? ['tree', 'flask', 'flowers', 'lamp', 'lab'] :
      zone === 3 ? ['lamp', 'tree', 'crystal', 'flowers', 'lamp'] : ['tree', 'flowers', 'rock', 'tree', 'lamp'];
    scenery.push({progress: p, x: side * (183 + (i % 4) * 31), type: choices[i % choices.length], seed: i});
  }
  hazards.sort((a, b) => a.progress - b.progress);
  pickups.sort((a, b) => a.progress - b.progress);
}

function reset() {
  Object.assign(player, {lane: 1, x: 0, targetX: 0, progress: 0, speed: 145, lean: 0,
    jumpY: 0, jumpV: 0, grounded: true, jumpPrep: 0, jumpBuffer: 0, landing: 0,
    hitFlash: 0, invulnerable: 0, slow: 0, shieldFlash: 0, boost: 0, shield: 0, glow: 0, magnet: 0});
  powers.forEach(p => effectLevel[p.kind] = 0);
  state = 'start'; paused = false; collected = 0; bumps = 0; roadTime = 0;
  finishTime = 0; currentZone = -1; shake = 0; pickupPulse = 0; accumulator = 0; hudTime = 0;
  toastLeft = 0; zoneLeft = 0; $('toast').classList.remove('show'); $('zone').classList.remove('show');
  $('pause').classList.add('hidden'); $('countdown').textContent = '';
  buildTrack(); updateHUD();
}
function moveLane(dir) {
  if (state !== 'driving' || paused) return;
  const next = clamp(player.lane + dir, 0, 2);
  if (next === player.lane) return;
  player.lane = next; player.targetX = laneValue(next);
  sound(dir < 0 ? 290 : 330, .065, 'triangle', .017, 0, 235);
}
function jump() {
  if (state !== 'driving' || paused) return;
  if (player.grounded && player.jumpPrep <= 0) player.jumpPrep = .085;
  else if (player.jumpV < 0 && player.jumpY < 25) player.jumpBuffer = .16;
}
function updateCar(dt) {
  const prevX = player.x;
  player.x = ease(player.x, player.targetX, 17, dt);
  player.lean = ease(player.lean, clamp((player.x - prevX) / dt / 900, -.19, .19), 12, dt);
  player.landing = Math.max(0, player.landing - dt);
  player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);
  if (player.jumpPrep > 0) {
    player.jumpPrep -= dt;
    if (player.jumpPrep <= 0) {
      player.grounded = false; player.jumpV = 345;
      sound(260, .19, 'triangle', .026, 0, 650); vibrate(9);
      groundRing(player.progress, player.x, '#ffe6cf', .38, 30);
    }
  }
  if (!player.grounded) {
    // Analytic integration of a ballistic arc is stable across frame rates.
    player.jumpY += player.jumpV * dt - .5 * 650 * dt * dt;
    player.jumpV -= 650 * dt;
    if (player.jumpY <= 0) {
      player.jumpY = 0; player.jumpV = 0; player.grounded = true; player.landing = .3;
      shake = Math.max(shake, .11); sound(155, .08, 'triangle', .018, 0, 80);
      burst(player.progress, player.x, '#eadbbf', 7, 1);
      groundRing(player.progress, player.x, '#fbe7cc', .32, 42);
      if (player.jumpBuffer > 0 && state === 'driving') { player.jumpBuffer = 0; player.jumpPrep = .085; }
    }
  }
}

function activate(power) {
  collected++;
  player[power.kind] = power.duration;
  pickupPulse = .5; pickupColor = power.color;
  groundRing(player.progress, player.x, power.color, .65, 73);
  showToast(power.label, 1.5);
  sound(590, .13, 'sine', .027); sound(880, .24, 'sine', .02, .075);
  vibrate(12); updateHUD();
}
function collide(h) {
  if (h.hit || player.invulnerable > 0 || player.jumpY > obstacleSpec[h.type].clear) return;
  h.hit = true;
  if (player.shield > 0) {
    player.shield = Math.max(0, player.shield - 3);
    player.shieldFlash = .55; player.invulnerable = .65;
    burst(h.progress, h.x, '#b3f7ef', 12, 30);
    groundRing(h.progress, h.x, '#cbfcf3', .6, 75);
    sound(500, .2, 'sine', .028, 0, 240); vibrate(12);
    return;
  }
  bumps++; player.hitFlash = .65; player.invulnerable = .9; player.slow = 1.05;
  player.speed *= .76; player.landing = .22; shake = .28;
  burst(h.progress, h.x, h.type === 'oil' ? '#ac96c0' : '#f2c595', 8, 10);
  sound(125, .14, 'triangle', .026, 0, 60); vibrate(24);
}

function updateHUD() {
  $('chemCount').textContent = '⚗ ' + collected;
  $('chemCount').setAttribute('aria-label', collected + ' chemistry capsules');
  const fraction = clamp(player.progress / FINISH, 0, 1);
  $('trackFill').style.transform = 'scaleX(' + fraction + ')';
  $('journey').setAttribute('aria-valuenow', Math.floor(fraction * 100));
  let active = false;
  powers.forEach((p, i) => {
    const remaining = player[p.kind];
    powerNodes[i].hidden = remaining <= 0;
    powerNodes[i].classList.toggle('ending', remaining < 1.4);
    powerNodes[i].style.setProperty('--remaining', clamp(remaining / p.duration, 0, 1) * 360 + 'deg');
    powerNodes[i].setAttribute('aria-label', p.label + ', ' + Math.ceil(remaining) + ' seconds');
    if (remaining > 0) active = true;
  });
  powerEl.classList.toggle('show', active && state === 'driving' && !paused);
}

function update(dt) {
  if (paused || state === 'start' || state === 'ended') return;
  roadTime += dt;
  if (toastLeft > 0 && (toastLeft -= dt) <= 0) $('toast').classList.remove('show');
  if (zoneLeft > 0 && (zoneLeft -= dt) <= 0) $('zone').classList.remove('show');
  shake = Math.max(0, shake - dt); pickupPulse = Math.max(0, pickupPulse - dt);
  ['hitFlash', 'invulnerable', 'slow', 'shieldFlash'].forEach(k => player[k] = Math.max(0, player[k] - dt));
  powers.forEach(p => {
    player[p.kind] = Math.max(0, player[p.kind] - dt);
    const target = state === 'driving' ? smooth(player[p.kind] / 1.4) : 0;
    effectLevel[p.kind] = ease(effectLevel[p.kind], target, 6, dt);
  });
  updateParticles(dt);
  if (state === 'countdown') {
    const before = Math.ceil(countdown); countdown -= dt;
    $('countdown').textContent = countdown > 0 ? Math.ceil(countdown) : '';
    if (Math.ceil(countdown) !== before && countdown > 0) sound(400 + (3 - Math.ceil(countdown)) * 90, .13, 'sine', .025);
    if (countdown <= 0) {
      state = 'driving'; controls.classList.add('show'); resize();
      sound(760, .3, 'triangle', .025); showToast('Left · Jump · Right', 2.6);
    }
    return;
  }
  const previousProgress = player.progress, previousX = player.x;
  updateCar(dt);
  if (state === 'finishing') {
    finishTime += dt;
    player.speed = ease(player.speed, 0, .95, dt);
    player.progress += player.speed * dt;
    if (finishTime > 1.5) player.targetX = 0;
    if (finishTime >= 4.2) finish();
    return;
  }
  const cruise = 145 + 20 * clamp(player.progress / FINISH, 0, 1);
  const targetSpeed = (cruise + (player.boost > 0 ? 30 : 0)) * (player.slow > 0 ? .77 : 1);
  player.speed = ease(player.speed, targetSpeed, 2.8, dt);
  player.progress += player.speed * dt;

  for (const p of pickups) {
    if (p.got || p.missed) continue;
    let diff = p.progress - player.progress;
    if (diff > 600) continue;
    if (player.magnet > 0 && diff < 420 && diff > 0 && Math.abs(p.x - player.x) < 230) p.attracting = true;
    if (p.attracting) {
      // Attraction continues once caught, following the actual moving car in world space.
      p.x = ease(p.x, player.x, 4.8, dt);
      p.progress -= (80 + Math.max(0, 400 - diff) * .4) * dt;
      p.height = ease(p.height, player.jumpY + 28, 4, dt);
      diff = p.progress - player.progress;
    }
    if (Math.abs(diff) < 27 && Math.abs(p.x - player.x) < 39 && Math.abs(p.height - (player.jumpY + 27)) < 46) {
      p.got = true; activate(p.power); burst(p.progress, p.x, p.power.color, 12, p.height);
    } else if (diff < -45) p.missed = true;
  }
  for (const h of hazards) {
    if (h.passed || h.hit) continue;
    // Swept contact catches the exact crossing, including at a low frame rate.
    if (previousProgress <= h.progress && player.progress >= h.progress) {
      const t = (h.progress - previousProgress) / Math.max(.0001, player.progress - previousProgress);
      const contactX = lerp(previousX, player.x, t);
      if (Math.abs(h.x - contactX) < obstacleSpec[h.type].width + 24) collide(h);
      h.passed = true;
    } else if (h.progress < previousProgress) h.passed = true;
  }
  const zi = zoneIndex(player.progress);
  if (zi !== currentZone) { currentZone = zi; showZone(zones[zi].name); }
  hudTime += dt;
  if (hudTime > .1) { hudTime = 0; updateHUD(); }
  if (previousProgress < FINISH - 1900 && player.progress >= FINISH - 1900) showToast('One last bend.', 2.4);
  if (player.progress >= FINISH) beginFinish();
}

function groundRing(progress, x, color, life, radius) {
  rings.push({progress, x, color, life, radius, age: 0});
  if (rings.length > 10) rings.shift();
}
function burst(progress, x, color, count, height) {
  for (let i = 0; i < count && particles.length < 90; i++) {
    const angle = TAU * i / count;
    particles.push({progress, x, height, vx: Math.cos(angle) * (25 + Math.random() * 35),
      vz: Math.sin(angle) * 35, vy: 50 + Math.random() * 60, age: 0,
      life: .5 + Math.random() * .3, color, size: 1.8 + Math.random() * 1.8});
  }
}
function updateParticles(dt) {
  particles = particles.filter(p => {
    p.age += dt; p.x += p.vx * dt; p.progress += p.vz * dt;
    p.height = Math.max(0, p.height + p.vy * dt); p.vy -= 210 * dt;
    return p.age < p.life;
  });
  rings = rings.filter(r => { r.age += dt; return r.age < r.life; });
}
function beginFinish() {
  state = 'finishing'; finishTime = 0;
  controls.classList.remove('show'); powerEl.classList.remove('show'); $('toast').classList.remove('show');
  updateHUD(); showZone('You made it');
  [523, 659, 784, 1046].forEach((n, i) => sound(n, .5, 'sine', .025, i * .14));
  burst(player.progress + 50, -125, '#ef9ebb', 16, 115);
  burst(player.progress + 50, 125, '#ffe2a3', 16, 115);
}
function finish() {
  state = 'ended'; player.speed = 0;
  hud.classList.remove('show'); $('zone').classList.remove('show');
  $('resultCopy').textContent = collected + ' little reactions. Four lovely places. One perfect passenger.';
  $('end').classList.remove('hidden'); $('againBtn').focus({preventScroll: true});
}

function rounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function ellipse(x, y, rx, ry, color) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill();
}
function polygon(points, color) {
  ctx.fillStyle = color; ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
  ctx.closePath(); ctx.fill();
}

function drawSky(z) {
  const sky = ctx.createLinearGradient(0, 0, 0, HORIZON + 170);
  sky.addColorStop(0, z.sky1); sky.addColorStop(1, z.sky2);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, VW, VH);
  const drift = roadCurveAt(player.progress + 1000) * .08;
  ctx.globalAlpha = 1 - z.night;
  const halo = ctx.createRadialGradient(302 - drift, HORIZON * .6, 5, 302 - drift, HORIZON * .6, 90);
  halo.addColorStop(0, '#fff4d5'); halo.addColorStop(1, 'rgba(255,243,213,0)');
  ctx.fillStyle = halo; ctx.fillRect(200 - drift, 0, 190, HORIZON + 20);
  ellipse(302 - drift, HORIZON * .6, 29, 29, '#fff1cc');
  ctx.globalAlpha = z.night;
  for (let i = 0; i < 36; i++) {
    const a = .4 + Math.sin(roadTime * .7 + i) * .2;
    ellipse((i * 67 + 22) % VW, 38 + (i * 41) % Math.max(50, HORIZON - 48), i % 7 ? .8 : 1.3, 'rgba(255,245,226,' + a + ')');
  }
  ellipse(302 - drift, HORIZON * .6, 23, 23, '#fff0d2');
  ellipse(311 - drift, HORIZON * .57, 21, 21, z.sky1);
  ctx.globalAlpha = (1 - z.night) * .38;
  for (let i = 0; i < 3; i++) {
    const x = 60 + i * 142 - drift * .6;
    ellipse(x, HORIZON * (.51 + i * .11), 31, 7, '#fffcf0');
    ellipse(x - 8, HORIZON * (.51 + i * .11) - 4, 14, 8, '#fffcf0');
  }
  ctx.globalAlpha = 1;
  for (let band = 0; band < 3; band++) {
    ctx.globalAlpha = .4 + band * .18;
    ctx.fillStyle = z.hill; ctx.beginPath(); ctx.moveTo(0, HORIZON + 36);
    for (let x = 0; x <= VW + 12; x += 12) {
      const y = HORIZON + band * 14 - 22 + Math.sin((x + drift * (band + 1) + band * 111) / (80 - band * 14)) * (16 + band * 5);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(VW, HORIZON + 100); ctx.lineTo(0, HORIZON + 100); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function roadQuad(p1, p2, left, right, color) {
  const a = roadGeom(p1 - player.progress), b = roadGeom(p2 - player.progress);
  polygon([[a.center + left * a.scale, a.y], [b.center + left * b.scale, b.y],
    [b.center + right * b.scale, b.y], [a.center + right * a.scale, a.y]], color);
}
function drawRoad(z) {
  const far = roadGeom(DRAW_DISTANCE);
  const ground = ctx.createLinearGradient(0, HORIZON + 30, 0, VH);
  ground.addColorStop(0, z.hill); ground.addColorStop(.35, z.ground); ground.addColorStop(1, z.ground);
  ctx.fillStyle = ground; ctx.fillRect(0, HORIZON + 38, VW, VH - HORIZON - 38);
  polygon([[VW / 2, HORIZON + 3], [far.center - far.half, far.y + 1], [far.center + far.half, far.y + 1]], z.road);
  const start = Math.floor((player.progress - 135) / 30) * 30;
  for (let p = Math.ceil((player.progress + DRAW_DISTANCE) / 30) * 30; p >= start; p -= 30) {
    const p1 = Math.max(player.progress - 135, p), p2 = p + 30;
    if (p1 >= p2) continue;
    const a = roadGeom(p1 - player.progress), b = roadGeom(p2 - player.progress);
    roadQuad(p1, p2, -ROAD_HALF - 16, ROAD_HALF + 16, 'rgba(30,44,53,.12)');
    roadQuad(p1, p2, -ROAD_HALF, ROAD_HALF, z.road);
    if (Math.floor(p / 120) % 2 === 0) roadQuad(p1, p2, -ROAD_HALF, ROAD_HALF, 'rgba(255,255,255,.018)');
    const border = Math.floor(p / 120) % 2 === 0 ? z.edge : z.accent;
    roadQuad(p1, p2, -ROAD_HALF - 7, -ROAD_HALF, border);
    roadQuad(p1, p2, ROAD_HALF, ROAD_HALF + 7, border);
    if (((p % 180) + 180) % 180 < 90) {
      roadQuad(p1, p2, -51, -49, 'rgba(252,243,227,.58)');
      roadQuad(p1, p2, 49, 51, 'rgba(252,243,227,.58)');
    }
    const intensity = Math.max(z.night * .4, effectLevel.glow);
    if (intensity > .01) {
      ctx.globalAlpha = intensity * .5;
      roadQuad(p1, p2, -147, -144, '#f3abe8'); roadQuad(p1, p2, 144, 147, '#9ce9f2');
      ctx.globalAlpha = intensity * .07;
      roadQuad(p1, p2, -144, -124, '#f6a9e6'); roadQuad(p1, p2, 124, 144, '#a7f3f1');
      ctx.globalAlpha = 1;
    }
    // A soft depth haze ties tiny objects and the distant road into the landscape.
    if (a.scale < .23) {
      ctx.globalAlpha = (1 - a.scale / .23) * .4;
      polygon([[a.center - a.half, a.y], [b.center - b.half, b.y], [b.center + b.half, b.y], [a.center + a.half, a.y]], z.sky2);
      ctx.globalAlpha = 1;
    }
  }
  drawTrails();
}

function drawTrails() {
  const glow = effectLevel.glow, boost = effectLevel.boost;
  if (Math.max(glow, boost) < .01) return;
  for (let i = 0; i < 7; i++) {
    const age = i / 7, p = player.progress - 10 - i * 14;
    const strength = (1 - age) * Math.max(glow, boost);
    ctx.globalAlpha = strength * .25;
    for (const side of [-1, 1]) roadQuad(p - 12, p, player.x + side * 27 - 4, player.x + side * 27 + 4, boost > glow ? '#ffd08b' : '#f694da');
  }
  ctx.globalAlpha = 1;
  if (boost > .01 && !reducedMotion) {
    for (let i = 0; i < 10; i++) {
      const d = 420 - ((player.progress * 1.25 + i * 71) % 530);
      const p1 = project(player.progress + d, (i % 2 ? -1 : 1) * (165 + i % 3 * 34), 5);
      const p2 = project(player.progress + d + 36, (i % 2 ? -1 : 1) * (165 + i % 3 * 34), 5);
      if (!p1 || !p2) continue;
      ctx.strokeStyle = 'rgba(255,231,189,' + .26 * boost * p1.scale + ')'; ctx.lineWidth = 1.5 * p1.scale;
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    }
  }
}

function drawScenery(s, z) {
  const p = project(s.progress, s.x); if (!p) return;
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(p.scale, p.scale);
  ellipse(6, 1, s.type === 'lab' ? 51 : 26, 6, 'rgba(22,37,49,.14)');
  if (s.type === 'tree') {
    ctx.fillStyle = '#8e786e'; rounded(-4, -47, 8, 48, 3); ctx.fill();
    ellipse(-13, -50, 23, 30, z.hill); ellipse(12, -55, 24, 29, z.ground);
    ellipse(0, -71, 23, 26, z.ground);
    ctx.globalAlpha = .16; ellipse(-7, -76, 11, 17, '#fff1c9'); ctx.globalAlpha = 1;
    if (s.seed % 3 === 0) { ellipse(13, -53, 4, 4, '#e8a99d'); ellipse(-11, -60, 3, 3, '#f2c5a6'); }
  } else if (s.type === 'flowers') {
    for (let i = 0; i < 5; i++) {
      const x = (i - 2) * 10, y = -8 - (i % 3) * 4;
      ctx.strokeStyle = z.hill; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y); ctx.stroke();
      ellipse(x, y, 5, 4, i % 2 ? '#ed9da8' : '#f9dab0'); ellipse(x, y, 1.6, 1.6, '#fff0d0');
    }
  } else if (s.type === 'rock') {
    polygon([[-26, 0], [-20, -18], [-5, -26], [19, -20], [27, 0]], '#9594a0');
    polygon([[-20, -18], [-5, -26], [19, -20], [2, -8]], '#c4b8b4');
  } else if (s.type === 'lamp') {
    ctx.strokeStyle = '#68788b'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -94); ctx.quadraticCurveTo(0, -105, 17, -101); ctx.stroke();
    ctx.fillStyle = '#70899b'; rounded(9, -106, 20, 8, 4); ctx.fill();
    ellipse(19, -97, 8, 3, '#ffe9b1');
    if (z.night > .01) {
      ctx.globalAlpha = z.night * .12;
      polygon([[15, -96], [24, -96], [60, 0], [-19, 0]], '#ffe1a0');
      ellipse(21, 0, 37, 9, '#ffe1a0'); ctx.globalAlpha = 1;
    }
  } else if (s.type === 'lab') {
    ctx.fillStyle = '#bdd6d0'; rounded(-40, -65, 80, 65, 9); ctx.fill();
    polygon([[-40, -65], [-24, -78], [55, -78], [40, -65]], '#e2e5d7');
    polygon([[40, -65], [55, -78], [55, -10], [40, 0]], '#91b4b7');
    ctx.fillStyle = '#6c95a6'; rounded(-29, -51, 56, 21, 5); ctx.fill();
    ctx.fillStyle = '#deeee7'; ctx.fillRect(-3, -51, 3, 21);
    ctx.fillStyle = '#78a2aa'; rounded(-10, -20, 21, 20, 3); ctx.fill();
    ellipse(0, -65, 7, 7, '#f0be9e');
  } else if (s.type === 'flask') {
    ctx.fillStyle = '#d5e9e4'; rounded(-6, -75, 12, 32, 3); ctx.fill();
    ctx.fillStyle = '#bddeda'; ctx.beginPath(); ctx.moveTo(-6, -45); ctx.lineTo(-28, -8); ctx.quadraticCurveTo(-31, 0, -20, 0); ctx.lineTo(20, 0); ctx.quadraticCurveTo(31, 0, 27, -8); ctx.lineTo(6, -45); ctx.closePath(); ctx.fill();
    polygon([[-19, -21], [19, -21], [25, -7], [-25, -7]], '#94c1ae');
    ctx.fillStyle = '#f1edda'; rounded(-9, -77, 18, 5, 2); ctx.fill();
    ellipse(-5, -16, 3, 3, '#deedda'); ellipse(7, -12, 2, 2, '#deedda');
  } else {
    polygon([[-18, 0], [-26, -24], [-15, -49], [0, -30], [11, -62], [24, -34], [20, 0]], '#999fc7');
    polygon([[0, 0], [0, -30], [11, -62], [12, -17]], '#c5bbe2');
    if (z.night > .01) { ctx.globalAlpha = z.night * .2; ellipse(0, 0, 30, 6, '#f2bde5'); }
  }
  ctx.restore();
}

function drawHazard(h) {
  if (h.hit) return;
  const p = project(h.progress, h.x); if (!p) return;
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(p.scale, p.scale);
  ellipse(3, 1, obstacleSpec[h.type].width + 4, 5, 'rgba(23,28,42,.23)');
  if (h.type === 'cone') {
    ctx.fillStyle = '#364455'; rounded(-20, -2, 40, 7, 3); ctx.fill();
    polygon([[0, -35], [-15, 0], [15, 0]], '#eb925f');
    polygon([[0, -35], [0, 0], [15, 0]], '#ce7357');
    polygon([[-7, -18], [7, -18], [10, -11], [-10, -11]], '#fff0d4');
    ellipse(0, 0, 14, 3, '#d07855');
  } else if (h.type === 'crate') {
    ctx.fillStyle = '#b98662'; rounded(-22, -36, 44, 35, 3); ctx.fill();
    polygon([[-22, -36], [-13, -45], [28, -45], [22, -36]], '#e3b587');
    polygon([[22, -36], [28, -45], [28, -8], [22, -1]], '#986d57');
    ctx.strokeStyle = '#e7b990'; ctx.lineWidth = 3; ctx.strokeRect(-17, -32, 33, 26);
    ctx.beginPath(); ctx.moveTo(-16, -31); ctx.lineTo(15, -7); ctx.moveTo(15, -31); ctx.lineTo(-16, -7); ctx.stroke();
  } else if (h.type === 'barrier') {
    ctx.fillStyle = '#9aa5b1'; rounded(-28, -24, 6, 25, 2); ctx.fill(); rounded(22, -24, 6, 25, 2); ctx.fill();
    ellipse(-25, 1, 10, 3, '#526174'); ellipse(25, 1, 10, 3, '#526174');
    ctx.fillStyle = '#f4dfc8'; rounded(-35, -39, 70, 19, 4); ctx.fill();
    ctx.save(); rounded(-35, -39, 70, 19, 4); ctx.clip();
    for (let i = -45; i < 36; i += 22) polygon([[i, -20], [i + 14, -39], [i + 25, -39], [i + 11, -20]], '#dd8b7e');
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-30, -37); ctx.lineTo(30, -37); ctx.stroke();
  } else {
    ellipse(0, 0, 31, 11, '#29374b'); ellipse(-9, -2, 17, 6, '#3f4662');
    ctx.strokeStyle = '#9690b3'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(-3, -2, 18, 5, 0, Math.PI, TAU - .5); ctx.stroke();
    ellipse(21, 7, 7, 2.5, '#29374b');
  }
  ctx.restore();
}

function drawPowerCapsule(p) {
  if (p.got || p.missed) return;
  const bob = 3 + Math.sin(roadTime * 2.8 + p.phase) * 2;
  const pr = project(p.progress, p.x, p.height + bob), ground = project(p.progress, p.x);
  if (!pr) return;
  ctx.save();
  // Shadow stays on the road, separate from the capsule's bob and rotation.
  const shadow = clamp(1 - p.height / 160, .4, 1);
  ellipse(ground.x, ground.y, 16 * pr.scale * shadow, 4 * pr.scale * shadow, 'rgba(20,30,45,.2)');
  if (pr.distance < 550) {
    ctx.globalAlpha = .12 + .08 * Math.sin(roadTime * 4 + p.phase);
    ellipse(ground.x, ground.y, 23 * pr.scale, 6 * pr.scale, p.power.color);
    ctx.globalAlpha = 1;
  }
  if (p.attracting) {
    const car = project(player.progress, player.x, player.jumpY + 24);
    const middle = project((p.progress + player.progress) / 2, (p.x + player.x) / 2 + 30, (p.height + player.jumpY) / 2 + 20);
    if (middle) {
      ctx.strokeStyle = 'rgba(240,184,164,.45)'; ctx.lineWidth = Math.max(.45, pr.scale);
      ctx.beginPath(); ctx.moveTo(pr.x, pr.y); ctx.quadraticCurveTo(middle.x, middle.y, car.x, car.y); ctx.stroke();
    }
  }
  ctx.translate(pr.x, pr.y); ctx.scale(pr.scale, pr.scale);
  const spin = roadTime * 2.1 + p.phase;
  ctx.rotate(Math.sin(spin) * .11); ctx.scale(.7 + .3 * Math.abs(Math.cos(spin)), 1);
  if (pr.distance < 550) { ctx.shadowColor = p.power.color; ctx.shadowBlur = 9 * pr.scale; }
  const body = ctx.createLinearGradient(-13, 0, 13, 0);
  body.addColorStop(0, p.power.color); body.addColorStop(.4, '#fff2df'); body.addColorStop(.75, p.power.color); body.addColorStop(1, '#67808d');
  ctx.fillStyle = body; rounded(-13, -22, 26, 43, 12); ctx.fill(); ctx.shadowBlur = 0;
  ctx.save(); rounded(-13, -22, 26, 43, 12); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,.66)'; ctx.fillRect(-14, -23, 28, 20);
  ctx.fillStyle = p.power.color; ctx.fillRect(-14, 3, 28, 19); ctx.restore();
  ctx.strokeStyle = 'rgba(255,251,234,.85)'; ctx.lineWidth = 1.2; rounded(-13, -22, 26, 43, 12); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.57)'; rounded(-9, -16, 3, 12, 2); ctx.fill();
  ctx.fillStyle = '#334150'; ctx.font = '800 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.power.symbol, 0, 4);
  ctx.restore();
}

function drawPlayer(z) {
  const ground = project(player.progress, player.x), pr = project(player.progress, player.x, player.jumpY);
  const jumpFraction = clamp(player.jumpY / 95, 0, 1);
  // Contact, shadow and body share the same projected position; only body height changes.
  ellipse(ground.x + 2, ground.y + 2 * ground.scale, (36 - jumpFraction * 12) * ground.scale,
    (10 - jumpFraction * 3) * ground.scale, 'rgba(20,29,45,' + (.28 - jumpFraction * .12) + ')');
  if (effectLevel.glow > .01) {
    ctx.globalAlpha = effectLevel.glow * .45;
    ellipse(ground.x, ground.y, 48 * ground.scale, 14 * ground.scale, '#df84d1');
    ctx.globalAlpha = effectLevel.glow * .12;
    ellipse(ground.x, ground.y, 64 * ground.scale, 19 * ground.scale, '#f8b6ee'); ctx.globalAlpha = 1;
  }
  const bounce = player.grounded && state !== 'ended' ? Math.sin(roadTime * 17) * 1.15 * (player.speed / 160) : 0;
  const land = player.landing > 0 ? Math.sin(player.landing / .3 * Math.PI) : 0;
  const prep = player.jumpPrep > 0 ? 1 - player.jumpPrep / .085 : 0;
  const squash = 1 - land * .1 - prep * .12;
  ctx.save(); ctx.translate(pr.x, pr.y); ctx.scale(pr.scale, pr.scale);
  if (player.hitFlash > 0) ctx.globalAlpha = .65 + .35 * Math.sin(player.hitFlash * 33);
  // Wheels remain at the ground contact while the sprung body compresses above them.
  for (const side of [-1, 1]) {
    ctx.save(); ctx.translate(side * 29, -9); ctx.rotate(player.lean * .25);
    ctx.fillStyle = '#29384a'; rounded(-7, -12, 14, 25, 6); ctx.fill();
    ctx.fillStyle = '#687c8e'; rounded(side < 0 ? -7 : 3, -7, 4, 15, 2); ctx.fill();
    ctx.strokeStyle = '#43576b'; ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) { const y = ((roadTime * player.speed * .28 + i * 8) % 23) - 12; ctx.beginPath(); ctx.moveTo(-5, y); ctx.lineTo(5, y); ctx.stroke(); }
    ctx.restore();
  }
  ctx.save(); ctx.translate(0, -bounce + land * 2); ctx.rotate(-player.lean); ctx.scale(1 + (1 - squash) * .22, squash);
  // Small rear-facing roadster with a raised cockpit and visible driver.
  const body = ctx.createLinearGradient(-32, -45, 24, 1);
  body.addColorStop(0, '#ffd0c7'); body.addColorStop(.4, '#ee9ca9'); body.addColorStop(1, '#d77593');
  ctx.fillStyle = '#c26585'; rounded(-32, -35, 64, 37, 13); ctx.fill();
  ctx.fillStyle = body; rounded(-34, -41, 68, 38, 15); ctx.fill();
  ctx.fillStyle = '#b65f7e'; rounded(-23, -52, 46, 28, 12); ctx.fill();
  const glass = ctx.createLinearGradient(0, -51, 0, -27); glass.addColorStop(0, '#c6ece7'); glass.addColorStop(1, '#83b6bf');
  ctx.fillStyle = glass; rounded(-19, -49, 38, 22, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-13, -44); ctx.lineTo(4, -44); ctx.stroke();
  // A scarf, tiny spikes, blink and snout make the driver read as a character.
  ctx.save(); ctx.translate(player.lean * 8, -1 + Math.sin(roadTime * 5) * .5);
  polygon([[-7, -50], [-30, -49 + Math.sin(roadTime * 10) * 3], [-23, -42], [-3, -45]], '#f4c782');
  ctx.fillStyle = '#80b291'; rounded(-10, -64, 26, 22, 10); ctx.fill();
  ctx.fillStyle = '#9aca9d'; rounded(-6, -74, 26, 24, 11); ctx.fill();
  ctx.fillStyle = '#abd4a7'; rounded(9, -66, 17, 14, 6); ctx.fill();
  polygon([[-8, -64], [-16, -66], [-9, -72]], '#658d81');
  polygon([[-4, -72], [-8, -81], [3, -74]], '#658d81');
  ellipse(11, -67, 3.5, 4, '#fffae5');
  const blink = roadTime % 4.8 > 4.65;
  ellipse(12, -67, 1.5, blink ? .5 : 2, '#2d4651');
  ellipse(22, -60, .9, .9, '#527969'); ellipse(14, -56, 3.5, 2, '#e6b5a0');
  ctx.strokeStyle = '#587d6e'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(19, -55); ctx.quadraticCurveTo(22, -54, 24, -56); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#eda1ac'; rounded(-23, -32, 46, 16, 7); ctx.fill();
  ctx.strokeStyle = '#f9c1c2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-26, -16); ctx.quadraticCurveTo(0, -9, 26, -16); ctx.stroke();
  ctx.fillStyle = '#fbddd0'; rounded(-31, -12, 62, 7, 3); ctx.fill();
  ctx.fillStyle = state === 'finishing' ? '#ff826e' : '#f19b89';
  rounded(-27, -20, 12, 7, 3); ctx.fill(); rounded(15, -20, 12, 7, 3); ctx.fill();
  ctx.fillStyle = '#fff3db'; rounded(-9, -13, 18, 7, 3); ctx.fill();
  ellipse(0, -9.5, 2, 2, '#cc83a1');
  ctx.fillStyle = '#9b7186'; rounded(-23, 0, 8, 4, 2); ctx.fill(); rounded(15, 0, 8, 4, 2); ctx.fill();
  if (effectLevel.boost > .01) {
    ctx.globalAlpha *= effectLevel.boost;
    for (const side of [-1, 1]) {
      const length = 9 + (Math.sin(roadTime * 32) + 1) * 5;
      ellipse(side * 19, 5, 4, length / 2, '#f3b272'); ellipse(side * 19, 3, 2, length / 3, '#ffe7b0');
    }
  }
  ctx.restore(); ctx.restore();
  drawCarEffects(pr, z);
}

function drawCarEffects(pr, z) {
  ctx.save(); ctx.translate(pr.x, pr.y - 27 * pr.scale); ctx.scale(pr.scale, pr.scale);
  if (pickupPulse > 0) {
    const t = 1 - pickupPulse / .5;
    ctx.globalAlpha = (1 - t) * .55; ctx.strokeStyle = pickupColor; ctx.lineWidth = 2 * (1 - t) + .5;
    ctx.beginPath(); ctx.ellipse(0, 0, 34 + t * 38, 43 + t * 28, 0, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
  }
  const shield = Math.max(effectLevel.shield, player.shieldFlash * 1.4);
  if (shield > .01) {
    ctx.globalAlpha = shield;
    const bubble = ctx.createRadialGradient(-17, -19, 5, 0, 0, 58);
    bubble.addColorStop(0, 'rgba(214,254,246,.015)'); bubble.addColorStop(.82, 'rgba(175,239,238,.05)'); bubble.addColorStop(1, 'rgba(177,243,241,.21)');
    ctx.fillStyle = bubble; ctx.beginPath(); ctx.ellipse(0, -3, 46, 54, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = player.shieldFlash > 0 ? '#edfff6' : 'rgba(200,250,246,.75)'; ctx.lineWidth = 1.8 + player.shieldFlash * 4; ctx.stroke();
    ctx.strokeStyle = 'rgba(245,255,247,.62)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(0, -3, 40, 48, 0, 3.65, 4.45); ctx.stroke();
    for (let i = 0; i < 4; i++) { const a = roadTime * 1.2 + i * TAU / 4; ellipse(Math.cos(a) * 46, -3 + Math.sin(a) * 53, 1.8, 1.8, '#d9fbeb'); }
  }
  if (effectLevel.magnet > .01) {
    ctx.globalAlpha = effectLevel.magnet * .55;
    ctx.strokeStyle = '#f2c6ad'; ctx.lineWidth = 1.15;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const wave = (roadTime * .8 + i * .5) % 1, x = side * (43 + wave * 23);
        ctx.globalAlpha = effectLevel.magnet * (1 - wave) * .6;
        ctx.beginPath(); ctx.moveTo(x, -30); ctx.quadraticCurveTo(x + side * 14, -4, x, 22); ctx.stroke();
      }
      ellipse(side * 42, Math.sin(roadTime * 4) * 15, 1.5, 1.5, '#f1c5b5');
    }
  }
  ctx.restore();
}

function drawFinish() {
  const distance = FINISH - player.progress;
  if (distance > DRAW_DISTANCE || distance < -135) return;
  const cell = ROAD_HALF * 2 / 12;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 12; i++) roadQuad(FINISH + row * 16, FINISH + (row + 1) * 16,
      -ROAD_HALF + i * cell, -ROAD_HALF + (i + 1) * cell, (i + row) % 2 ? '#3b4660' : '#fff2df');
  }
  const p = project(FINISH, 0); if (!p) return;
  ctx.save(); ctx.translate(p.x, p.y); ctx.scale(p.scale, p.scale);
  for (const side of [-1, 1]) {
    ellipse(side * 162, 0, 14, 5, 'rgba(21,28,46,.22)');
    ctx.fillStyle = '#bbadc8'; rounded(side * 162 - 4, -166, 8, 167, 3); ctx.fill();
    ellipse(side * 162, -165, 6, 6, '#ffdab8');
  }
  ctx.fillStyle = '#f5d3d0'; rounded(-168, -174, 336, 31, 9); ctx.fill();
  ctx.fillStyle = '#6c5778'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '800 14px system-ui'; ctx.fillText('FINISH', 0, -158);
  for (let i = 0; i < 8; i++) {
    const x = -139 + i * 40;
    polygon([[x, -137], [x + 17, -137], [x + 9, -122 + Math.sin(roadTime * 3 + i) * 2]], i % 2 ? '#a8dcd8' : '#eeb8c9');
  }
  ctx.restore();
}
function drawRing(r) {
  const t = r.age / r.life, radius = lerp(12, r.radius, t);
  ctx.strokeStyle = r.color; ctx.globalAlpha = (1 - t) * .38;
  const pr = project(r.progress, r.x); if (!pr) { ctx.globalAlpha = 1; return; }
  ctx.lineWidth = Math.max(.6, 2 * pr.scale * (1 - t)); ctx.beginPath();
  // Sample a ring on the ground plane, rather than overlaying a flat screen circle.
  for (let i = 0; i <= 24; i++) {
    const angle = i / 24 * TAU;
    const p = project(r.progress + Math.sin(angle) * radius * .45, r.x + Math.cos(angle) * radius, .5);
    if (!p) continue;
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
}
function drawParticle(p) {
  const pr = project(p.progress, p.x, p.height); if (!pr) return;
  ctx.globalAlpha = Math.pow(1 - p.age / p.life, .8);
  ellipse(pr.x, pr.y, p.size * pr.scale, p.size * pr.scale, p.color); ctx.globalAlpha = 1;
}
function draw() {
  const scale = canvas.width / VW;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const z = palette(); drawSky(z);
  ctx.save();
  // Tiny camera movement affects the entire world together, including shadows.
  if (!reducedMotion) {
    const strength = shake * 5 + effectLevel.boost * .32;
    ctx.translate(Math.sin(roadTime * 71) * strength, Math.cos(roadTime * 67) * strength * .65);
  }
  drawRoad(z);
  const visible = [];
  for (const s of scenery) if (s.progress > player.progress - 135 && s.progress < player.progress + DRAW_DISTANCE) visible.push({p: s.progress, draw: () => drawScenery(s, z)});
  for (const h of hazards) if (!h.hit && h.progress > player.progress - 135 && h.progress < player.progress + DRAW_DISTANCE) visible.push({p: h.progress, draw: () => drawHazard(h)});
  for (const p of pickups) if (!p.got && !p.missed && p.progress > player.progress - 135 && p.progress < player.progress + DRAW_DISTANCE) visible.push({p: p.progress - .1, draw: () => drawPowerCapsule(p)});
  for (const p of particles) visible.push({p: p.progress, draw: () => drawParticle(p)});
  for (const r of rings) visible.push({p: r.progress + .2, draw: () => drawRing(r)});
  visible.push({p: FINISH, draw: drawFinish});
  visible.push({p: player.progress - .05, draw: () => drawPlayer(z)});
  visible.sort((a, b) => b.p - a.p);
  visible.forEach(o => o.draw());
  ctx.restore();
}

function startGame() {
  initAudio(); reset(); state = 'countdown'; countdown = 3;
  $('start').classList.add('hidden'); $('end').classList.add('hidden');
  hud.classList.add('show'); controls.classList.remove('show');
  last = performance.now(); resize(); sound(400, .13, 'sine', .025);
}
function pauseGame() {
  if (paused || !['driving', 'countdown', 'finishing'].includes(state)) return;
  paused = true; controls.classList.remove('show'); powerEl.classList.remove('show');
  $('pause').classList.remove('hidden'); $('countdown').textContent = '';
  if (masterGain && audioCtx) masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
}
function resumeGame() {
  if (!paused) return;
  initAudio(); paused = false; last = performance.now(); accumulator = 0;
  if (masterGain && audioCtx) masterGain.gain.setValueAtTime(muted ? 0 : 1, audioCtx.currentTime);
  $('pause').classList.add('hidden');
  controls.classList.toggle('show', state === 'driving'); updateHUD(); resize();
}
function bindPress(id, fn) {
  const el = $(id);
  el.addEventListener('pointerdown', event => {
    event.preventDefault(); event.stopPropagation();
    if (event.isPrimary === false && event.pointerType === 'mouse') return;
    fn();
  });
  // Keyboard / assistive activation gets one action; touch's synthetic click gets none.
  el.addEventListener('click', event => { if (event.detail === 0) fn(); });
}
bindPress('leftBtn', () => moveLane(-1)); bindPress('jumpBtn', jump); bindPress('rightBtn', () => moveLane(1));
$('startBtn').addEventListener('click', startGame); $('againBtn').addEventListener('click', startGame);
$('resumeBtn').addEventListener('click', resumeGame);
$('sound').addEventListener('click', () => {
  initAudio(); muted = !muted;
  $('sound').textContent = muted ? '♪̸' : '♪';
  $('sound').setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound'); $('sound').setAttribute('aria-pressed', String(muted));
  if (masterGain && audioCtx) masterGain.gain.setValueAtTime(muted ? 0 : 1, audioCtx.currentTime);
});
document.addEventListener('keydown', event => {
  const key = event.code;
  if (key === 'Escape') { event.preventDefault(); if (paused) resumeGame(); else pauseGame(); return; }
  if (paused || state !== 'driving' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'KeyA', 'KeyD', 'KeyW'].includes(key)) return;
  if (event.target.tagName === 'BUTTON' && ['sound', 'resumeBtn', 'againBtn', 'startBtn'].includes(event.target.id)) return;
  event.preventDefault(); if (event.repeat) return;
  if (key === 'ArrowLeft' || key === 'KeyA') moveLane(-1);
  else if (key === 'ArrowRight' || key === 'KeyD') moveLane(1); else jump();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); last = performance.now(); accumulator = 0; });
window.addEventListener('blur', pauseGame);
window.addEventListener('pagehide', pauseGame);
document.addEventListener('gesturestart', event => event.preventDefault(), {passive: false});
$('app').addEventListener('contextmenu', event => event.preventDefault());

function frame(t) {
  const elapsed = Math.min(.1, Math.max(0, (t - last) / 1000)); last = t;
  if (!paused && !document.hidden) {
    accumulator += elapsed;
    while (accumulator >= STEP) { update(STEP); accumulator -= STEP; }
    draw();
  }
  requestAnimationFrame(frame);
}
resize(); reset(); requestAnimationFrame(frame);
})();
