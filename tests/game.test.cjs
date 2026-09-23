'use strict';
// Dependency-free regression tests. Test access is injected into a VM only;
// the shipped game has no debug API, shortcuts or automatic driving mode.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');

function boot(width = 390, height = 844) {
  let drawCalls = 0;
  const noop = (...args) => {
    drawCalls++;
    args.forEach(a => { if (typeof a === 'number') assert.ok(Number.isFinite(a), 'Canvas coordinates must be finite'); });
  };
  const ctx = new Proxy({}, {get: (o, key) => {
    if (key in o) return o[key];
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return (...args) => { noop(...args); return {addColorStop: noop}; };
    return noop;
  }});
  const elements = new Map(), docEvents = {}, winEvents = {};
  function element(id) {
    const classes = new Set();
    return {id, tagName: 'DIV', textContent: '', children: [], attrs: {}, events: {},
      style: {setProperty() {}},
      classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle: (c, on) => on ? classes.add(c) : classes.delete(c)},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(child) { this.children.push(child); },
      addEventListener(k, fn) { this.events[k] = fn; }, focus() {},
      getContext: () => ctx,
      getBoundingClientRect: () => ({width, height, top: id === 'controls' ? height - 92 : 0, left: 0})
    };
  }
  const document = {hidden: false,
    getElementById: id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement: tag => element(tag), addEventListener: (key, fn) => docEvents[key] = fn};
  const window = {devicePixelRatio: 2, matchMedia: () => ({matches: false}), addEventListener: (key, fn) => winEvents[key] = fn};
  const context = vm.createContext({document, window, navigator: {}, performance: {now: () => 0}, requestAnimationFrame() {}, console});
  const instrumented = source.replace(/\}\)\(\);\s*$/, `
    globalThis.testGame = {player, powers, effectLevel, FINISH, STEP, LANES, ROAD_HALF,
      project, roadGeom, buildTrack, reset, update, draw, startGame, moveLane, jump,
      activate, collide, updateHUD, palette, pauseGame, resumeGame, resize,
      get state(){return state}, get paused(){return paused}, get bumps(){return bumps},
      get collected(){return collected}, get hazards(){return hazards}, get pickups(){return pickups},
      get rings(){return rings}, get particles(){return particles}, get VH(){return VH},
      get HORIZON(){return HORIZON}, get CAMERA_HEIGHT(){return CAMERA_HEIGHT},
      driving(){state='driving'}, setCourse(h,p){hazards=h;pickups=p},
      setPosition(p){player.progress=p}, get drawCalls(){return 0}
    };
  })();`);
  vm.runInContext(instrumented, context);
  const g = context.testGame;
  g.startGame(); for (let i = 0; i < 181; i++) g.update(1 / 60);
  return {g, elements, docEvents, winEvents, document, calls: () => drawCalls};
}
const advance = (g, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds - dt / 2; t += dt) g.update(dt); };
function hazard(progress, lane = 1, type = 'crate') { return {progress, lane, x: [-100, 0, 100][lane], type, hit: false, passed: false}; }

test('world objects and player meet at one collision plane and use lane centres', () => {
  const {g} = boot(); g.setPosition(1000);
  const car = g.project(1000, g.player.x);
  assert.equal(car.scale, 1);
  assert.equal(car.groundY, g.HORIZON + g.CAMERA_HEIGHT);
  [0, 100, 500, 1200, 2200].forEach(d => {
    const p = g.project(1000 + d, 100), road = g.roadGeom(d);
    assert.equal(p.groundY, road.y); assert.equal(p.scale, road.scale);
    assert.ok(Math.abs((p.x - road.center) / road.half - 2 / 3) < 1e-9);
    if (d > 0) { assert.ok(p.scale < 1); assert.ok(p.groundY < car.groundY); }
  });
  assert.equal(g.project(1000, 0, 80).groundY, car.groundY);
  assert.equal(g.project(1000, 0, 80).y, car.y - 80);
});

