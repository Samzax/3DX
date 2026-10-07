// worldmap.js — 2D preview of a generated world (lobby wizard + GM campaign
// panel). Samples the same WorldGen the 3D terrain streams from, so what the
// map shows is what the seed + settings will actually build. North (-z) is up.
// Click to pick a point (the spawn); the zoom buttons change how much world
// the map covers, always centered on the current spawn.

import { WorldGen, SEASONS, HOME_INNER } from './worldgen.js';

const COLORS = {
    plains: [134, 184, 90], forest: [47, 107, 52], mountains: [141, 141, 147],
    desert: [217, 191, 120], coast: [185, 211, 154], swamp: [85, 104, 60],
    tundra: [169, 176, 138], taiga: [63, 107, 90], snow: [242, 245, 248]
};
const SEA_SHALLOW = [74, 143, 192], SEA_DEEP = [38, 84, 138], SEA_ICE = [214, 228, 238];
const SNOW = [242, 245, 248];

// How much world the map spans, in world units (1 unit = 5 ft; 1056 = 1 mile).
export const MAP_SPANS = [
    { key: 'region', label: 'Region', span: 16000 },      // ~15 mi: a province lens
    { key: 'kingdom', label: 'Kingdom', span: 90000 },    // ~85 mi
    { key: 'continent', label: 'Continent', span: 420000 }, // ~400 mi
    { key: 'world', label: 'World', span: 1600000 }       // ~1500 mi
];

// opts: getSettings() -> { seed, world, season }, getSpawn() -> { x, z },
//       onPick({ x, z }) when the map is clicked, zoomEl (container for the
//       span buttons), size (canvas pixels per side).
export function createWorldMap(canvas, opts) {
    const N = opts.size || 220;
    canvas.width = N; canvas.height = N;
    const ctx = canvas.getContext('2d');
    const gen = new WorldGen();
    const image = ctx.createImageData(N, N);
    let spanIndex = 2;
    let center = { x: 0, z: 0 };
    let timer = null;

    function draw() {
        timer = null;
        const settings = opts.getSettings() || {};
        gen.set(settings.seed, settings.world);
        const season = SEASONS[settings.season] || 0;
        const spawn = opts.getSpawn ? opts.getSpawn() : { x: 0, z: 0 };
        center = { x: spawn.x, z: spawn.z };
        const span = MAP_SPANS[spanIndex].span, px = span / N;
        const data = image.data;
        for (let j = 0; j < N; j++) {
            const wz = center.z + (j + 0.5 - N / 2) * px;
            for (let i = 0; i < N; i++) {
                const wx = center.x + (i + 0.5 - N / 2) * px;
                const s = gen.sample(wx, wz, px, season);
                let c;
                if (s.sea) {
                    c = s.snow ? SEA_ICE : [
                        SEA_SHALLOW[0] + (SEA_DEEP[0] - SEA_SHALLOW[0]) * s.depth,
                        SEA_SHALLOW[1] + (SEA_DEEP[1] - SEA_SHALLOW[1]) * s.depth,
                        SEA_SHALLOW[2] + (SEA_DEEP[2] - SEA_SHALLOW[2]) * s.depth];
                } else {
                    c = s.snow ? SNOW : (COLORS[s.biome] || COLORS.plains);
                }
                const o = (j * N + i) * 4;
                data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
            }
        }
        ctx.putImageData(image, 0, 0);
        // Homeland ring (its guaranteed-land core), when it fits the view.
        const home = gen.world.home;
        if (home) {
            const hx = (home.x - center.x) / px + N / 2, hz = (home.z - center.z) / px + N / 2;
            const r = HOME_INNER / px;
            if (r > 3 && r < N) {
                ctx.strokeStyle = 'rgba(255,255,255,0.55)';
                ctx.setLineDash([4, 3]);
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.arc(hx, hz, r, 0, Math.PI * 2); ctx.stroke();
                ctx.setLineDash([]);
            }
        }
        // Spawn marker: always the map center.
        const m = N / 2;
        ctx.strokeStyle = '#101014'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(m, m, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(m, m, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(m - 9, m); ctx.lineTo(m + 9, m); ctx.moveTo(m, m - 9); ctx.lineTo(m, m + 9); ctx.stroke();
    }

    // Coalesce bursts (slider drags) into one redraw.
    function render() {
        if (timer == null) timer = setTimeout(draw, 40);
    }

    canvas.addEventListener('click', (event) => {
        if (!opts.onPick) return;
        const rect = canvas.getBoundingClientRect();
        const px = MAP_SPANS[spanIndex].span / N;
        const i = (event.clientX - rect.left) / rect.width * N;
        const j = (event.clientY - rect.top) / rect.height * N;
        opts.onPick({
            x: Math.round(center.x + (i - N / 2) * px),
            z: Math.round(center.z + (j - N / 2) * px)
        });
        render();
    });

    if (opts.zoomEl) {
        opts.zoomEl.innerHTML = MAP_SPANS.map((s, i) =>
            `<button type="button" class="worldmap-zoom${i === spanIndex ? ' active' : ''}" data-span="${i}">${s.label}</button>`
        ).join('');
        opts.zoomEl.addEventListener('click', (event) => {
            const button = event.target.closest('[data-span]');
            if (!button) return;
            spanIndex = Number(button.dataset.span);
            opts.zoomEl.querySelectorAll('[data-span]').forEach(b =>
                b.classList.toggle('active', b === button));
            render();
        });
    }

    return { render, setSpan(key) {
        const i = MAP_SPANS.findIndex(s => s.key === key);
        if (i < 0) return;
        spanIndex = i;
        if (opts.zoomEl) opts.zoomEl.querySelectorAll('[data-span]').forEach(b =>
            b.classList.toggle('active', Number(b.dataset.span) === i));
        render();
    } };
}
