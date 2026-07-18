// combat.js — shared combat-mode client pieces for the GM and player screens:
// the SRD→combatant stat derivation, the initiative tracker + combat log UI
// (CombatTracker), and the three.js overlays (turn ring, movement-range ring,
// effect badges). The server owns the combat state and all dice; this module
// only renders state and emits the combat-* events.

import * as THREE from 'three';
import { ABILITIES, abilityMod, fmtMod, proficiencyBonus } from './srd.js';

const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Effect keys mirror the server's CONDITION_LABELS. auto effects (Dash/Dodge/
// Disengage) expire at the start of the combatant's next turn.
export const EFFECTS = {
    dodging: { label: 'Dodge', glyph: '🛡️' },
    disengaged: { label: 'Disengage', glyph: '↪' },
    dashed: { label: 'Dash', glyph: '💨' },
    down: { label: 'Down', glyph: '💀' },
    prone: { label: 'Prone', glyph: '⬇' },
    poisoned: { label: 'Poisoned', glyph: '🤢' },
    restrained: { label: 'Restrained', glyph: '⛓' },
    stunned: { label: 'Stunned', glyph: '💫' },
    blinded: { label: 'Blinded', glyph: '🙈' },
    frightened: { label: 'Frightened', glyph: '😱' },
    grappled: { label: 'Grappled', glyph: '✊' },
    invisible: { label: 'Invisible', glyph: '👻' }
};
// Conditions the GM can hand out from the tracker (the auto ones come from actions).
const GM_CONDITIONS = ['prone', 'poisoned', 'restrained', 'stunned', 'blinded', 'frightened', 'grappled', 'invisible', 'down'];

export function remainingFeet(c) {
    return Math.max(0, Math.round(c.speedFeet + c.dashFeet - c.movementUsedFeet));
}

