# Pack Leader: game design and balance

This document explains how the game is balanced, why, and which knobs to turn. All tuning constants live at the top of `game.js` (rules and economy) and `ai.js` (enemy behaviour).

## What was wrong before

- **Food grew without limit.** One new food was spawned on every logic pass (10 per second) whenever any enemy flock existed. The whole GPU buffer was also reallocated every 100 ms.
- **Start-of-game feeding frenzy.** There were 2,000 food in a 20×20 arena, and food was pulled in from 0.8 units away. The first seconds were a race to scoop up food.
- **Runaway growth with nothing to stop it.** A bigger flock sweeps a wider strip, so it eats faster and grows faster. Size had no downside: no upkeep and no speed cost.
- **Coin-flip early fights.** A 1.2× size ratio means 5 boids beat 4, so who ate whom was decided by a single food pickup.
- **Weak AI.** Enemies added up a pull toward every food, prey and threat at once, could see the whole map, aimed at where targets were (not where they were going), and steered by nudging velocities every 100 ms.
- **Inconsistent timing.** Physics ran once per screen refresh, so the game was 2.4× faster on a 144 Hz monitor. Captures were checked on the CPU 10 times per second, so whether a capture registered depended on timing.
- **No ending.** "Last flock standing" against small, equally fast flocks became long, dull chases.

## Design goals

1. **Skill over luck.** Outcomes should come from positioning, timing and reading the board, not from spawn luck or whoever grabbed the first food.
2. **No runaway leader.** Being big is strong but has costs, and there are always ways to catch up.
3. **A clear, fast arc:** grow (short truce, food) → skirmish (hunt and evade) → showdown (shrinking arena, time limit). A game lasts about 3–4 minutes.
4. **Readable.** You should always be able to see who you can eat and who can eat you.
5. **A bit hard.** Enemies use the same physics and abilities as you, so they don't cheat. Their limits are deliberate weaknesses you can exploit: limited sight, reaction time, aim error, and giving up on long chases.

## The systems

### Arena: big start, shrinking end
- **Size:** the arena starts at 28×28 (`ARENA_START = 14`, half-size). That's about twice the old area: room to manoeuvre, but encounters come quickly.
- **Shrinking:** `ZONE_SCHEDULE` shrinks it in three stages: to 20×20 at 0:50–1:20, to 14×14 by 2:20, and to 10×10 by 3:10 (big enough for a flock of thousands). The HUD counts down to each shrink, and the minimap shows the next border.
- **Final showdown:** after the last shrink, a 45-second countdown (`FINAL_SECONDS`) runs, and when it ends **the largest flock wins**. So games end by about 4 minutes even when a small flock keeps escaping.

### Opening truce
For the first 15 s (`TRUCE_SECONDS`), flocks can't eat or steal from each other. Everyone gets a fair start to grow, and nobody is eaten by a neighbour in the first seconds. The AI starts watching for threats 4 s before the truce ends.

### Food economy
- **Plentiful food.** There are 2 food per unit² (`FOOD_DENSITY`), and each food has a 75% chance to become a boid (`FOOD_VALUE`). Flocks start at 12 boids and grow into the hundreds within a minute, and the leaders reach 1,000–3,000 boids by the showdown.
- **Steady respawn.** Food respawns at 60/s (`FOOD_RESPAWN_RATE`) toward a target that scales with the current arena area. As the arena shrinks, there's less food in total.
- **Weaker pull.** Food drifts toward flock boids within 0.25 units (`FOOD_RADIUS`, was 0.8), so you have to actually sweep through it. That is what the **release burst** and **Pulse** are for.
- **Blooms:** from 0:20, every 15–25 s a patch of 300 food appears (`BLOOM_*`). Blooms are announced, and AI flocks head for them too, so they become contested hot spots that start fights.

