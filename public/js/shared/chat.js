// chat.js — the table chat on both tabletop screens: OOC conversation with
// private whispers, kept per campaign (chat.json) so the history outlives a
// refresh. A whisper is only ever delivered to its two speakers — not even
// the GM reads it — and the picker offers whoever sits at this table.
//
// `chat.refresh()` asks the server for the history; live messages arrive as
// `chat-message`. The panel opens from a "Chat" button it adds to the top
// bar; while it is shut, unread messages surface as the button's badge.

import { escHtml } from './campaigns.js';

const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function entryHTML(message, self) {
    const at = Number(message.at) || 0;
    const time = at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const whisper = message.to;
    const who = whisper
        ? `${escHtml(message.from)} <span class="chat-whisper-mark">→</span> ${escHtml(message.to)}`
        : escHtml(message.from);
    const mine = sameName(message.from, self) ? ' is-mine' : '';
    return `<div class="chat-entry${whisper ? ' is-whisper' : ''}${mine}">
        <div class="chat-head"><span class="chat-who">${who}${whisper ? ' <span class="chat-whisper-tag">whisper</span>' : ''}</span><span class="chat-time">${escHtml(time)}</span></div>
        <div class="chat-text">${escHtml(message.text)}</div></div>`;
}

// socket: the page's socket · username(): the signed-in name
export function createChat({ socket, username = () => '' }) {
    let messages = [];
    let peers = [];
    let unread = 0;

    const button = document.createElement('button');
    button.id = 'btn-workspace-chat';
    button.className = 'workspace-top-button';
    button.title = 'Table chat: OOC talk and whispers';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = 'Chat<span class="roll-badge hidden"></span>';
    const actions = document.querySelector('#workspace-topbar .workspace-actions');
    const help = document.getElementById('btn-workspace-help');
    if (actions) actions.insertBefore(button, help && help.parentNode === actions ? help : null);

    const panel = document.createElement('section');
    panel.id = 'chat-panel';
    panel.className = 'hidden';
    panel.setAttribute('aria-label', 'Table chat');
    panel.innerHTML = `
        <div class="roll-log-bar"><span>Chat</span>
            <button type="button" class="roll-log-close" aria-label="Close the chat">&times;</button></div>
        <div class="chat-list" aria-live="polite"></div>
        <form class="chat-form">
            <select name="to" aria-label="Say to" title="Everyone at the table, or whisper one of them">
                <option value="">Everyone</option>
            </select>
            <input name="text" autocomplete="off" maxlength="500" placeholder="Say something (OOC)" aria-label="Message">
            <button type="submit">Send</button>
            <div class="chat-error" role="alert"></div>
        </form>`;
    document.body.append(panel);

    const list = panel.querySelector('.chat-list');
    const badge = button.querySelector('.roll-badge');
    const form = panel.querySelector('.chat-form');
    const toSelect = form.to;
    const error = panel.querySelector('.chat-error');
    const isOpen = () => !panel.classList.contains('hidden');

    function render() {
        const self = username();
        list.innerHTML = messages.length
            ? messages.map(message => entryHTML(message, self)).join('')
            : '<p class="roll-empty">Nothing said yet. Type below — everyone at the table sees it unless you pick a name to whisper.</p>';
        list.scrollTop = list.scrollHeight;
    }
    function setUnread(n) {
        unread = n;
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.toggle('hidden', n < 1);
    }
    function setOpen(open) {
        panel.classList.toggle('hidden', !open);
        button.setAttribute('aria-expanded', String(open));
        if (open) { setUnread(0); render(); form.text.focus(); }
    }
    function renderRoster() {
        const self = username();
        const wanted = [...new Set(peers.filter(name => name && !sameName(name, self)))].sort((a, b) => a.localeCompare(b));
        const current = toSelect.value;
        toSelect.innerHTML = '<option value="">Everyone</option>' +
            wanted.map(name => `<option value="${escHtml(name)}"${sameName(name, current) ? ' selected' : ''}>${escHtml(name)} (whisper)</option>`).join('');
        if (current && !wanted.some(name => sameName(name, current))) toSelect.value = '';
    }

    button.addEventListener('click', () => setOpen(!isOpen()));
    panel.querySelector('.roll-log-close').addEventListener('click', () => setOpen(false));
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = form.text.value.trim();
        if (!text) return;
        error.textContent = '';
        const to = toSelect.value;
        socket.emit('chat-send', to ? { text, to } : { text });
        form.text.value = '';
    });

    socket.on('chat-log', (data) => {
        messages = Array.isArray(data && data.messages) ? data.messages : [];
        setUnread(0);
        render();
    });
    socket.on('chat-message', (message) => {
        if (!message || messages.some(known => known.id === message.id)) return;
        messages.push(message);
        if (messages.length > 200) messages.splice(0, messages.length - 200);
        if (isOpen()) {
            list.querySelector('.roll-empty')?.remove();
            list.insertAdjacentHTML('beforeend', entryHTML(message, username()));
            list.scrollTop = list.scrollHeight;
        } else {
            setUnread(unread + 1);
        }
    });
    socket.on('chat-denied', (data) => {
        error.textContent = (data && data.error) || 'The message did not go through.';
    });
    socket.on('players-updated', ({ players } = {}) => {
        peers = (Array.isArray(players) ? players : []).map(player => player && player.username).filter(Boolean);
        renderRoster();
    });

    return {
        refresh: () => socket.emit('get-chat'),
        toggle: () => setOpen(!isOpen())
    };
}