// SRD-derived combat stats for a character — the same math as the player HUD's
// deriveSheet, trimmed to what the server's combatant entry needs.
export function deriveCombatStats(char, SRD) {
    const base = char.abilities || char.stats || { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
    const classes = char.classes || [];
    const finals = SRD.finalAbilities(base, char.race, char.subrace, char.racialChoice || []);
    const mods = {}; for (const a of ABILITIES) mods[a] = abilityMod(finals[a]);
    const prof = proficiencyBonus(SRD.totalLevel(classes));
    const eq = char.equipment || {};
    const acInfo = SRD.armorClass({ armorIdx: eq.armor, shield: eq.shield, dexMod: mods.dex, classes, conMod: mods.con, wisMod: mods.wis });
    const attacks = (eq.weapons || []).map(wi => {
        const w = SRD.get('equipment', wi); if (!w) return null;
        const a = SRD.weaponAttack(w, mods, classes, prof);
        return {
            name: w.name, attack: a.attack, damage: a.damage, damageType: a.damageType,
            ranged: a.ranged, rangeFt: (w.range && w.range.normal) || 5
        };
    }).filter(Boolean);
    attacks.push({
        name: 'Unarmed Strike', attack: mods.str + prof,
        damage: String(Math.max(1, 1 + mods.str)), damageType: 'bludgeoning', ranged: false, rangeFt: 5
    });
    return {
        ac: acInfo.ac, speedFeet: SRD.speed(char.race), initMod: mods.dex,
        maxHP: SRD.maxHP(classes, mods.con), attacks
    };
}

function cssColor(c) {
    if (typeof c === 'number') return '#' + c.toString(16).padStart(6, '0');
    return String(c || '#dd4444');
}

const LOG_ICONS = { info: '•', initiative: '🎲', attack: '⚔', action: '✦', turn: '▶', damage: '💥' };

// --- Initiative tracker + combat log -----------------------------------------
// One instance per screen. setState(combat|null) re-renders everything;
// appendLog streams a line in between state broadcasts. All clicks are
// delegated through data-act attributes; the page supplies onPickTarget to run
// its 3D target-pick flow when an attack button is pressed.
export class CombatTracker {
    constructor({ container, socket, isGM, username, onPickTarget, getMapObjects }) {
        this.container = container;
        this.socket = socket;
        this.isGM = !!isGM;
        this.username = username;
        this.onPickTarget = onPickTarget || (() => {});
        this.getMapObjects = getMapObjects || (() => []);
        this.state = null;
        this.flashTimer = null;
        container.classList.add('combat-tracker');
        container.addEventListener('click', (e) => this.onClick(e));
        container.addEventListener('change', (e) => this.onChange(e));
    }

    canControl(c) { return this.isGM || (!!c.owner && c.owner === this.username); }

    setState(combat) {
        this.state = combat;
        if (!combat) { this.container.classList.add('hidden'); this.container.innerHTML = ''; return; }
        this.container.classList.remove('hidden');
        this.render();
    }

    appendLog(entry) {
        if (!this.state) return;
        if (this.state.log.some(l => l.id === entry.id)) return;
        this.state.log.push(entry);
        const logEl = this.container.querySelector('.combat-log');
        if (logEl) {
            logEl.insertAdjacentHTML('beforeend', this.logLineHTML(entry));
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    flash(text) {
        const el = this.container.querySelector('.combat-flash');
        if (!el) return;
        el.textContent = text;
        el.classList.add('show');
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => el.classList.remove('show'), 2500);
    }

    logLineHTML(entry) {
        return `<div class="log-line log-${escHtml(entry.kind)}"><span class="log-ic">${LOG_ICONS[entry.kind] || '•'}</span>${escHtml(entry.text)}</div>`;
    }

    // The combatant ids in display order: turn order once started, name order while gathering.
    displayOrder() {
        const s = this.state;
        if (s.started && s.order.length) {
            const extra = Object.keys(s.combatants).filter(id => !s.order.includes(id));
            return [...s.order, ...extra];
        }
        return Object.keys(s.combatants).sort((a, b) =>
            String(s.combatants[a].name).localeCompare(String(s.combatants[b].name)));
    }

    rowHTML(c, idx) {
        const s = this.state;
        const active = s.started && s.activeId === c.id;
        const mine = this.canControl(c);
        const hp = c.hp ? `${c.hp.current}/${c.maxHP}` : `—/${c.maxHP}`;
        const badges = (c.effects || []).map(e => {
            const glyph = (EFFECTS[e.key] && EFFECTS[e.key].glyph) || '●';
            const rm = this.isGM ? ` data-act="fx-remove" data-id="${escHtml(c.id)}" data-key="${escHtml(e.key)}"` : '';
            return `<span class="badge-effect${this.isGM ? ' rm' : ''}" title="${escHtml(e.label)}${this.isGM ? ' (click to remove)' : ''}"${rm}>${glyph}</span>`;
        }).join('');
        const ed = (field, val, title) => this.isGM
            ? `<span class="ce" data-act="edit" data-id="${escHtml(c.id)}" data-field="${field}" title="${title} (click to edit)">${escHtml(val)}</span>`
            : `<span title="${title}">${escHtml(val)}</span>`;

        let buttons = '';
        if (c.initiative == null && mine) {
            buttons += `<button class="btn-combat roll" data-act="roll-init" data-id="${escHtml(c.id)}">🎲 Init</button>`;
        }
        if (active && mine) {
            if (!c.actionUsed) {
                buttons += (c.attacks || []).map((a, i) =>
                    `<button class="btn-combat atk" data-act="attack" data-id="${escHtml(c.id)}" data-atk="${i}" title="${fmtMod(a.attack)} to hit · ${escHtml(a.damage)} ${escHtml(a.damageType)}">⚔ ${escHtml(a.name)}</button>`).join('');
                buttons += `<button class="btn-combat" data-act="dash" data-id="${escHtml(c.id)}">💨 Dash</button>`
                    + `<button class="btn-combat" data-act="dodge" data-id="${escHtml(c.id)}">🛡 Dodge</button>`
                    + `<button class="btn-combat" data-act="disengage" data-id="${escHtml(c.id)}">↪ Disengage</button>`;
            } else {
                buttons += `<span class="tag">action used</span>`;
            }
            buttons += `<button class="btn-combat end" data-act="end-turn">■ End Turn</button>`;
        }

        let gmTools = '';
        if (this.isGM) {
            if (s.started) {
                gmTools += `<button class="btn-mini" data-act="set-turn" data-id="${escHtml(c.id)}" title="Jump turn here">▶</button>`
                    + `<button class="btn-mini" data-act="move-up" data-id="${escHtml(c.id)}" title="Move up">▲</button>`
                    + `<button class="btn-mini" data-act="move-down" data-id="${escHtml(c.id)}" title="Move down">▼</button>`;
            }
            gmTools += `<button class="btn-mini" data-act="remove" data-id="${escHtml(c.id)}" title="Remove from combat">✕</button>`
                + `<select class="fx-add" data-act="fx-add" data-id="${escHtml(c.id)}" title="Add condition">`
                + `<option value="">+fx</option>`
                + GM_CONDITIONS.map(k => `<option value="${k}">${EFFECTS[k].label}</option>`).join('')
                + `</select>`;
        }

        const initVal = c.initiative == null ? '—' : String(c.initiative);
        return `<div class="combat-row${active ? ' active' : ''}${c.statsPending ? ' pending' : ''}" data-row="${escHtml(c.id)}">
            <div class="cr-main">
                <span class="cr-marker">${active ? '▶' : (s.started ? (idx + 1) : '')}</span>
                <span class="cr-name" style="border-left-color:${cssColor(c.color)}">${escHtml(c.name)}${c.statsPending ? ' <span class="tag">…stats</span>' : ''}</span>
                <span class="cr-init" title="Initiative">🎲 ${this.isGM ? `<span class="ce" data-act="edit" data-id="${escHtml(c.id)}" data-field="initiative">${escHtml(initVal)}</span>` : escHtml(initVal)}</span>
                <span class="cr-stat" title="Armor Class">AC ${ed('ac', c.ac, 'Armor Class')}</span>
                <span class="cr-stat" title="Hit Points">HP ${ed('hp', hp, 'Hit Points (cur or cur/max)')}</span>
                <span class="cr-stat" title="Speed">${ed('speed', c.speedFeet, 'Speed (feet)')} ft</span>
                ${active ? `<span class="cr-move" title="Movement left this turn">${remainingFeet(c)} ft left</span>` : ''}
                ${badges}
            </div>
            ${buttons || gmTools ? `<div class="cr-actions">${buttons}${gmTools}</div>` : ''}
        </div>`;
    }

    render() {
        const s = this.state;
        if (!s) return;
        const order = this.displayOrder();
        const title = s.started ? `Combat — Round ${s.round}` : 'Combat — roll initiative!';
        let gmHeader = '';
        if (this.isGM) {
            gmHeader = (s.started
                ? `<button class="btn-combat" data-act="gm-next">Next Turn ⏭</button>`
                : `<button class="btn-combat" data-act="gm-begin" title="Auto-rolls missing initiative">Begin ▶</button>`)
                + `<button class="btn-combat danger" data-act="gm-end">End Combat</button>`;
        }
        const rows = order.map((id, i) => this.rowHTML(s.combatants[id], i)).join('')
            || '<p class="muted">No combatants.</p>';
        let gmAdd = '';
        if (this.isGM) {
            const candidates = this.getMapObjects().filter(o =>
                (o.type === 'token' || o.type === 'character') && !s.combatants[o.id]);
            if (candidates.length) {
                gmAdd = `<select class="fx-add" data-act="gm-add"><option value="">+ add to combat…</option>`
                    + candidates.map(o => `<option value="${escHtml(o.id)}">${escHtml(o.name || o.type)}</option>`).join('')
                    + `</select>`;
            }
        }
        const log = (s.log || []).map(l => this.logLineHTML(l)).join('');
        this.container.innerHTML = `
            <div class="ct-header"><span class="ct-title">⚔ ${escHtml(title)}</span><span class="ct-btns">${gmHeader}</span></div>
            <div class="combat-flash"></div>
            <div class="ct-rows">${rows}</div>
            ${gmAdd ? `<div class="ct-footer">${gmAdd}</div>` : ''}
            <div class="combat-log">${log}</div>`;
        const logEl = this.container.querySelector('.combat-log');
        if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }

    onClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.tagName === 'SELECT') return;
        const act = btn.dataset.act, id = btn.dataset.id;
        const emit = (ev, payload) => this.socket && this.socket.emit(ev, payload);
        switch (act) {
            case 'roll-init': emit('combat-roll-initiative', { combatantId: id }); break;
            case 'end-turn': emit('combat-end-turn', {}); break;
            case 'dash': case 'dodge': case 'disengage':
                emit('combat-action', { combatantId: id, kind: act }); break;
            case 'attack': {
                const c = this.state && this.state.combatants[id];
                const i = Number(btn.dataset.atk);
                if (c && c.attacks[i]) this.onPickTarget(id, i, c.attacks[i]);
                break;
            }
            case 'set-turn': emit('combat-set-turn', { combatantId: id }); break;
            case 'remove': emit('combat-remove-combatant', { combatantId: id }); break;
            case 'move-up': case 'move-down': {
                const order = [...this.state.order];
                const idx = order.indexOf(id);
                const to = act === 'move-up' ? idx - 1 : idx + 1;
                if (idx < 0 || to < 0 || to >= order.length) break;
                [order[idx], order[to]] = [order[to], order[idx]];
                emit('combat-set-order', { order });
                break;
            }
            case 'fx-remove': emit('combat-effect', { combatantId: id, key: btn.dataset.key, add: false }); break;
            case 'gm-begin': emit('combat-begin', {}); break;
            case 'gm-next': emit('combat-end-turn', {}); break;
            case 'gm-end': emit('combat-end', {}); break;
            case 'edit': this.beginEdit(btn); break;
        }
    }

    onChange(e) {
        const sel = e.target.closest('select[data-act]');
        if (!sel || !sel.value) return;
        if (sel.dataset.act === 'fx-add') {
            this.socket.emit('combat-effect', { combatantId: sel.dataset.id, key: sel.value, add: true });
        } else if (sel.dataset.act === 'gm-add') {
            this.socket.emit('combat-add-combatant', { objectId: sel.value });
        }
        sel.value = '';
    }

    // GM inline edit: swap the value span for an input; Enter/blur commits.
    beginEdit(span) {
        if (!this.isGM || span.querySelector('input')) return;
        const id = span.dataset.id, field = span.dataset.field;
        const old = span.textContent.trim();
        span.innerHTML = `<input class="ce-input" value="${escHtml(old === '—' ? '' : old)}">`;
        const input = span.querySelector('input');
        input.focus(); input.select();
        let done = false;
        const commit = () => {
            if (done) return; done = true;
            const raw = input.value.trim();
            span.textContent = old;
            if (!raw || raw === old) return;
            const patch = {};
            if (field === 'hp') {
                // "7" sets current HP; "7/12" sets current and max.
                const m = /^(\d+)\s*(?:\/\s*(\d+))?$/.exec(raw);
                if (!m) return;
                patch.hpCurrent = Number(m[1]);
                if (m[2]) patch.maxHP = Number(m[2]);
            } else {
                const v = Number(raw);
                if (!isFinite(v)) return;
                if (field === 'ac') patch.ac = v;
                else if (field === 'speed') patch.speedFeet = v;
                else if (field === 'initiative') patch.initiative = v;
            }
            this.socket.emit('combat-update-combatant', { combatantId: id, patch });
        };
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') commit();
            if (ev.key === 'Escape') { done = true; span.textContent = old; }
            ev.stopPropagation();
        });
        input.addEventListener('blur', commit);
    }
}

