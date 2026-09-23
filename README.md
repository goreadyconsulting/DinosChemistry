# Dino's Chemistry

A small, finishable driving adventure for portrait mobile screens. One dinosaur,
one car, three lanes, and four chemistry reactions. Runs directly on GitHub Pages
without a build step, backend, downloads, fonts or third-party runtime dependencies.

[Play](https://goreadyconsulting.github.io/DinosChemistry/)

## Controls

Use the fixed **Left / Jump / Right** buttons. Desktop players can use arrow keys
or A/D, with Space, Up or W to jump. Escape pauses/resumes. Leaving the page or
switching apps pauses the journey; **Keep driving** resumes it without advancing
the road while away. The sound toggle stays available during play.

## Journey

Garden Road, Chem Lab Pass, Sunset Bend and Neon Night blend through one drive.
A normal drive takes about five minutes. Bumps slow the car instead of ending the
journey. A clear approach leads to a finish arch, a short coast and the ending card.

| Capsule | Reaction | Duration |
| --- | --- | --- |
| O | Oxygen speed boost | 6 seconds |
| C | Carbon collision shield | 9 seconds; impacts use 3 seconds |
| Ne | Neon road and car glow | 8 seconds |
| Fe | Iron capsule attraction | 8 seconds |

Reactions can overlap. Each has its own HUD timer and a smooth visual exit.
Raised capsules reward jumping; captured magnetic pulls complete smoothly even
when the magnet timer runs out.

## Files and local development

- `index.html`: screens, HUD and controls.
- `style.css`: responsive UI and safe-area layout.
- `game.js`: course, fixed-step simulation, synthesized audio and Canvas artwork.
- `tests/game.test.cjs`: dependency-free Node regression tests.

Serve this folder with any static server, for example:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. There is no install or build step.

```sh
node --check game.js
node --test tests/game.test.cjs
```

The tests run full journeys, verify timing and collision/jump behavior, check
course spacing and power-up lifecycles, and exercise drawing coordinates at six
viewport sizes. They use a mock Canvas/DOM, so they do not replace browser or
physical-device visual, audio and touch testing.

## Rendering and pacing notes

`roadGeom(distance)` is the shared perspective camera. Its scale is
`300 / (300 + distance)`. Both world objects and road strips use that projection.
Relative distance zero is the player's contact plane and the swept collision
crossing. World height is projected separately from the grounded shadow.
Lane centres are -100, 0 and 100 inside a road half-width of 150.

Physics advances in 1/60-second steps. Slow frames are bounded to avoid unfair
catch-up jumps, rendering uses a uniform scale at a maximum 2x device pixel ratio,
and only visible objects enter depth sorting. Particle and ring counts are capped.
Reduced-motion preferences disable camera shake and extra speed streaks.

The 47,000-unit route takes approximately 4.3 to 5.2 minutes in the automated
constant-boost and normal-speed runs. Obstacle rows always leave a lane open and
are at least 260 units apart, more than 1.3 seconds at the maximum speed. The last
2,500 units are clear of hazards. Audio starts only after an explicit interaction.