test('buttons keep three lanes, and collisions use eased position instead of target lane', () => {
  const {g, elements} = boot();
  g.setCourse([], []);
  elements.get('leftBtn').events.pointerdown({preventDefault(){}, stopPropagation(){}});
  assert.equal(g.player.lane, 0); assert.equal(g.player.x, 0);
  g.moveLane(-1); assert.equal(g.player.lane, 0);
  advance(g, .35); assert.ok(Math.abs(g.player.x + 100) < 1);
  g.moveLane(1); g.moveLane(1); g.moveLane(1); assert.equal(g.player.lane, 2);
  advance(g, .4); assert.ok(Math.abs(g.player.x - 100) < 1);
  g.player.x = 0; g.player.lane = 1; g.player.targetX = 0;
  const h = hazard(g.player.progress + 1);
  g.setCourse([h], []); g.moveLane(1); g.update(1 / 60);
  assert.ok(h.hit, 'A lane request must not instantly teleport the collision box');
});

test('contact occurs when the obstacle crosses the car, never early or behind it', () => {
  const {g} = boot(); g.player.progress = 0;
  const h = hazard(100); g.setCourse([h], []);
  advance(g, .5); assert.equal(h.hit, false); assert.equal(g.bumps, 0);
  advance(g, .3); assert.equal(h.hit, true); assert.equal(g.bumps, 1);
  advance(g, 1); assert.equal(g.bumps, 1);
});

test('jump has anticipation, clears a crate, shrinks its shadow height and lands', () => {
  const {g} = boot(); g.player.progress = 0;
  const h = hazard(82); g.setCourse([h], []);
  g.jump(); assert.ok(g.player.jumpPrep > 0); assert.equal(g.player.jumpY, 0);
  advance(g, .6); assert.ok(g.player.jumpY > 85); assert.equal(h.hit, false);
  advance(g, .6); assert.equal(g.player.grounded, true); assert.equal(g.player.jumpY, 0);
  assert.ok(g.player.landing > 0); assert.ok(g.rings.length > 0);
  assert.equal(g.bumps, 0);
});

test('jumping clears every appropriate hazard while ground contact still bumps', () => {
  for (const type of ['cone', 'crate', 'barrier', 'oil']) {
    const {g} = boot(); g.player.progress = 0; g.setCourse([hazard(82, 1, type)], []);
    g.jump(); advance(g, .7); assert.equal(g.bumps, 0, type);
    g.reset(); g.driving(); g.setCourse([hazard(12, 1, type)], []);
    advance(g, .2); assert.equal(g.bumps, 1, type);
  }
});

test('Carbon absorbs impact, each active power is represented, and all fade out', () => {
  const {g, elements} = boot(); g.setCourse([], []);
  g.powers.forEach(p => g.activate(p)); advance(g, .6); g.updateHUD();
  assert.equal(elements.get('power').children.filter(p => !p.hidden).length, 4);
  assert.ok(Object.values(g.effectLevel).every(level => level > .9));
  const h = hazard(g.player.progress); g.collide(h);
  assert.equal(g.bumps, 0); assert.equal(h.hit, true); assert.ok(g.player.shieldFlash > 0);
  assert.ok(g.player.shield < 9);
  advance(g, 12); g.updateHUD();
  assert.ok(Object.values(g.effectLevel).every(level => level < .001));
  assert.equal(elements.get('power').children.filter(p => !p.hidden).length, 0);
});

test('Iron moves capsules continuously in world space and finishes a captured pull', () => {
  const {g} = boot(); g.player.progress = 0;
  const p = {progress: 310, x: 100, lane: 2, height: 18, power: g.powers[2], phase: 0, got: false};
  g.setCourse([], [p]); g.activate(g.powers[3]);
  g.update(1 / 60);
  assert.ok(p.x > 0 && p.x < 100, 'Capsule must drift rather than switch lanes instantly');
  assert.equal(p.got, false); assert.equal(p.attracting, true);
  g.player.magnet = 0; advance(g, 2);
  assert.equal(p.got, true); assert.equal(g.collected, 2);
});

