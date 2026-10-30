// Enemy flock AI.
//
// Each enemy flock has a FlockBrain that "thinks" a few times per second (how often depends on
// difficulty) and picks one of four modes:
//   flee    - a flock that can eat us is close or closing in: run, steering away from walls
//   hunt    - chase the most worthwhile flock we can eat, aiming where it is going
//   forage  - head for the richest patch of food we can see (or a known food bloom)
//   wander  - nothing interesting in sight
// Brains only see flocks within their view radius, react with a delay, aim with some error and
// give up long chases. Those limits are what leave room for the player to outplay them.

export const DIFFICULTIES = {
    easy: {
        label: 'Easy',
        thinkTime: 0.6,     // Seconds between decisions (reaction time)
        aimError: 0.3,      // Random aim offset, as a fraction of the distance to the target
        steer: 0.85,        // Steering force relative to the player's
        lead: 0.3,          // How far ahead of a moving prey they aim (1 = full intercept)
        view: 6,            // How far they can see other flocks
        dash: false,        // Whether they use Dash
        pulse: false,       // Whether they use Pulse
        playerBias: 0.8,    // Preference for hunting the player over other flocks
    },
    normal: {
        label: 'Normal',
        thinkTime: 0.35,
        aimError: 0.12,
        steer: 1.0,
        lead: 0.75,
        view: 8,
        dash: true,
        pulse: true,
        playerBias: 1.1,
    },
    hard: {
        label: 'Hard',
        thinkTime: 0.2,
        aimError: 0.05,
        steer: 1.0,
        lead: 1.0,
        view: 10,
        dash: true,
        pulse: true,
        playerBias: 1.3,
    },
};

export const PERSONALITIES = [
    { name: 'hunter', aggression: 1.5, caution: 0.75, appetite: 0.8 },
    { name: 'forager', aggression: 0.6, caution: 1.3, appetite: 1.3 },
    { name: 'opportunist', aggression: 1.0, caution: 1.0, appetite: 1.0 },
];

const WALL_AVOID_RANGE = 3.0;   // Fleeing flocks start bending away from walls this far out
const CHASE_PATIENCE = 7.0;     // Seconds without closing in before a hunter gives up
const IGNORE_AFTER_GIVE_UP = 6.0;
const FOOD_SCORE_WEIGHT = 0.7;  // Food is less certain than prey (others compete for it)

