// access.js — the per-campaign access dialog (privacy + invites), shared by
// the lobby's campaign cards and the GM screen's campaign panel. The DOM is
// built lazily into the page body, so shells ship no markup for it; account
// names and campaign names are user text and only ever go out through escHtml.

import { escHtml } from './campaigns.js';

export function createAccessDialog({ getSocket = () => null, onSaved = () => {} } = {}) {
    let overlay = null;
    let boundSocket = null;
    let campaign = null;   // the campaign being edited (mutated on save)
    let users = [];        // account directory for the invite checkboxes
    let dirty = false;     // the user touched the list: a late directory must not wipe it

    function showError(message) {
        const el = overlay && overlay.querySelector('#access-error');
        if (!el) return;
        el.textContent = message || '';
        el.classList.toggle('hidden', !message);
    }

    function renderMembers() {
        const box = overlay.querySelector('#access-members');
        if (!box || !campaign) return;
        const invited = new Set((campaign.members || []).map(name => String(name).toLowerCase()));
        const candidates = users.filter(user => user && !user.disabled &&
            String(user.username || '').toLowerCase() !== String(campaign.owner || '').toLowerCase());
        box.innerHTML = candidates.length
            ? candidates.map(user => `
                <label>
                    <input type="checkbox" name="access-member" value="${escHtml(user.username)}"
                        ${invited.has(String(user.username).toLowerCase()) ? 'checked' : ''} />
                    <span>${escHtml(user.username)}</span>
                </label>`).join('')
            : '<p class="access-empty">No other players on this server yet.</p>';
        box.querySelectorAll('input[name="access-member"]').forEach(input => {
            input.addEventListener('change', () => { dirty = true; });
        });
    }

    function ensureDOM() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'access-overlay';
        overlay.className = 'hidden';
        overlay.innerHTML = `
            <div id="access-modal" role="dialog" aria-modal="true" aria-labelledby="access-title">
                <h2 id="access-title">Campaign access</h2>
                <p id="access-sub"></p>
                <label class="access-radio">
                    <input type="radio" name="access-visibility" value="private" />
                    <span><strong>Private</strong> &mdash; only players you invite can see and join it.</span>
                </label>
                <label class="access-radio">
                    <input type="radio" name="access-visibility" value="public" />
                    <span><strong>Public</strong> &mdash; everyone on this server can see and join it.</span>
                </label>
                <h3 class="access-heading">Invited players</h3>
                <div id="access-members"></div>
                <div class="access-actions">
                    <div id="access-error" class="hidden"></div>
                    <button id="access-cancel" type="button" class="access-btn">Cancel</button>
                    <button id="access-save" type="button" class="access-btn primary">Save</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        overlay.querySelector('#access-cancel').addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('#access-save').addEventListener('click', () => {
            const socket = getSocket();
            if (!campaign || !socket) return;
            const visibility = overlay.querySelector('input[name="access-visibility"]:checked');
            socket.emit('set-campaign-access', {
                id: campaign.id,
                visibility: visibility ? visibility.value : undefined,
                members: [...overlay.querySelectorAll('input[name="access-member"]:checked')]
                    .map(input => input.value)
            });
        });
    }

    // Listeners bind once per socket (a re-login hands us a new one).
    function bind() {
        const socket = getSocket();
        if (!socket || socket === boundSocket) return;
        boundSocket = socket;
        socket.on('user-list', (payload) => {
            users = (payload && Array.isArray(payload.users)) ? payload.users : [];
            if (overlay && !overlay.classList.contains('hidden') && !dirty) renderMembers();
        });
        socket.on('campaign-access-saved', (payload) => {
            if (!campaign || !payload || payload.id !== campaign.id) return;
            // The answer carries the saved state: keep the caller's view fresh
            // (the lobby card, the GM panel hint) without a full list refetch.
            if (payload.visibility) campaign.visibility = payload.visibility;
            if (Array.isArray(payload.members)) campaign.members = payload.members;
            close();
            onSaved(payload);
        });
        socket.on('error', (message) => {
            // Refusals land here while the dialog is open; the page's own
            // error handler must not echo them a second time.
            if (overlay && !overlay.classList.contains('hidden')) showError(String(message));
        });
    }

    function open(next, directory) {
        if (!next || !next.id) return;
        ensureDOM();
        bind();
        campaign = next;
        dirty = false;
        showError('');
        overlay.querySelector('#access-sub').textContent = next.name || '';
        const visibility = next.visibility === 'private' ? 'private' : 'public';
        const radio = overlay.querySelector(`input[name="access-visibility"][value="${visibility}"]`);
        if (radio) radio.checked = true;
        if (Array.isArray(directory) && directory.length) {
            users = directory;
            renderMembers();
        } else {
            overlay.querySelector('#access-members').innerHTML =
                '<p class="access-empty">Loading players&hellip;</p>';
        }
        overlay.classList.remove('hidden');
        // Fresh directory every open (a just-created account must be pickable).
        const socket = getSocket();
        if (socket) socket.emit('get-users');
    }

    function close() {
        campaign = null;
        if (overlay) overlay.classList.add('hidden');
    }

    return {
        open,
        close,
        isOpen: () => !!overlay && !overlay.classList.contains('hidden'),
        openId: () => (campaign ? campaign.id : null)
    };
}
