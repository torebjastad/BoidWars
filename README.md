# Boids Suite (vanilla WebGPU)

Flocking boids simulated and rendered entirely on the GPU with WebGPU, in plain JavaScript and WGSL: no build step, no dependencies beyond [lil-gui](https://lil-gui.georgealways.com/) (loaded from a CDN by the simulator).

Started as a port of the [TypeGPU boids example](https://github.com/software-mansion/TypeGPU/tree/1d2b8eaeae10abfddc3cf0e9aa930de05b139c0b/apps/typegpu-docs/src/examples/simulation/boids).

## Running

ES modules and WebGPU need a page served over `http://localhost`, not opened from disk. Any static server works, for example:

```bash
python -m http.server 8123
```

Then open <http://localhost:8123> in a WebGPU-capable browser (recent Chrome or Edge; Firefox and Safari need WebGPU enabled).

## What's in it

**Simulator** (`simulator.html`): a sandbox of up to 20,000 boids in a wrap-around world.
- Tune separation, alignment and cohesion live in the lil-gui panel, or pick a preset (`game`, `mosquitoes`, `blobs`, `particles`, `nanites`).
- Hold the mouse button to attract the boids, and scroll to zoom.

**Game** (`game.html`): *Pack Leader*, a flock-eats-flock arena game.
- Your blue flock follows the cursor. Grow by eating food and devouring smaller flocks while 15 AI flocks, each with its own personality, do the same.
- A flock can eat another that it outnumbers by 1.2× and at least 3 boids. Rings and edge arrows show what is prey (green) and what is a threat (red).
- **Pulse** (`Space` or right click) spreads your flock out to sweep up food. **Dash** (`Shift` or left click) gives a burst of speed.
- The game opens with a 20 s truce. The arena then shrinks in stages, and you win by being the last flock standing, or the largest when the final 60 s countdown ends.
- Easy, Normal and Hard difficulties.

See [GAME_DESIGN.md](GAME_DESIGN.md) for the rules, the balance reasoning and the tuning knobs.

## Files

| File | Role |
| --- | --- |
| `engine.js` | `BoidsEngine`: WebGPU setup, buffers, spatial grid, the compute and render passes each frame, and `readData()` for reading boid data back to the CPU |
| `shaders.js` | All WGSL: the spatial grid passes, the boid compute pass, boid rendering, and the arena border and grid lines |
| `simulator.js` | Simulator page: GUI, presets, mouse and zoom |
| `game.js` | Game rules: food economy, straggler stealing, upkeep, shrinking arena, abilities, input, camera, leaderboard. All tuning constants are at the top |
| `ai.js` | Enemy flock AI: flee/hunt/forage decisions, personalities and difficulty levels |
| `hud.js` | 2D overlay: prey and threat rings, off-screen arrows, minimap, ability cooldowns, timer, event feed |
| `flockNames.js` | Names of the enemy flocks |
| `boidSimParams.txt` | Notes on earlier parameter presets |

Each boid is a struct in a storage buffer. It holds `position` and `velocity`; in game mode it also has `packId`, `captureTime`, `prevPackId` and `inertUntil`. Two copies of the buffer swap roles every step: compute reads one and writes the other, and rendering draws from the result.

In game mode:
- The simulation runs at a fixed 60 steps per second, whatever the monitor's refresh rate.
- The buffer has a fixed 6,000 slots, and unused slots have `packId` -1.
- Each flock is steered through a small uniform array (target point, speed cap, Pulse state, and which flocks can eat it).
- Eating food and smaller flocks happens in the compute shader on every step.
- `game.js` reads the buffer back about 10 times per second for the AI, straggler stealing, upkeep and food respawn. It writes back only the fields of the boids it changes (`patchBoid`), so the rest of the simulation is never rolled back.

## Neighbor search: the spatial grid

Checking every boid against every other costs O(n²). Instead, each frame starts by bucketing the boids into a uniform grid, keyed by (cell, pack). This runs as a counting sort, with all passes in one compute pass:

1. `gridCount`: each boid finds its key and takes a slot in it with `atomicAdd`.
2. `gridScan`: one workgroup computes the exclusive prefix sum of the key counts, giving each key its start offset.
3. `gridScatter`: each boid writes its index, position and velocity to its sorted slot.
4. `gridAggregate` and `gridCoarse`: compute the position sum and boid count of each fine cell, then of each coarse block of k×k fine cells.
5. `mainCompute`: one thread per boid, in sorted order so threads in the same workgroup read nearby memory.
   - Separation, alignment and food sensing read the 3×3 fine cells around the boid. The fine cell size is at least each of those radii.
   - Cohesion has a much larger radius. Blocks and cells fully inside it add their precomputed sums, and only cells that cross its edge are checked boid by boid.

The results match the original brute-force loop up to float rounding (about 1e-6). `updateSpatialGrid()` in `engine.js` picks the cell size and block factor from the current parameters, so GUI changes are handled automatically.

Measured compute time per step, before and after the grid, on the development machine (simulator `game` preset):

| Boids | Brute force | Grid | Speedup |
| ---: | ---: | ---: | ---: |
| 4,000 | 1.0 ms | 0.5 ms | 2× |
| 20,000 | 6.5 ms | 1.8 ms | 3.6× |
| 50,000 | 41 ms | 4.5 ms | 9× |

## Tuning notes

- Distance parameters scale with `triangleSize`. If you change the boid size, scale `separationDistance`, `alignmentDistance` and `cohesionDistance` by the same factor; the strength parameters stay the same.
- In the game, a new pack id must stay below `packCount`, which is set in `GAME_PARAMS` to `ENEMY_FLOCK_COUNT + 2` (player 0, food 1, then the enemies).
- If you change the food sensing radius (`0.8`) in `shaders.js`, update `FOOD_SENSE_RADIUS` in `engine.js` to match.