### Eating
- **Who can eat whom:** a flock can eat another if it is at least **1.2×** its size **and at least 4 boids bigger** (`CONSUME_RATIO`, `CONSUME_MARGIN`). The margin removes coin-flip fights between small flocks.
- **Eating runs on the GPU every step.** A boid that touches a boid of a flock that can eat it switches sides. Food that touches a flock boid is eaten the same way. Results don't depend on frame rate.
- **Digest time (1.0 s):** a boid that just switched flocks can't convert others yet. Without this, one touch spread through the whole victim flock in under a second. Now eating happens where the flocks touch: a pass takes a bite, a full engulf takes everything, and a victim that reacts fast escapes with most of its flock.
- **Spill (35%):** of the boids a flock eats, 35% burst out as food instead of joining. The eater can't pick that food up for 1 s, but the victim and third parties can. Kills give a smaller jump, and every fight leaves a food spill for scavengers.
- **Stragglers:** a boid with no flockmate within 0.3 units can be stolen by any flock whose boid is in formation, regardless of size. Small flocks can pick off a big flock's stragglers, and spreading out with Pulse is risky.

### The cost of being big
- **Upkeep:** flocks above 150 boids shed 1% of the excess per second (`DECAY_*`). Shed boids are thrown outward. Half become food, which the shedding flock can't eat for 3 s, and the other half disappear. A giant leaves a trail of food that smaller flocks can follow, and its size stays in check unless it keeps hunting.
- **Speed:** speed scales with size^-0.15, between 0.65× and 1.15× (`SPEED_*`), from a base of 0.065 per step. A 12-boid flock is about 1.6× as fast as a 2,000-boid one, so small flocks can escape in open space. Big flocks have to corner them, cut them off, or use Dash.

### Controls and abilities
- **Hold the left mouse button:** every boid steers toward the cursor. With the cursor ahead of the flock, that moves it; with the cursor on the flock, it squeezes into a tight ball. With the button released, the boids just flock on their own, as in the original game (`MOUSE_MODE = 'hold'`).
- **Release:** boids rushing toward the cursor overshoot and shoot outward, sweeping a wide ring before cohesion pulls them back. A release after holding at least 0.25 s also gives 1.35× speed for 0.35 s (`RELEASE_BURST`), so the burst goes further. Timing it well is the main skill.
- **Dash** (`Shift` or right click, 4 s cooldown): 1.7× speed for 0.6 s, for finishing a chase or escaping one. It stacks with the release burst (about 2.3×) for a big explosion or a long lunge.
- **Pulse** (hold `Space`, no cooldown): tap for a quick burst, or hold to keep the flock spread over a wide disc. Its radius is 0.6 + 0.1·√size, capped at 2.4 units (`PULSE.radiusMax`) and at 30% of the arena half-size (`PULSE.zoneShare`): about 1.1 units at 25 boids, and the cap from about 320 boids up. A big flock just gets denser when it pulses, not wider, so it can't blanket the map. Release and the flock snaps back together. It sweeps up much more food, but your stragglers can be stolen while you're spread out, which is the trade-off. Enemy flocks only tap it, at most every 2.5 s (`PULSE.aiInterval`).
- **Enemy flocks** steer toward their AI's target all the time, and use Dash and Pulse too.

### Optional organic layer (`ORGANIC` in `game.js`, off by default)
All values are 0 by default, which gives the original boid dynamics. Raising them adds:
- **Own aim points:** each boid aims at its own point circling the target (`wobbleBase`, `wobblePerSqrt`).
- **Varied steering:** steering strength varies between boids (`steerJitter`).
- **Breathing:** the flock gently expands and contracts (`breathCohesion`, `breathSpread`).

Turning these on makes flocks swirl as loose clouds, but it mutes the hold-and-release dynamics.

### Enemy AI (`ai.js`)
- **Thinking:** each enemy flock thinks every 0.2–0.6 s (depending on difficulty) and picks one of four modes:
  - **Flee:** a flock that can eat it is near or closing in. It runs away and bends away from walls so it slides along them instead of getting cornered. It dashes when a threat is very close.
  - **Hunt:** it scores each flock it could eat by value ÷ time to catch it. Prey that is faster, or close to a bigger flock, scores lower. It aims at where the prey is heading, with some aim error, and gives up after 7 s without closing in.
  - **Forage:** it heads for the best patch of food it can see (or a known bloom), avoiding areas near threats, and pulses when there is a lot of food nearby.
  - **Wander:** nothing interesting is in sight.
- **Personalities** (assigned in turn to the 15 flocks): *hunter* (aggressive, takes risks), *forager* (cautious, food-first) and *opportunist* (balanced).
- **Difficulty** (picked on the start screen, which describes the selected level):

