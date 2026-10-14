// rolllog.js — the table log on both tabletop screens: every roll made at the
// table (checks, saves, skills, spells, free dice) and a mirror of the combat
// log, kept by the server per campaign (rolls.json) so it outlives the fight.
//
// The server rolls. A screen only asks: `log.roll({ actor, label, d20, dice,
// dc, note, gmOnly })` → socket `roll`; results come back to everyone as
// `roll-logged`. The panel opens from a "Rolls" button it adds to the top bar;
// while it is shut, new results surface as a short toast in the same corner.
// `log.notice(text)` shows a plain toast (refusals like a locked door).

import { escHtml } from './campaigns.js';

const signed = (n) => (n < 0 ? '−' : '+') + Math.abs(n);
const MODES = [['', 'Normal'], ['adv', 'Advantage'], ['dis', 'Disadvantage']];

// "1d20+5" typed as a free roll is a d20 test (so advantage applies); anything
// else is plain dice.
function parseQuickRoll(text) {
    const clean = String(text || '').replace(/\s+/g, '').toLowerCase();
    if (!clean) return null;
    const test = /^(?:1?d20)?([+-]\d+)?$/.exec(clean);
    if (test && (clean.includes('d20') || test[1])) return { d20: { bonus: Number(test[1]) || 0 } };
    if (/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(clean)) return { dice: [{ expr: clean }] };
    return null;
}

export function entryHTML(entry) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const time = e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    if (e.kind === 'combat') {
        return `<div class="roll-entry is-combat"><div class="roll-head"><span class="roll-actor">⚔ Combat${e.round ? ` · round ${escHtml(e.round)}` : ''}</span><span class="roll-time">${escHtml(time)}</span></div>
            <div class="roll-note">${escHtml(e.text)}</div></div>`;
    }
    const d20 = e.d20;
    let result = '';
    if (d20) {
        const natural = d20.used === 20 ? ' is-crit' : d20.used === 1 ? ' is-fumble' : '';
        const dice = d20.mode
            ? `[${(d20.rolls || []).map(escHtml).join(', ')}] → ${escHtml(d20.used)}`
            : escHtml(d20.used);
        const verdict = e.dc ? ` <span class="roll-verdict ${e.success ? 'ok' : 'bad'}">vs DC ${escHtml(e.dc)} · ${e.success ? 'success' : 'failure'}</span>` : '';
        result += `<div class="roll-line"><span class="roll-total${natural}">${escHtml(d20.total)}</span>
            <span class="roll-math">d20 ${dice} ${signed(Number(d20.bonus) || 0)}${d20.mode > 0 ? ' · advantage' : d20.mode < 0 ? ' · disadvantage' : ''}${d20.raised != null ? ` · rolled ${escHtml(d20.raised)}, counts as ${escHtml(d20.used)}` : ''}${d20.floored != null ? ` · raised from ${escHtml(d20.floored)}` : ''}</span>${verdict}</div>`;
    }
    for (const part of Array.isArray(e.dice) ? e.dice : []) {
        result += `<div class="roll-line"><span class="roll-total is-dice">${escHtml(part.total)}</span>
            <span class="roll-math">${escHtml(part.expr)}${part.type ? ' ' + escHtml(part.type) : ''} [${(part.rolls || []).map(escHtml).join(', ')}]</span></div>`;
    }
    const who = e.user && e.user !== e.actor ? ` <span class="roll-user">${escHtml(e.user)}</span>` : '';
    return `<div class="roll-entry${e.gmOnly ? ' is-private' : ''}">
        <div class="roll-head"><span class="roll-actor">${escHtml(e.actor || e.user || '')}${who}</span><span class="roll-time">${e.gmOnly ? '🔒 ' : ''}${escHtml(time)}</span></div>
        <div class="roll-label">${escHtml(e.label || 'Roll')}</div>${result}
        ${e.note ? `<div class="roll-note">${escHtml(e.note)}</div>` : ''}</div>`;
}