// --- three.js overlays --------------------------------------------------------
// All of these are world-coordinate meshes: pages must add them to worldGroup
// (never the scene) so they follow the floating origin.

// Owns the turn ring, movement-range ring and effect badges for one screen.
// sync(combat) rebuilds them from a state broadcast; tick() runs every frame so
// the overlays follow their tokens (drag previews included).
export class CombatOverlays {
    constructor({ worldGroup, findMesh, feetToWorld }) {
        this.worldGroup = worldGroup;
        this.findMesh = findMesh;          // combatant id -> mesh (or undefined)
        this.feetToWorld = feetToWorld;    // feet -> world units
        this.combat = null;
        this.turnRing = null;
        this.rangeRing = null;
        this.badges = new Map();           // combatant id -> sprite
    }

    clear() {
        if (this.turnRing) { this.worldGroup.remove(this.turnRing); this.turnRing.geometry.dispose(); this.turnRing.material.dispose(); this.turnRing = null; }
        if (this.rangeRing) { this.worldGroup.remove(this.rangeRing); this.rangeRing.geometry.dispose(); this.rangeRing.material.dispose(); this.rangeRing = null; }
        for (const spr of this.badges.values()) {
            this.worldGroup.remove(spr);
            if (spr.material.map) spr.material.map.dispose();
            spr.material.dispose();
        }
        this.badges.clear();
    }