| | Easy | Normal | Hard |
|---|---|---|---|
| Reaction (think time) | 0.6 s | 0.3 s | 0.2 s |
| Aim error | 30% | 12% | 5% |
| How far ahead they aim | 30% | 75% | 100% |
| View radius | 6 | 8 | 10 |
| Uses Dash / Pulse | no / no | yes / yes | yes / yes |
| Preference for hunting you | 0.8× | 1.1× | 1.3× |

### Readability (HUD, `hud.js`)
- **Rings:** green dashed rings around flocks you can eat, red around flocks that can eat you, grey around the rest. Each ring shows the flock's name and size.
- **Edge arrows:** arrows on the screen edge for flocks off screen (within 18 units) and for blooms. Threats take priority where arrows overlap.
- **Your size:** a panel above the ability bars shows your size in large type, how much it changed in the last 5 s (▲/▼), your rank, the largest flock you can eat and the smallest flock that can eat you. It flashes green or red when you gain or lose boids, and your size is also shown above your flock.
- **Minimap:** shows the arena, the next border, flocks, blooms and the camera view.
- **Other:** ability cooldowns, the game timer with truce/shrink/showdown messages, and an event feed. The leaderboard marks prey with green dots and threats with red dots.

## Playtest results

These come from automated games where an AI (Hard brain) played the player's flock against Normal enemies:
- **Early game:** 2–4 eliminations by 0:30 and 4–7 by 1:00.
- **Game length:** games end between 3:10 and 3:55: a last flock standing, or the largest flock when the showdown ends.
- **Leader size:** the biggest flock has 50–110 boids at 0:30, 80–180 at 1:00 and 550–650 in the showdown.
- **The autopilot player:** won 2 of 6, placed #3, #3 and #8 in three others, and was eaten early (0:24) once. A human who masters the hold-and-release burst and Dash should do better.

- **Bigger flocks (latest change):** after the scale-up (more and richer food, denser boids, 24,000 slots), a full autopilot game had a top flock of about 220 at 0:30, 400–700 at 1:00, 1,100–1,300 at 2:00 and 2,900 in the showdown. Early kills come a little later than before (0–3 eliminations by 1:00), because evenly fed flocks stay closer in size for longer.

## Tuning cheat sheet

| Symptom | Turn |
|---|---|
| Too easy overall | Difficulty Hard; raise `playerBias`; lower AI `thinkTime` |
| Too hard overall | Difficulty Easy; raise `CONSUME_MARGIN`; raise `DIGEST_TIME` (easier to escape) |
| Early game too slow | Raise `FOOD_VALUE` or `FOOD_DENSITY` |
| Flocks too small or too big | `FOOD_DENSITY`, `FOOD_RESPAWN_RATE`, `FOOD_VALUE`, `BLOOM_FOOD`, `DECAY_FREE` (raise `CAPACITY` if flocks hit the slot limit) |
| One flock runs away with it | Raise `DECAY_RATE` or `SPILL`; lower `DECAY_FREE`; raise `SPEED_EXPONENT` |
| Games too long | Shorten `ZONE_SCHEDULE` holds or `FINAL_SECONDS` |
| Fights are over too fast | Raise `DIGEST_TIME` |
| Pulse too weak or too strong | `PULSE.radiusMax`, `PULSE.zoneShare`, `PULSE.radiusPerSqrt`, `PULSE.spread` |
| Release burst too weak or too strong | `RELEASE_BURST.speedMul`, `RELEASE_BURST.duration` |
| Want the old follow-the-cursor control | `MOUSE_MODE = 'follow'` (left click then dashes) |
| Flock too rigid | Raise the `ORGANIC` values |

## Testing aids

URL flags for `game.html`:
- `?difficulty=easy|normal|hard`: preselect the difficulty
- `?autostart`: skip the start screen
- `?autopilot`: an AI (Hard brain) plays your flock
- `?speed=4`: run the simulation 4× faster

For example, `game.html?autopilot&autostart&speed=3` lets you watch a whole game in about two minutes.

`window.__game` in the browser console exposes the live state (`flocks`, `game`, `engine`, `restartGame()`).
