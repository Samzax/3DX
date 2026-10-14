// castdesk.js — casting outside a fight, on both tabletop screens. A spell is
// a request the GM confirms: the player aims its area on the map (the same
// template combat uses), everyone else there sees that template faded while it
// is still being moved, and once it is released the request waits in a small
// panel — Allow / Refuse for the GM, Cancel for the caster. The server rolls
// an allowed cast like any table roll and answers `cast-fx`, which the page
// plays on the map.
//
// The same panel lists what spells have left on the map (`type: 'summon'`
// objects: Mage Hand, Spiritual Weapon...) for whoever may end them: Dismiss
// is a plain `delete-object`, Strike hands the weapon to the page's target pick.
//
// Socket: `cast-aim` (live template, relayed, never kept), `cast-request`,
// `cancel-cast`, `resolve-cast` → `cast-requests { requests }`, `cast-fx`,
// `cast-denied`.

import { escHtml } from './campaigns.js';
import { createAimTool, createSceneProbe } from './aiming.js';
import { SUMMON_LABELS } from './summons.js';

const AIM_EVERY_MS = 70;      // how often the moving template is shared
const GHOST_LIFE_MS = 2500;   // a live ghost fades out when its player goes quiet

// socket · isGM() · username() · worldGroup · objects() (synced meshes) ·
// terrain() · notify(text) · onChange() (hint bar) · onFx(entry) (play it)
// onStrike(summon) (a summoned weapon is told to attack: pick its target)
export function createCastDesk({ socket, isGM = () => false, username = () => '', worldGroup, objects, terrain, notify = () => {}, onChange = () => {}, onFx = () => {}, onStrike = null }) {
    const probe = createSceneProbe({ objects, terrain });
    const tool = createAimTool({ worldGroup, ...probe });
    const ghosts = new Map();   // key → { tool, stamp, until (0 = while requested) }
    let requests = [];
    let aiming = null;          // the spec being aimed
    let sentAt = 0;
    let refreshedAt = 0;
    let summonStamp = '';
    const started = performance.now();

    // What this user may end: their own summons (the GM: everyone's).
    function summons() {
        const gm = isGM();
        const me = username();
        return objects().filter(object => object.userData.objectType === 'summon' && object.userData.syncId)
            .map(object => ({ ...(object.userData.objectData || {}), id: object.userData.syncId }))
            .filter(data => gm || (data.owner && data.owner === me));
    }

    const panel = document.createElement('section');
    panel.id = 'cast-requests';
    panel.className = 'hidden';
    panel.setAttribute('aria-label', 'Spells waiting for the GM');
    panel.setAttribute('aria-live', 'polite');
    document.body.append(panel);

    function render() {
        const gm = isGM();
        const me = username();
        const rows = requests.filter(request => gm || request.user === me).map(request => {
            const level = request.level > 0 ? `level ${escHtml(request.level)}` : 'cantrip';
            const what = `<b>${escHtml(request.spell)}</b> <span class="muted">${level}${request.area ? ` · ${escHtml(request.area)}` : ''}</span>`;
            return gm
                ? `<div class="cast-row"><span><b>${escHtml(request.name)}</b> <span class="muted">(${escHtml(request.user)})</span> casts ${what}</span>
                    <span class="cast-buttons"><button type="button" class="btn-combat roll" data-cast-allow="${escHtml(request.id)}">Allow</button>
                    <button type="button" class="btn-combat" data-cast-refuse="${escHtml(request.id)}">Refuse</button></span></div>`
                : `<div class="cast-row"><span>${escHtml(request.name)} casts ${what} — waiting for the GM…</span>
                    <span class="cast-buttons"><button type="button" class="btn-combat" data-cast-cancel="${escHtml(request.id)}">Cancel</button></span></div>`;
        }).join('');
        const held = summons().map(data => `<div class="cast-row"><span>✦ <b>${escHtml(data.name || SUMMON_LABELS[data.kind] || 'Summon')}</b> <span class="muted">${escHtml(data.casterName || '')}${data.leashFt ? ` · within ${escHtml(data.leashFt)} ft` : ''}${data.moveFt ? ` · moves ${escHtml(data.moveFt)} ft` : ''}</span></span>
            <span class="cast-buttons">${data.strike && onStrike ? `<button type="button" class="btn-combat atk" data-summon-strike="${escHtml(data.id)}">⚔ Strike</button>` : ''}
            <button type="button" class="btn-combat" data-summon-dismiss="${escHtml(data.id)}">Dismiss</button></span></div>`).join('');
        panel.innerHTML = rows + held;
        panel.classList.toggle('hidden', !rows && !held);
    }
    panel.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.castAllow) socket.emit('resolve-cast', { id: button.dataset.castAllow, approve: true });
        else if (button.dataset.castRefuse) socket.emit('resolve-cast', { id: button.dataset.castRefuse, approve: false });
        else if (button.dataset.castCancel) socket.emit('cancel-cast', { id: button.dataset.castCancel });
        else if (button.dataset.summonDismiss) socket.emit('delete-object', { id: button.dataset.summonDismiss });
        else if (button.dataset.summonStrike && onStrike) {
            const summon = summons().find(data => data.id === button.dataset.summonStrike);
            if (summon) onStrike(summon);
        }
    });

    // A faded template for someone else's aim, or for a request that waits.
    function showGhost(key, spec, until) {
        const stamp = JSON.stringify([spec.tokenId, spec.name, spec.shape]);
        let ghost = ghosts.get(key);
        if (!ghost) {
            ghost = { tool: createAimTool({ worldGroup, ...probe, faint: true }), stamp: '' };
            ghosts.set(key, ghost);
        }
        if (ghost.stamp !== stamp) {
            ghost.stamp = stamp;
            ghost.tool.begin({ shape: spec.shape, casterId: spec.tokenId, name: spec.name, type: spec.type });
        }
        if (spec.point) ghost.tool.move(spec.point);
        ghost.until = until;
    }
    function dropGhost(key) {
        const ghost = ghosts.get(key);
        if (!ghost) return;
        ghost.tool.dispose();
        ghosts.delete(key);
    }
    function syncRequestGhosts() {
        const wanted = new Set();
        for (const request of requests) {
            if (!request.aim || !request.tokenId) continue;
            const key = `req:${request.id}`;
            wanted.add(key);
            showGhost(key, { tokenId: request.tokenId, name: request.spell, type: request.type, shape: request.aim.shape, point: request.aim.point }, 0);
            dropGhost(`live:${request.user}`); // released: the waiting one replaces the moving one
        }
        for (const key of [...ghosts.keys()]) if (key.startsWith('req:') && !wanted.has(key)) dropGhost(key);
    }

    socket.on('cast-requests', (data) => {
        requests = Array.isArray(data && data.requests) ? data.requests.filter(request => request && typeof request === 'object') : [];
        render();
        syncRequestGhosts();
    });
    socket.on('cast-aim', (data) => {
        if (!data || typeof data.user !== 'string') return;
        const key = `live:${data.user}`;
        if (!data.shape || !data.point) { dropGhost(key); return; }
        showGhost(key, data, performance.now() + GHOST_LIFE_MS);
    });
    socket.on('cast-fx', (data) => { if (data && data.fx) onFx({ fx: data.fx }); });
    socket.on('cast-denied', (data) => notify((data && data.reason) || 'The GM refused the spell'));

    function send(spec, point) {
        socket.emit('cast-request', {
            charId: spec.charId, tokenId: spec.tokenId, spell: spec.name, level: spec.level, type: spec.type,
            roll: spec.roll, slot: spec.slot || undefined, concentration: spec.concentration === true, form: spec.form, light: spec.light || undefined,
            summon: spec.summon || undefined,
            ...(spec.shape && point ? { aim: { shape: spec.shape, point } } : {})
        });
        if (!isGM()) notify(`${spec.name}: asked the GM`);
    }

    return {
        get active() { return tool.active; },
        refresh: () => socket.emit('get-cast-requests'),

        // spec: { charId, tokenId (own token on this map, or null), name, level,
        // type (damage type), shape (aoe shape, or null), roll (what the cast
        // rolls at the table), slot, concentration }. An area is aimed first.
        request(spec) {
            this.cancel(true);
            if (!spec.shape || !spec.tokenId) { send(spec, null); return; }
            aiming = spec;
            probe.reset();
            tool.begin({
                shape: spec.shape, casterId: spec.tokenId, name: spec.name, type: spec.type,
                onCommit: (point) => { aiming = null; send(spec, point); }
            });
            notify(tool.hint());
            onChange();
        },
        move(point) {
            if (!tool.active || !aiming || !point) return;
            tool.move(point);
            const now = performance.now();
            if (now - sentAt >= AIM_EVERY_MS) {
                sentAt = now;
                socket.emit('cast-aim', { tokenId: aiming.tokenId, name: aiming.name, type: aiming.type, shape: aiming.shape, point: { x: point.x, z: point.z } });
            }
            onChange();
        },
        commit() { const done = tool.commit(); if (done) onChange(); return done; },
        cancel(silent = false) {
            const spec = aiming;
            if (!tool.cancel()) return false;
            aiming = null;
            if (spec) socket.emit('cast-aim', { tokenId: spec.tokenId, name: spec.name, shape: spec.shape, point: null });
            if (!silent && spec) notify(`${spec.name} cancelled`);
            onChange();
            return true;
        },
        hint() { return tool.hint(); },
        tick() {
            const seconds = (performance.now() - started) / 1000;
            tool.tick(seconds);
            const now = performance.now();
            for (const [key, ghost] of [...ghosts]) {
                if (ghost.until && now > ghost.until) dropGhost(key);
                else ghost.tool.tick(seconds);
            }
            // Tokens move (or arrive) under a waiting template: look again now and then.
            if (now - refreshedAt > 500) {
                refreshedAt = now;
                for (const ghost of ghosts.values()) ghost.tool.refresh();
                // Summons come and go with the map's objects.
                const stamp = summons().map(data => data.id).join(',');
                if (stamp !== summonStamp) { summonStamp = stamp; render(); }
            }
        }
    };
}