function gaussian() {
    return (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
}

export class FlockBrain {
    constructor(personality, difficulty) {
        this.personality = personality;
        this.difficulty = difficulty;
        this.mode = 'wander';
        this.target = { x: 0, y: 0 };
        this.nextThink = 0;
        this.preyId = -1;
        this.chaseStart = 0;
        this.chaseBestGap = Infinity;
        this.ignoreUntil = new Map();   // packId -> time, prey we gave up on
        this.wanderAngle = Math.random() * Math.PI * 2;
        this.foodJitter = { x: 0, y: 0 };
        // One-shot requests the game turns into abilities when they are off cooldown
        this.wantDash = false;
        this.wantPulse = false;
    }

    update(me, world, t) {
        if (t < this.nextThink) return;
        this.nextThink = t + this.difficulty.thinkTime * (0.75 + Math.random() * 0.5);
        this.think(me, world, t);
    }

    think(me, world, t) {
        const d = this.difficulty;
        const p = this.personality;
        const view = d.view + me.radius;

        const threats = [];
        const prey = [];
        for (const o of world.flocks) {
            if (o.packId === me.packId || o.count <= 0) continue;
            const dx = o.x - me.x, dy = o.y - me.y;
            const dist = Math.hypot(dx, dy) || 1e-3;
            if (dist - o.radius > view) continue;
            const rel = { o, dx, dy, dist, gap: Math.max(0, dist - o.radius - me.radius) };
            if (world.canEat(o.count, me.count)) threats.push(rel);
            else if (world.canEat(me.count, o.count)) prey.push(rel);
        }

        if (this.tryFlee(me, world, threats)) return;

        const hunt = this.bestPrey(me, prey, threats, t);
        const food = this.bestFood(me, world, threats);

        if (hunt && hunt.score >= food.score) {
            this.huntTarget(me, hunt.rel, t);
        } else if (food.score > 0) {
            this.mode = 'forage';
            this.preyId = -1;
            this.setTarget(world, food.x + this.foodJitter.x, food.y + this.foodJitter.y);
            const quiet = threats.every(th => th.gap > 4);
            this.wantPulse = d.pulse && quiet && food.local >= 5;
        } else {
            this.wander(me, world);
        }
    }

    // Run from anything that can eat us and is near or closing in. Returns true if fleeing.
    tryFlee(me, world, threats) {
        const p = this.personality;
        const fleeRange = 2.0 + 1.5 * p.caution;
        let fx = 0, fy = 0, danger = 0, closest = Infinity;

        for (const th of threats) {
            const ux = th.dx / th.dist, uy = th.dy / th.dist;
            // Positive when the gap is shrinking
            const closing = (me.vx - th.o.vx) * ux + (me.vy - th.o.vy) * uy;
            const effGap = th.gap - Math.max(0, closing) * 0.7;
            if (effGap >= fleeRange) continue;
            const w = (fleeRange - effGap) / fleeRange;
            fx -= ux * w;
            fy -= uy * w;
            danger = Math.max(danger, w);
            closest = Math.min(closest, effGap);
        }
        if (danger < 0.12) return false;

        // Bend away from walls so we slide along them instead of running into a corner
        const z = world.zone;
        const push = (distToWall) => Math.max(0, (WALL_AVOID_RANGE - distToWall) / WALL_AVOID_RANGE) * 1.5 * danger;
        fx -= push(z - me.x);
        fx += push(me.x + z);
        fy -= push(z - me.y);
        fy += push(me.y + z);

        const len = Math.hypot(fx, fy) || 1;
        this.mode = 'flee';
        this.preyId = -1;
        this.setTarget(world, me.x + (fx / len) * 5, me.y + (fy / len) * 5);
        this.wantDash = this.difficulty.dash && closest < 0.9;
        return true;
    }

    bestPrey(me, prey, threats, t) {
        const d = this.difficulty;
        const p = this.personality;
        let best = null;
        for (const pr of prey) {
            const o = pr.o;
            if ((this.ignoreUntil.get(o.packId) || 0) > t) continue;

            // They will run, so we only close in at part of our speed advantage
            const closeRate = Math.max(0.25, me.speed - o.speed * 0.6);
            const eta = pr.gap / closeRate;
            const catchable = (me.speed >= o.speed * 0.95 || pr.gap < 1.2) ? 1 : 0.35;

            // Don't chase into the arms of something bigger
            let risk = 1;
            for (const th of threats) {
                const dd = Math.hypot(th.o.x - o.x, th.o.y - o.y) - th.o.radius;
                if (dd < 2.5 * p.caution) risk *= 0.35;
            }

            let score = (o.count / (eta + 2)) * p.aggression * catchable * risk;
            if (o.isPlayer) score *= d.playerBias;
            if (o.packId === this.preyId) score *= 1.35;   // Commitment: don't flip-flop between targets
            if (!best || score > best.score) best = { rel: pr, score };
        }
        return best;
    }

    bestFood(me, world, threats) {
        const p = this.personality;
        const view = this.difficulty.view;
        const food = world.food;
        const fleeRange = 2.0 + 1.5 * p.caution;
        let best = { score: 0, x: 0, y: 0, local: 0 };

        // Visible food cells
        const c0x = Math.floor((me.x - view + food.half) / food.cell);
        const c1x = Math.floor((me.x + view + food.half) / food.cell);
        const c0y = Math.floor((me.y - view + food.half) / food.cell);
        const c1y = Math.floor((me.y + view + food.half) / food.cell);
        for (let cy = Math.max(0, c0y); cy <= Math.min(food.dim - 1, c1y); cy++) {
            for (let cx = Math.max(0, c0x); cx <= Math.min(food.dim - 1, c1x); cx++) {
                const n = food.counts[cy * food.dim + cx];
                if (n === 0) continue;
                const x = -food.half + (cx + 0.5) * food.cell;
                const y = -food.half + (cy + 0.5) * food.cell;
                const dist = Math.hypot(x - me.x, y - me.y);
                if (dist > view) continue;
                if (dist < 1.5) best.local += n;
                if (threats.some(th => Math.hypot(th.o.x - x, th.o.y - y) - th.o.radius < fleeRange)) continue;
                const score = FOOD_SCORE_WEIGHT * p.appetite * n / (dist / Math.max(me.speed, 0.5) + 2);
                if (score > best.score) best = { ...best, score, x, y };
            }
        }

        // Food blooms are announced to everyone, so they are known even out of view
        for (const b of world.blooms) {
            if (b.food < 10) continue;
            const dist = Math.hypot(b.x - me.x, b.y - me.y);
            if (threats.some(th => Math.hypot(th.o.x - b.x, th.o.y - b.y) - th.o.radius < fleeRange)) continue;
            const score = FOOD_SCORE_WEIGHT * p.appetite * b.food / (dist / Math.max(me.speed, 0.5) + 4);
            if (score > best.score) best = { ...best, score, x: b.x, y: b.y };
        }

        if (best.score > 0 && Math.random() < 0.3) {
            this.foodJitter = { x: (Math.random() - 0.5) * food.cell, y: (Math.random() - 0.5) * food.cell };
        }
        return best;
    }

    huntTarget(me, pr, t) {
        const d = this.difficulty;
        const p = this.personality;
        const o = pr.o;

        if (this.preyId !== o.packId) {
            this.preyId = o.packId;
            this.chaseStart = t;
            this.chaseBestGap = pr.gap;
        } else if (pr.gap < this.chaseBestGap - 0.5) {
            this.chaseBestGap = pr.gap;
            this.chaseStart = t;
        } else if (t - this.chaseStart > CHASE_PATIENCE) {
            this.ignoreUntil.set(o.packId, t + IGNORE_AFTER_GIVE_UP);
            this.preyId = -1;
        }

        this.mode = 'hunt';
        // Aim where the prey will be, with some error
        const lead = Math.min(1.5, pr.gap / Math.max(me.speed, 0.5)) * d.lead;
        const err = d.aimError * pr.dist;
        const x = o.x + o.vx * lead + gaussian() * err;
        const y = o.y + o.vy * lead + gaussian() * err;
        this.target = { x, y };
        this.wantDash = d.dash && pr.gap > 0.2 && pr.gap < 2.2 && (o.speed > me.speed * 0.9 || p.aggression > 1.2);
    }

    wander(me, world) {
        this.mode = 'wander';
        this.preyId = -1;
        this.wanderAngle += (Math.random() - 0.5) * 1.2;
        // Drift back toward the middle when near walls
        const toCenter = Math.atan2(-me.y, -me.x);
        if (Math.hypot(me.x, me.y) > world.zone * 0.6) this.wanderAngle = toCenter + (Math.random() - 0.5);
        this.setTarget(world, me.x + Math.cos(this.wanderAngle) * 4, me.y + Math.sin(this.wanderAngle) * 4);
    }

    setTarget(world, x, y) {
        const m = world.zone - 0.6;
        this.target = { x: Math.max(-m, Math.min(m, x)), y: Math.max(-m, Math.min(m, y)) };
    }
}