test('obstacle rows always leave a route and the last approach is clear', () => {
  const {g} = boot(); const rows = new Map();
  for (const h of g.hazards) {
    if (!rows.has(h.progress)) rows.set(h.progress, []);
    rows.get(h.progress).push(h.lane);
  }
  const distances = [...rows.keys()].sort((a, b) => a - b);
  for (const lanes of rows.values()) assert.ok(new Set(lanes).size <= 2);
  for (let i = 1; i < distances.length; i++) assert.ok((distances[i] - distances[i - 1]) / 195 >= 1.3);
  assert.ok(distances.at(-1) < g.FINISH - 2500);
  assert.ok(g.hazards.length > 120);
  for (let i = 0; i < 4; i++) assert.ok(g.pickups.some(p => p.power.kind === g.powers[i].kind));
});

test('every section boundary blends without a palette jump', () => {
  const {g} = boot();
  for (let section = 1; section <= 3; section++) {
    g.setPosition(g.FINISH * section / 4 - .001); const before = g.palette();
    g.setPosition(g.FINISH * section / 4 + .001); const after = g.palette();
    for (const key of ['sky1', 'sky2', 'road', 'ground', 'edge']) assert.equal(before[key], after[key], key);
    assert.ok(Math.abs(before.night - after.night) < .00001);
  }
});

test('complete journeys stay within 4 to 7 minutes, including constant boost and repeated bumps', () => {
  for (const mode of ['normal', 'boost', 'bumps']) {
    const {g} = boot();
    if (mode !== 'bumps') g.setCourse([], []);
    let elapsed = 0;
    while (g.state !== 'ended' && elapsed < 430) {
      if (mode === 'boost') g.player.boost = 6;
      g.update(1 / 60); elapsed += 1 / 60;
    }
    assert.equal(g.state, 'ended', mode);
    assert.ok(elapsed >= 240 && elapsed <= 420, mode + ': ' + elapsed);
    console.log(mode + ' journey: ' + elapsed.toFixed(1) + ' s, ' + g.bumps + ' bumps');
  }
});

test('finish crosses the line, coasts for four seconds, then offers a clean replay', () => {
  const {g, elements} = boot(); g.setCourse([], []); g.setPosition(g.FINISH - 2);
  g.update(1 / 60); assert.equal(g.state, 'finishing');
  const crossingSpeed = g.player.speed, crossingProgress = g.player.progress;
  advance(g, 2); assert.equal(g.state, 'finishing'); assert.ok(g.player.speed < crossingSpeed / 3);
  assert.ok(g.player.progress > crossingProgress);
  advance(g, 2.3); assert.equal(g.state, 'ended');
  assert.equal(elements.get('journey').attrs['aria-valuenow'], '100');
  g.startGame(); assert.equal(g.state, 'countdown'); assert.equal(g.player.progress, 0); assert.equal(g.collected, 0);
});

test('backgrounding freezes progress and effects until explicit resume', () => {
  const {g, document, docEvents} = boot();
  g.activate(g.powers[0]); document.hidden = true; docEvents.visibilitychange();
  const p = g.player.progress, boost = g.player.boost;
  advance(g, 20); assert.equal(g.player.progress, p); assert.equal(g.player.boost, boost);
  document.hidden = false; docEvents.visibilitychange(); assert.equal(g.paused, true);
  g.resumeGame(); advance(g, 1); assert.ok(g.player.progress > p); assert.ok(g.player.boost < boost);
});

test('all environments and effects render finite geometry at compact, tall and landscape sizes', () => {
  for (const [w, h] of [[320, 568], [360, 740], [390, 844], [430, 932], [520, 900], [700, 390]]) {
    const {g, calls} = boot(w, h);
    for (const position of [0, 10300, 14000, 23000, 29500, 37000, g.FINISH - 240]) {
      g.setPosition(position); g.powers.forEach(p => g.activate(p));
      g.update(1 / 60); g.draw(); g.jump(); advance(g, .3); g.draw();
    }
    assert.ok(calls() > 1000);
    assert.ok(g.project(g.player.progress).y < g.VH - 90 * 390 / w);
  }
});
