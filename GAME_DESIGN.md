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
3. **A clear arc:** grow (truce, food) → skirmish (hunt and evade) → showdown (shrinking arena, time limit). A game lasts about 5–6 minutes.
4. **Readable.** You should always be able to see who you can eat and who can eat you.
5. **A bit hard.** Enemies use the same physics and abilities as you, so they don't cheat. Their limits are deliberate weaknesses you can exploit: limited sight, reaction time, aim error, and giving up on long chases.

## The systems

### Arena: big start, shrinking end
- **Size:** the arena starts at 32×32 (`ARENA_START = 16`, half-size). That's 2.5× the old area, so you have room to hide and grow early.
- **Shrinking:** `ZONE_SCHEDULE` shrinks it in three stages: to 22×22 at 1:20–1:55, to 14×14 by 3:10, and to 7×7 by 4:20. The HUD counts down to each shrink, and the minimap shows the next border.
- **Final showdown:** after the last shrink, a 60-second countdown (`FINAL_SECONDS`) runs, and when it ends **the largest flock wins**. So games end in about 5½ minutes even when a small flock keeps escaping.

### Opening truce
For the first 20 s (`TRUCE_SECONDS`), flocks can't eat or steal from each other. Everyone gets a fair start to grow, and nobody is eaten by a neighbour in the first seconds. The AI starts watching for threats 4 s before the truce ends.

### Food economy
- **Plentiful but low-value food.** There are 0.6 food per unit² (`FOOD_DENSITY`), but each food only has a 40% chance to become a boid (`FOOD_VALUE`). The screen always has things to collect, but food alone grows you slowly.
- **Steady respawn.** Food respawns at 15/s (`FOOD_RESPAWN_RATE`) toward a target that scales with the current arena area. As the arena shrinks, there's less food in total.
- **Weaker pull.** Food drifts toward flock boids within 0.3 units (`FOOD_RADIUS`, was 0.8), so you have to actually sweep through it. That is what **Pulse** is for.
- **Blooms:** every 22–34 s a patch of 90 food appears (`BLOOM_*`). Blooms are announced, and AI flocks head for them too, so they become contested hot spots that start fights.

### Eating
- **Who can eat whom:** a flock can eat another if it is at least **1.2×** its size **and at least 3 boids bigger** (`CONSUME_RATIO`, `CONSUME_MARGIN`). The margin removes coin-flip fights between small flocks.
- **Eating runs on the GPU every step.** A boid that touches a boid of a flock that can eat it switches sides. Food that touches a flock boid is eaten the same way. Results don't depend on frame rate.
- **Digest time (1.5 s):** a boid that just switched flocks can't convert others yet. Without this, one touch spread through the whole victim flock in under a second. Now eating happens where the flocks touch: a pass takes a bite, a full engulf takes everything, and a victim that reacts fast escapes with most of its flock.
- **Spill (35%):** of the boids a flock eats, 35% burst out as food instead of joining. The eater can't pick that food up for 1 s, but the victim and third parties can. Kills give a smaller jump, and every fight leaves a food spill for scavengers.
- **Stragglers:** a boid with no flockmate within 0.3 units can be stolen by any flock whose boid is in formation, regardless of size. Small flocks can pick off a big flock's stragglers, and spreading out with Pulse is risky.

### The cost of being big
- **Upkeep:** flocks above 30 boids shed 1% of the excess per second (`DECAY_*`). Shed boids are thrown outward. Half become food, which the shedding flock can't eat for 3 s, and the other half disappear. A giant leaves a trail of food that smaller flocks can follow, and its size stays in check unless it keeps hunting.
- **Speed:** speed scales with size^-0.2, between 0.55× and 1.15× (`SPEED_*`). A 5-boid flock is about 2× as fast as a 500-boid one, so small flocks can always escape in open space. Big flocks have to corner them, cut them off, or use Dash.

### Abilities (same rules for the player and the AI)
- **Pulse** (`Space` or right click, no cooldown): tap for a quick burst, or hold to keep the flock spread over a wide disc. Its radius is 0.6 + 0.2·√size: about 1.5 units at 20 boids and 3.4 at 200. Release and the flock snaps back together. It sweeps up much more food, but your stragglers can be stolen while you're spread out, which is the trade-off. Enemy flocks only tap it, at most every 2.5 s (`PULSE.aiInterval`).
- **Dash** (`Shift` or left click, 5 s cooldown): 1.7× speed for 0.6 s, for finishing a chase or escaping one.

