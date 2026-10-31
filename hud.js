// 2D overlay on top of the WebGPU canvas: who can eat whom, off-screen flocks, minimap,
// the player's size panel, ability cooldowns, arena timer and an event feed.

const COLORS = {
    prey: '#5dff8a',
    threat: '#ff4d4d',
    neutral: 'rgba(220, 220, 220, 0.75)',
    food: '#ffcc33',
    zone: 'rgba(80, 160, 220, 0.9)',
};
const OFFSCREEN_RANGE = 18;     // World units: flocks further away get no edge arrow
const EVENT_LIFETIME = 5;       // Seconds an event stays in the feed
const MINIMAP_SIZE = 170;

export class Hud {
    constructor(canvas, { arenaStart }) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.arenaStart = arenaStart;
        this.events = [];
        this.now = 0;
    }

    reset() {
        this.events = [];
    }

    addEvent(text, color = '#ffffff') {
        this.events.push({ text, color, at: performance.now() / 1000 });
        if (this.events.length > 5) this.events.shift();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth, h = window.innerHeight;
        if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
            this.canvas.width = Math.round(w * dpr);
            this.canvas.height = Math.round(h * dpr);
        }
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.w = w;
        this.h = h;
    }

    draw(state) {
        this.resize();
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.w, this.h);
        this.state = state;
        this.updateShownSize();

        this.arrows = [];
        for (const b of state.blooms) this.drawBloom(b);
        for (const f of state.flocks) this.drawFlock(f);
        this.drawPlayerLabel();
        this.drawArrows();
        this.drawMinimap();
        this.drawSizePanel();
        this.drawAbilities();
        this.drawTimer();
        this.drawTopSize();
        this.drawEvents();
    }

    // World units -> CSS pixels (mirrors the render shader's camera transform)
    toScreen(x, y) {
        const { camera, aspect } = this.state;
        const ndcX = (x - camera.x) * camera.zoom / aspect;
        const ndcY = (y - camera.y) * camera.zoom;
        return { x: (ndcX + 1) * 0.5 * this.w, y: (1 - ndcY) * 0.5 * this.h };
    }

    pixelsPerUnit() {
        return this.state.camera.zoom * this.h * 0.5;
    }

    onScreen(p, margin = 0) {
        return p.x > -margin && p.x < this.w + margin && p.y > -margin && p.y < this.h + margin;
    }

    drawFlock(f) {
        const ctx = this.ctx;
        const p = this.toScreen(f.x, f.y);
        const r = Math.max(10, f.radius * this.pixelsPerUnit());
        const color = COLORS[f.relation];

        if (this.onScreen(p, r)) {
            ctx.save();
            ctx.strokeStyle = color;
            ctx.globalAlpha = f.relation === 'neutral' ? 0.35 : 0.7;
            ctx.lineWidth = f.relation === 'threat' ? 2 : 1.5;
            ctx.setLineDash(f.relation === 'neutral' ? [3, 6] : [6, 5]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = color;
            ctx.fillText(`${f.count}`, p.x, p.y - r - 12);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.fillText(f.name, p.x, p.y - r - 24);
            return;
        }

        const player = this.state.player;
        if (!player) return;
        const dist = Math.hypot(f.x - player.x, f.y - player.y);
        if (dist > OFFSCREEN_RANGE) return;
        const priority = { threat: 0, prey: 1, neutral: 2 }[f.relation];
        this.arrows.push({ p, color, label: `${f.count}`, alpha: f.relation === 'threat' ? 1 : 0.75, priority, dist });
    }

    drawBloom(b) {
        const ctx = this.ctx;
        const p = this.toScreen(b.x, b.y);
        const r = 1.6 * this.pixelsPerUnit();
        if (this.onScreen(p, r)) {
            ctx.save();
            ctx.strokeStyle = COLORS.food;
            ctx.globalAlpha = 0.25 + 0.15 * Math.sin(performance.now() / 250);
            ctx.setLineDash([2, 6]);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        } else {
            this.arrows.push({ p, color: COLORS.food, label: 'food', alpha: 0.8, priority: 1.5, dist: 0 });
        }
    }

    // Off-screen arrows, most important first; ones that would land on top of another are skipped
    drawArrows() {
        this.arrows.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
        const placed = [];
        for (const a of this.arrows) {
            const at = this.edgePoint(a.p);
            if (placed.some(q => Math.hypot(q.x - at.x, q.y - at.y) < 26)) continue;
            placed.push(at);
            this.drawEdgeArrow(a.p, a.color, a.label, a.alpha);
        }
    }

    edgePoint(p) {
        const cx = this.w / 2, cy = this.h / 2;
        const dx = p.x - cx, dy = p.y - cy;
        const scale = Math.min((cx - 30) / Math.abs(dx || 1e-6), (cy - 75) / Math.abs(dy || 1e-6));
        const x = cx + dx * scale;
        let y = cy + dy * scale;
        if (x < MINIMAP_SIZE + 40 && y > this.h - MINIMAP_SIZE - 40) y = this.h - MINIMAP_SIZE - 40;
        // Stay clear of the size readout and timer at the top...
        if (Math.abs(x - cx) < 150 && y < 105) y = 105;
        // ...and above the size panel and ability bars
        if (Math.abs(x - cx) < 170 && y > this.h - 132) y = this.h - 132;
        return { x, y };
    }

    // Arrow on the screen edge pointing at an off-screen point
    drawEdgeArrow(p, color, label, alpha) {
        const ctx = this.ctx;
        // On the screen edge, clear of the timer at the top, ability bar at the bottom and the minimap
        const { x: ex, y: ey } = this.edgePoint(p);
        const a = Math.atan2(p.y - this.h / 2, p.x - this.w / 2);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(ex, ey);
        ctx.rotate(a);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(12, 0);
        ctx.lineTo(-6, -7);
        ctx.lineTo(-6, 7);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = color;
        ctx.fillText(label, ex - Math.cos(a) * 20, ey - Math.sin(a) * 20 + 4);
        ctx.restore();
    }

    drawMinimap() {
        const ctx = this.ctx;
        const { zone, flocks, player, blooms, camera, aspect } = this.state;
        const size = MINIMAP_SIZE;
        const x0 = 16, y0 = this.h - size - 16;
        const s = size / (2 * this.arenaStart);
        const map = (x, y) => ({ x: x0 + (x + this.arenaStart) * s, y: y0 + (this.arenaStart - y) * s });

        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(x0, y0, size, size);
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.strokeRect(x0, y0, size, size);

        // Current arena, and where it is shrinking to
        const z = map(-zone.size, zone.size);
        ctx.strokeStyle = COLORS.zone;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(z.x, z.y, 2 * zone.size * s, 2 * zone.size * s);
        if (zone.next < zone.size && (zone.shrinking || zone.changeIn < 20)) {
            const n = map(-zone.next, zone.next);
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = zone.shrinking ? COLORS.threat : 'rgba(255, 120, 120, 0.6)';
            ctx.strokeRect(n.x, n.y, 2 * zone.next * s, 2 * zone.next * s);
            ctx.setLineDash([]);
        }

        // What the camera currently shows
        const vw = aspect / camera.zoom, vh = 1 / camera.zoom;
        const v = map(camera.x - vw, camera.y + vh);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(v.x, v.y, 2 * vw * s, 2 * vh * s);

        for (const b of blooms) {
            const p = map(b.x, b.y);
            ctx.fillStyle = COLORS.food;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        for (const f of flocks) {
            const p = map(f.x, f.y);
            const r = Math.min(9, 1.5 + Math.sqrt(f.count) * 0.4);
            ctx.fillStyle = f.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            if (f.relation !== 'neutral') {
                ctx.strokeStyle = COLORS[f.relation];
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        }
        if (player) {
            const p = map(player.x, player.y);
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#33ccff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.min(9, 2.5 + Math.sqrt(player.count) * 0.4), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }

    // The player's size as shown: rolls smoothly toward the real count instead of jumping with
    // every snapshot, and the 5 s trend only refreshes once a second
    updateShownSize() {
        const size = this.state.size;
        const now = performance.now() / 1000;
        const dt = Math.min(0.1, now - (this.shownAt ?? now));
        this.shownAt = now;
        if (!size) { this.shown = undefined; return; }
        if (this.shown === undefined || Math.abs(size.count - this.shown) > 0.5 * Math.max(size.count, 20)) {
            this.shown = size.count;
        } else {
            this.shown += (size.count - this.shown) * Math.min(1, dt * 4);
        }
        if (this.trendAt === undefined || now - this.trendAt >= 1) {
            this.shownTrend = size.trend;
            this.trendAt = now;
        }
    }

    shownCount() {
        return Math.round(this.shown ?? 0).toLocaleString('en-US');
    }

    // Flash green or red for a moment when the player's size jumps (a kill, a bite taken out of
    // us), not for the steady trickle of food and upkeep
    sizeFlash(count) {
        const now = performance.now() / 1000;
        if (this.lastCount === undefined || now - this.lastCountAt > 0.5) {
            this.lastCount = count;
            this.lastCountAt = now;
        }
        const change = count - this.lastCount;
        if (Math.abs(change) >= Math.max(4, 0.04 * this.lastCount)) {
            this.flash = { color: change > 0 ? COLORS.prey : COLORS.threat, at: now };
            this.lastCount = count;
            this.lastCountAt = now;
        }
        if (!this.flash || now - this.flash.at > 0.4) return null;
        return this.flash.color;
    }

    drawPlayerLabel() {
        const { player, size } = this.state;
        if (!player || !size) return;
        const p = this.toScreen(player.x, player.y);
        const r = Math.max(10, player.radius * this.pixelsPerUnit());
        if (!this.onScreen(p, r)) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.font = 'bold 16px sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(this.shownCount(), p.x, p.y - r - 12);
        ctx.fillStyle = '#33ccff';
        ctx.fillText(this.shownCount(), p.x, p.y - r - 12);
        ctx.restore();
    }

    // The player's size in large type at the top of the screen
    drawTopSize() {
        const size = this.state.size;
        if (!size) return;
        const ctx = this.ctx;
        const flash = this.sizeFlash(size.count);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = 'bold 42px sans-serif';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.strokeText(this.shownCount(), this.w / 2, 68);
        ctx.fillStyle = flash || '#33ccff';
        ctx.fillText(this.shownCount(), this.w / 2, 68);
        ctx.restore();
    }

    // Rank, growth trend and size thresholds, just above the ability bars
    drawSizePanel() {
        const size = this.state.size;
        if (!size) return;
        const ctx = this.ctx;
        const w = 292, h = 54;
        const x = this.w / 2 - w / 2;
        const y = this.h - 34 - 18 - 10 - h;

        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(51,204,255,0.6)';
        ctx.strokeRect(x, y, w, h);

        // Rank and growth over the last few seconds
        ctx.textAlign = 'left';
        ctx.font = 'bold 22px sans-serif';
        ctx.fillStyle = size.rank === 1 ? '#ffd24d' : '#ffffff';
        ctx.fillText(`#${size.rank}`, x + 12, y + 30);
        const rankW = ctx.measureText(`#${size.rank}`).width;
        ctx.font = '12px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText(`of ${size.of}`, x + 16 + rankW, y + 30);
        const trend = this.shownTrend ?? 0;
        ctx.font = 'bold 12px sans-serif';
        ctx.fillStyle = trend > 0 ? COLORS.prey : trend < 0 ? COLORS.threat : 'rgba(255,255,255,0.5)';
        ctx.fillText(trend === 0 ? '— steady' : `${trend > 0 ? '▲ +' : '▼ '}${trend} in 5s`, x + 12, y + 47);

        // Who you can eat / who can eat you
        ctx.textAlign = 'right';
        ctx.font = '12px sans-serif';
        ctx.fillStyle = COLORS.prey;
        ctx.fillText(size.eatMax > 0 ? `You eat flocks ≤ ${size.eatMax}` : 'Too small to eat anyone', x + w - 12, y + 24);
        ctx.fillStyle = COLORS.threat;
        ctx.fillText(`Flocks ≥ ${size.dangerMin} eat you`, x + w - 12, y + 42);
        ctx.restore();
    }

    drawAbilities() {
        const { abilities, player } = this.state;
        if (!player) return;
        const items = [
            { key: 'HOLD SPACE', name: 'Pulse', ...abilities.pulse },
            { key: 'SHIFT / RIGHT CLICK', name: 'Dash', ...abilities.dash },
        ];
        const ctx = this.ctx;
        const w = 140, h = 34, gap = 12;
        let x = this.w / 2 - (items.length * w + (items.length - 1) * gap) / 2;
        const y = this.h - h - 18;
        for (const it of items) {
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = it.active ? 'rgba(78,205,196,0.9)' : it.ready ? 'rgba(78,205,196,0.45)' : 'rgba(255,255,255,0.15)';
            ctx.fillRect(x, y, w * Math.min(1, it.frac), h);
            ctx.strokeStyle = it.ready ? '#4ECDC4' : 'rgba(255,255,255,0.3)';
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(it.name, x + w / 2, y + 15);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.fillText(it.key, x + w / 2, y + 28);
            ctx.restore();
            x += w + gap;
        }
    }

    drawTimer() {
        const { t, zone } = this.state;
        const ctx = this.ctx;
        const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(fmt(t), this.w / 2, 20);
        ctx.font = '13px sans-serif';
        const msgY = this.state.size ? 90 : 42;
        if (this.state.truceLeft > 0) {
            ctx.fillStyle = '#9fe8ff';
            ctx.fillText(`Truce: flocks can't eat each other for ${Math.ceil(this.state.truceLeft)}s`, this.w / 2, msgY);
        } else if (zone.final) {
            ctx.fillStyle = zone.endsIn < 10 ? '#ff6a6a' : '#ffb347';
            ctx.fillText(`Final showdown: largest flock wins in ${fmt(zone.endsIn)}`, this.w / 2, msgY);
        } else if (zone.shrinking) {
            ctx.fillStyle = `rgba(255, 90, 90, ${0.7 + 0.3 * Math.sin(performance.now() / 150)})`;
            ctx.fillText('Arena shrinking!', this.w / 2, msgY);
        } else if (Number.isFinite(zone.changeIn)) {
            ctx.fillStyle = zone.changeIn < 15 ? '#ff9a6a' : 'rgba(255,255,255,0.6)';
            ctx.fillText(`Arena shrinks in ${fmt(zone.changeIn)}`, this.w / 2, msgY);
        }
        ctx.restore();
    }

    drawEvents() {
        const ctx = this.ctx;
        const now = performance.now() / 1000;
        this.events = this.events.filter(e => now - e.at < EVENT_LIFETIME);
        // Bottom-right, newest at the bottom
        ctx.save();
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'right';
        const n = this.events.length;
        this.events.forEach((e, i) => {
            const age = now - e.at;
            ctx.globalAlpha = Math.min(1, (EVENT_LIFETIME - age) / 1.5);
            ctx.fillStyle = e.color;
            ctx.fillText(e.text, this.w - 60, this.h - 24 - (n - 1 - i) * 20);
        });
        ctx.restore();
    }
}