// socket: the page's socket · isGM(): boolean · actor(): default name on free rolls
export function createRollLog({ socket, isGM = () => false, actor = () => '' }) {
    let entries = [];
    let mode = '';
    let unread = 0;
    let toastTimer = 0;

    const button = document.createElement('button');
    button.id = 'btn-workspace-rolls';
    button.className = 'workspace-top-button';
    button.title = 'Table log: every roll and combat result';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = 'Rolls<span class="roll-badge hidden"></span>';
    const actions = document.querySelector('#workspace-topbar .workspace-actions');
    const help = document.getElementById('btn-workspace-help');
    if (actions) actions.insertBefore(button, help && help.parentNode === actions ? help : null);

    const panel = document.createElement('section');
    panel.id = 'roll-log';
    panel.className = 'hidden';
    panel.setAttribute('aria-label', 'Table log');
    panel.innerHTML = `
        <div class="roll-log-bar"><span>Table log</span>
            <span><button type="button" class="roll-log-clear hidden" title="Erase the whole log for everyone">Clear</button>
            <button type="button" class="roll-log-close" aria-label="Close the table log">&times;</button></span></div>
        <div class="roll-log-list" aria-live="polite"></div>
        <form class="roll-log-quick">
            <div class="roll-modes">${MODES.map(([value, label]) =>
                `<button type="button" data-roll-mode="${value}"${value === '' ? ' class="active"' : ''}>${label}</button>`).join('')}</div>
            <div class="roll-quick-row">
                <input name="expr" autocomplete="off" maxlength="40" placeholder="d20+5 · 2d6+3" aria-label="Dice to roll">
                <input name="label" autocomplete="off" maxlength="60" placeholder="what for" aria-label="What the roll is for">
                <button type="submit">Roll</button>
            </div>
            <label class="roll-private hidden"><input type="checkbox" name="gmOnly"> Only the GM sees it</label>
            <div class="roll-quick-error" role="alert"></div>
        </form>`;
    const toast = document.createElement('div');
    toast.id = 'roll-toast';
    toast.className = 'hidden';
    document.body.append(panel, toast);

    const list = panel.querySelector('.roll-log-list');
    const badge = button.querySelector('.roll-badge');
    const form = panel.querySelector('.roll-log-quick');
    const error = panel.querySelector('.roll-quick-error');
    const isOpen = () => !panel.classList.contains('hidden');

    function render() {
        list.innerHTML = entries.length
            ? entries.map(entryHTML).join('')
            : '<p class="roll-empty">Nothing rolled yet. Click an ability, a save or a skill on a character sheet, cast a spell, or type dice below.</p>';
        list.scrollTop = list.scrollHeight;
        panel.querySelector('.roll-log-clear').classList.toggle('hidden', !isGM() || !entries.length);
        panel.querySelector('.roll-private').classList.toggle('hidden', !isGM());
    }
    function setUnread(n) {
        unread = n;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.toggle('hidden', n < 1);
    }
    function setOpen(open) {
        panel.classList.toggle('hidden', !open);
        button.setAttribute('aria-expanded', String(open));
        if (open) { toast.classList.add('hidden'); setUnread(0); render(); }
    }
    function showToast(html, ms) {
        toast.innerHTML = html;
        toast.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
    }

    button.addEventListener('click', () => setOpen(!isOpen()));
    panel.querySelector('.roll-log-close').addEventListener('click', () => setOpen(false));
    panel.querySelector('.roll-log-clear').addEventListener('click', () => {
        if (confirm('Erase the table log for everyone?')) socket.emit('clear-roll-log');
    });
    toast.addEventListener('click', () => setOpen(true));
    panel.querySelectorAll('[data-roll-mode]').forEach(option => option.addEventListener('click', () => {
        mode = option.dataset.rollMode;
        panel.querySelectorAll('[data-roll-mode]').forEach(other => other.classList.toggle('active', other === option));
    }));
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const parsed = parseQuickRoll(form.expr.value);
        if (!parsed) { error.textContent = 'Write dice like d20+5, 2d6+3 or 1d8+1d6.'; return; }
        error.textContent = '';
        roll({ ...parsed, label: form.label.value.trim() || form.expr.value.trim(), gmOnly: form.gmOnly.checked });
    });

    socket.on('roll-log', (data) => {
        entries = Array.isArray(data && data.entries) ? data.entries : [];
        setUnread(0);
        render();
    });
    socket.on('roll-logged', (entry) => {
        if (!entry || entries.some(known => known.id === entry.id && known.kind === entry.kind)) return;
        entries.push(entry);
        if (entries.length > 400) entries.splice(0, entries.length - 400);
        if (isOpen()) {
            list.querySelector('.roll-empty')?.remove();
            list.insertAdjacentHTML('beforeend', entryHTML(entry));
            list.scrollTop = list.scrollHeight;
            panel.querySelector('.roll-log-clear').classList.toggle('hidden', !isGM());
        } else {
            setUnread(unread + 1);
            if (entry.kind !== 'combat') showToast(entryHTML(entry), 6000);  // the tracker already shows combat
        }
    });

    // request: { actor?, label, d20?: { bonus }, dice?: [{ expr, type }], dc?, note?, gmOnly?, mode? }
    function roll(request) {
        const payload = { actor: actor(), ...request };
        if (payload.d20) {
            payload.d20 = {
                bonus: payload.d20.bonus, mode: request.mode != null ? request.mode : mode,
                ...(request.d20.min > 1 ? { min: request.d20.min } : {}),
                ...(request.d20.floor > 0 ? { floor: request.d20.floor } : {})
            };
        }
        delete payload.mode;
        socket.emit('roll', payload);
    }

    return {
        roll,
        refresh: () => socket.emit('get-roll-log'),
        toggle: () => setOpen(!isOpen()),
        // Chosen in the panel: '', 'adv' or 'dis' — sheets roll with it too.
        get mode() { return mode; },
        notice: (text) => showToast(`<div class="roll-entry is-notice"><div class="roll-note">${escHtml(text)}</div></div>`, 3500)
    };
}
