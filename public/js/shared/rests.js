// rests.js — spent spell slots / feature pools and the rest desk, on both
// tabletop screens. The server keeps what each character has USED
// (pools.json); the sheet says how many there are. A player asks for a short
// or a long rest, the GM says yes or no (or rests the whole party unasked).
//
// `createRestDesk({ socket, isGM, username, characters, notify, onChange, onRest })`
// adds a "Rest" top-bar button and its panel, and returns the pool readers the
// sheet uses: `slotsLeft(charId, level, max)`, `pactLeft(charId, max)`,
// `resourceLeft(charId, key, max)`.

import { escHtml } from './campaigns.js';

const REST_LABEL = { short: 'Short rest', long: 'Long rest' };

// characters(): [{ id, name }] — the viewer's own characters (players only).
export function createRestDesk({
    socket, isGM = () => false, username = () => '', characters = () => [],
    notify = () => {}, onChange = () => {}, onRest = () => {}
}) {
    let pools = {};
    let requests = [];

    const button = document.createElement('button');
    button.id = 'btn-workspace-rest';
    button.className = 'workspace-top-button';
    button.title = 'Short and long rests';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = 'Rest<span class="roll-badge hidden"></span>';
    const actions = document.querySelector('#workspace-topbar .workspace-actions');
    const rolls = document.getElementById('btn-workspace-rolls');
    const help = document.getElementById('btn-workspace-help');
    const anchor = rolls && rolls.parentNode === actions ? rolls : (help && help.parentNode === actions ? help : null);
    if (actions) actions.insertBefore(button, anchor);

    const panel = document.createElement('section');
    panel.id = 'rest-desk';
    panel.className = 'hidden';
    panel.setAttribute('aria-label', 'Rests');
    document.body.append(panel);
    const badge = button.querySelector('.roll-badge');
    const isOpen = () => !panel.classList.contains('hidden');

    function render() {
        const gm = isGM();
        const mine = requests.filter(request => request.owner === username());
        const waiting = gm ? requests.length : mine.length;
        badge.textContent = String(waiting);
        badge.classList.toggle('hidden', waiting < 1);
        if (!isOpen()) return;

        const requestRow = (request) => `<div class="rest-row">
            <div><b>${escHtml(request.name)}</b> <span class="rest-who">${escHtml(request.owner)}</span>
                <div class="rest-kind">asks for a ${escHtml(REST_LABEL[request.kind].toLowerCase())}</div></div>
            <span class="rest-actions">${gm
                ? `<button type="button" data-rest-approve="${escHtml(request.id)}">Allow</button><button type="button" class="quiet" data-rest-deny="${escHtml(request.id)}">Refuse</button>`
                : (request.owner === username() ? `<button type="button" class="quiet" data-rest-cancel="${escHtml(request.id)}">Cancel</button>` : '')}</span>
        </div>`;

        let body = '';
        if (gm) {
            body += requests.length
                ? requests.map(requestRow).join('')
                : '<p class="roll-empty">Nobody is asking for a rest.</p>';
            body += `<div class="rest-party"><span>Whole party</span>
                <span class="rest-actions"><button type="button" data-rest-grant="short">Short rest</button><button type="button" data-rest-grant="long">Long rest</button></span></div>`;
        } else {
            const own = characters();
            body += own.length ? own.map(character => {
                const pending = mine.find(request => request.charId === character.id);
                const pool = pools[character.id];
                // A short rest is on: spend hit dice to heal, then finish it.
                if (pool && pool.hdOpen && pool.vit) {
                    const dice = Object.entries(pool.vit.hd).map(([die, max]) => {
                        const left = Math.max(0, max - ((pool.hd && pool.hd[die]) || 0));
                        return `<button type="button" data-hit-die="${escHtml(die)}" data-char="${escHtml(character.id)}"${left ? '' : ' disabled'} title="Roll 1d${escHtml(die)} + CON and heal that much">d${escHtml(die)} · ${left}/${escHtml(max)}</button>`;
                    }).join('');
                    return `<div class="rest-row rest-resting">
                        <div><b>${escHtml(character.name || 'Adventurer')}</b>
                            <div class="rest-kind">Short rest: spend hit dice to heal</div></div>
                        <span class="rest-actions">${dice}<button type="button" class="quiet" data-rest-done="${escHtml(character.id)}">Done</button></span>
                    </div>`;
                }
                return `<div class="rest-row">
                    <div><b>${escHtml(character.name || 'Adventurer')}</b>
                        <div class="rest-kind">${pending ? `Waiting for the GM: ${escHtml(REST_LABEL[pending.kind].toLowerCase())}` : 'Ask the GM for a rest'}</div></div>
                    <span class="rest-actions">${pending
                        ? `<button type="button" class="quiet" data-rest-cancel="${escHtml(pending.id)}">Cancel</button>`
                        : `<button type="button" data-rest-ask="short" data-char="${escHtml(character.id)}">Short</button><button type="button" data-rest-ask="long" data-char="${escHtml(character.id)}">Long</button>`}</span>
                </div>`;
            }).join('') : '<p class="roll-empty">You have no character at this table yet.</p>';
            const others = requests.filter(request => request.owner !== username());
            if (others.length) body += `<div class="rest-others">${others.map(requestRow).join('')}</div>`;
        }
        panel.innerHTML = `<div class="roll-log-bar"><span>Rests</span>
            <button type="button" class="roll-log-close" aria-label="Close">&times;</button></div>
            <div class="rest-body">${body}</div>
            <p class="rest-foot">Short rest: pact slots, short-rest features, and hit dice to heal with. Long rest: hit points, every spell slot and feature, half your hit dice.</p>`;

        panel.querySelector('.roll-log-close').onclick = () => setOpen(false);
        panel.querySelectorAll('[data-rest-ask]').forEach(el => el.onclick = () =>
            socket.emit('request-rest', { charId: el.dataset.char, kind: el.dataset.restAsk }));
        panel.querySelectorAll('[data-hit-die]').forEach(el => el.onclick = () =>
            socket.emit('spend-hit-die', { charId: el.dataset.char, die: Number(el.dataset.hitDie) }));
        panel.querySelectorAll('[data-rest-done]').forEach(el => el.onclick = () =>
            socket.emit('end-rest', { charId: el.dataset.restDone }));
        panel.querySelectorAll('[data-rest-cancel]').forEach(el => el.onclick = () =>
            socket.emit('cancel-rest', { id: el.dataset.restCancel }));
        panel.querySelectorAll('[data-rest-approve]').forEach(el => el.onclick = () =>
            socket.emit('resolve-rest', { id: el.dataset.restApprove, approve: true }));
        panel.querySelectorAll('[data-rest-deny]').forEach(el => el.onclick = () =>
            socket.emit('resolve-rest', { id: el.dataset.restDeny, approve: false }));
        panel.querySelectorAll('[data-rest-grant]').forEach(el => el.onclick = () => {
            const kind = el.dataset.restGrant;
            if (confirm(`Give every character on the map a ${REST_LABEL[kind].toLowerCase()}?`)) socket.emit('grant-rest', { kind });
        });
    }
    function setOpen(open) {
        panel.classList.toggle('hidden', !open);
        button.setAttribute('aria-expanded', String(open));
        render();
    }
    button.addEventListener('click', () => setOpen(!isOpen()));

    socket.on('pools', (data) => {
        pools = (data && typeof data.pools === 'object' && data.pools) || {};
        requests = Array.isArray(data && data.requests) ? data.requests : [];
        render();
        onChange();
    });
    socket.on('pools-updated', ({ charId, pool } = {}) => {
        if (!charId) return;
        if (pool) pools[charId] = pool; else delete pools[charId];
        render();
        onChange(charId);
    });
    socket.on('rest-requests', (data) => {
        const known = new Set(requests.map(request => request.id));
        requests = Array.isArray(data && data.requests) ? data.requests : [];
        if (isGM()) {
            for (const request of requests) {
                if (!known.has(request.id)) notify(`${request.name} asks for a ${REST_LABEL[request.kind].toLowerCase()}: open Rest to answer`);
            }
        }
        render();
    });
    socket.on('rest-taken', ({ charId, kind, owner } = {}) => {
        if (owner && owner === username()) {
            notify(`${REST_LABEL[kind] || 'Rest'} granted`);
            if (kind === 'short') setOpen(true); // the hit dice are waiting here
        }
        onRest(charId, kind, owner);
        onChange(charId);
    });
    socket.on('rest-denied', ({ kind, owner, name } = {}) => {
        if (owner === username()) notify(`The GM refused ${name || 'your character'}'s ${(REST_LABEL[kind] || 'rest').toLowerCase()}`);
    });

    const poolOf = (charId) => pools[charId] || null;
    return {
        refresh: () => socket.emit('get-pools'),
        toggle: () => setOpen(!isOpen()),
        slotsLeft(charId, level, max) {
            const pool = poolOf(charId);
            return Math.max(0, (Number(max) || 0) - ((pool && pool.slots && pool.slots[level]) || 0));
        },
        pactLeft(charId, max) {
            const pool = poolOf(charId);
            return Math.max(0, (Number(max) || 0) - ((pool && pool.pact) || 0));
        },
        // The spell held outside a fight: { name, dc? (a check is owed) } or null.
        concentrationOf(charId) {
            const pool = poolOf(charId);
            return (pool && pool.conc && pool.conc.name) ? pool.conc : null;
        },
        resourceLeft(charId, key, max) {
            const pool = poolOf(charId);
            const spent = pool && pool.res && pool.res[key];
            return Math.max(0, (Number(max) || 0) - ((spent && spent.used) || 0));
        }
    };
}