    sync(combat) {
        this.combat = combat;
        this.clear();
        if (!combat || !combat.started) return;
        const active = combat.combatants[combat.activeId];
        if (active && this.findMesh(active.id)) {
            this.turnRing = createTurnRing();
            this.worldGroup.add(this.turnRing);
            const left = remainingFeet(active);
            if (left > 0) {
                this.rangeRing = createRangeRing(this.feetToWorld(left));
                this.worldGroup.add(this.rangeRing);
            }
        }
        for (const c of Object.values(combat.combatants)) {
            if (!(c.effects || []).length) continue;
            const spr = createEffectBadge(c.effects);
            if (spr && this.findMesh(c.id)) { this.badges.set(c.id, spr); this.worldGroup.add(spr); }
        }
        this.tick();
    }

    tick() {
        const combat = this.combat;
        if (combat && combat.started) {
            const mesh = this.findMesh(combat.activeId);
            if (mesh) {
                if (this.turnRing) {
                    this.turnRing.position.set(mesh.position.x, mesh.position.y + 0.04, mesh.position.z);
                    this.turnRing.rotation.z += 0.02;
                }
                if (this.rangeRing) this.rangeRing.position.set(mesh.position.x, mesh.position.y + 0.04, mesh.position.z);
            }
        }
        for (const [id, spr] of this.badges) {
            const mesh = this.findMesh(id);
            if (mesh) spr.position.set(mesh.position.x, mesh.position.y + 1.6, mesh.position.z);
        }
    }
}