### Organic movement (`ORGANIC` in `game.js`)
The flock should feel alive, not like a rigid formation chasing a point:
- **Own aim points:** each boid steers toward its own point that circles the target. Points have different radii, speeds and directions, and their distance swings in and out (`wobbleBase`, `wobblePerSqrt`).
- **Varied steering:** steering strength varies ±35% between boids (`steerJitter`), so some boids lead and some trail.
- **Breathing:** each flock gently breathes in and out every 2.4 s (`breathPeriod`). Cohesion eases off and a soft outward push builds on the out-breath, then the flock gathers again.
- **Effect:** at rest, a flock swirls as a loose cloud around the cursor instead of collapsing onto it. On the move, it flows as a ragged wave.

### Enemy AI (`ai.js`)
- **Thinking:** each enemy flock thinks every 0.2–0.6 s (depending on difficulty) and picks one of four modes:
  - **Flee:** a flock that can eat it is near or closing in. It runs away and bends away from walls so it slides along them instead of getting cornered. It dashes when a threat is very close.
  - **Hunt:** it scores each flock it could eat by value ÷ time to catch it. Prey that is faster, or close to a bigger flock, scores lower. It aims at where the prey is heading, with some aim error, and gives up after 7 s without closing in.
  - **Forage:** it heads for the best patch of food it can see (or a known bloom), avoiding areas near threats, and pulses when there is a lot of food nearby.
  - **Wander:** nothing interesting is in sight.
- **Personalities** (assigned in turn to the 15 flocks): *hunter* (aggressive, takes risks), *forager* (cautious, food-first) and *opportunist* (balanced).
- **Difficulty** (picked on the start screen):

| | Easy | Normal | Hard |
|---|---|---|---|
| Reaction (think time) | 0.6 s | 0.35 s | 0.2 s |
| Aim error | 30% | 12% | 5% |
| How far ahead they aim | 30% | 75% | 100% |
| View radius | 6 | 8 | 10 |
| Uses Dash / Pulse | no / no | yes / yes | yes / yes |
| Preference for hunting you | 0.8× | 1.1× | 1.3× |

### Readability (HUD, `hud.js`)
- **Rings:** green dashed rings around flocks you can eat, red around flocks that can eat you, grey around the rest. Each ring shows the flock's name and size.
- **Edge arrows:** arrows on the screen edge for flocks off screen (within 18 units) and for blooms. Threats take priority where arrows overlap.
- **Minimap:** shows the arena, the next border, flocks, blooms and the camera view.
- **Other:** ability cooldowns, the game timer with truce/shrink/showdown messages, and an event feed. The leaderboard marks prey with green dots and threats with red dots.

## Playtest results

These come from automated games where an AI (Hard brain) played the player's flock against Normal enemies:
- **Early game:** the first kill comes soon after the truce ends (25–44 s). There are usually 3–5 eliminations in the first minute, once 8.
- **Leader size:** the biggest flock has 50–140 boids at 1:00, 80–150 at 2:00 and 120–250 at 3:00. Before these changes, leaders reached 300–1,600.
- **Ending:** games resolve by 5:20 at the latest: a last flock standing, or the largest flock when the showdown ends.
- **The autopilot player:** placed #4–#14 in the games it lost and won about one in five on time. A human who uses Pulse, Dash and the walls well should do better, while one who loses track of red rings will do worse.

## Tuning cheat sheet

| Symptom | Turn |
|---|---|
| Too easy overall | Difficulty Hard; raise `playerBias`; lower AI `thinkTime` |
| Too hard overall | Difficulty Easy; raise `CONSUME_MARGIN`; raise `DIGEST_TIME` (easier to escape) |
| Early game too slow | Raise `FOOD_VALUE` or `FOOD_DENSITY` |
| One flock runs away with it | Raise `DECAY_RATE` or `SPILL`; lower `DECAY_FREE`; raise `SPEED_EXPONENT` |
| Games too long | Shorten `ZONE_SCHEDULE` holds or `FINAL_SECONDS` |
| Fights are over too fast | Raise `DIGEST_TIME` |
| Pulse too weak or too strong | `PULSE.radiusBase`, `PULSE.radiusPerSqrt`, `PULSE.spread` |
| Flock too tight or too loose | `ORGANIC.wobbleBase`, `ORGANIC.wobblePerSqrt`, `ORGANIC.breathSpread` |

## Testing aids

URL flags for `game.html`:
- `?difficulty=easy|normal|hard`: preselect the difficulty
- `?autostart`: skip the start screen
- `?autopilot`: an AI (Hard brain) plays your flock
- `?speed=4`: run the simulation 4× faster

For example, `game.html?autopilot&autostart&speed=3` lets you watch a whole game in about two minutes.

`window.__game` in the browser console exposes the live state (`flocks`, `game`, `engine`, `restartGame()`).