export function createTurnRing() {
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.56, 40),
        new THREE.MeshBasicMaterial({ color: 0xffdd55, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 999;
    return ring;
}

// Thin circle line showing the movement left this turn (radius in world units).
export function createRangeRing(radiusWorld) {
    const segs = 72, pts = [];
    for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radiusWorld, 0, Math.sin(a) * radiusWorld));
    }
    const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x55ccff, transparent: true, opacity: 0.65, depthTest: false })
    );
    line.renderOrder = 998;
    return line;
}

// Floating sprite of up to 3 effect glyphs, hovered above a token by the page.
export function createEffectBadge(effects) {
    const glyphs = (effects || []).slice(0, 3).map(e => (EFFECTS[e.key] && EFFECTS[e.key].glyph) || '●');
    if (!glyphs.length) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 192; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(20, 20, 26, 0.75)';
    const w = 24 + glyphs.length * 46;
    const x0 = (canvas.width - w) / 2;
    ctx.beginPath();
    ctx.roundRect(x0, 6, w, 52, 14);
    ctx.fill();
    ctx.font = '34px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    glyphs.forEach((g, i) => ctx.fillText(g, x0 + 35 + i * 46, 34));
    const tex = new THREE.CanvasTexture(canvas);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.scale.set(1.5, 0.5, 1);
    spr.renderOrder = 1000;
    return spr;
}
