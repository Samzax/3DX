// login.js — the account login modal shared by every screen (lobby, creator,
// homebrew, gm, player). It owns the form inside #login-modal and the stored
// session; pages own their socket.
//
//   const login = setupLoginModal(() => { socket = io(); login.attach(socket); ... });
//   socket.on('connect', () => socket.emit('login', login.payload({ campaignId, screen })));
//
// connect() runs once, as soon as there is something to log in with (a stored
// session or a submitted form). attach() stores the session on 'login-success'
// and reopens the form on 'login-failed'; later submits re-emit 'login' on the
// attached socket. Passwords are never stored — only the server's session token.

const TOKEN_KEY = 'vtt_token';
const USER_KEY = 'vtt_username';

function readStored(key) {
    try { return sessionStorage.getItem(key) || localStorage.getItem(key); }
    catch (_) { return null; }
}

function clearStored() {
    for (const store of [sessionStorage, localStorage]) {
        try { store.removeItem(TOKEN_KEY); store.removeItem(USER_KEY); } catch (_) { /* storage blocked */ }
    }
}

// Session identity for pages that need the name before the server answers.
export function storedUsername() {
    return readStored(USER_KEY);
}

export function logout() {
    clearStored();
    window.location.href = '/';
}

export function setupLoginModal(connect) {
    const overlay = document.getElementById('login-overlay');
    const modal = document.getElementById('login-modal');
    const title = modal.querySelector('h2');
    const input = document.getElementById('username-input');
    const button = document.getElementById('login-btn');
    const error = document.getElementById('login-error');

    // The shells only carry the username field; the rest of the form is built
    // here so all five screens stay identical.
    function addField(id, type, placeholder, autocomplete) {
        const field = document.createElement('input');
        field.id = id;
        field.type = type;
        field.placeholder = placeholder;
        field.autocomplete = autocomplete;
        field.maxLength = 200;
        modal.insertBefore(field, button);
        return field;
    }
    input.placeholder = 'Username';
    const password = addField('password-input', 'password', 'Password', 'current-password');
    const confirm = addField('password-confirm-input', 'password', 'Repeat password', 'new-password');
    const rememberRow = document.createElement('label');
    rememberRow.className = 'login-remember';
    rememberRow.innerHTML = '<input type="checkbox" id="login-remember" /> <span>Stay signed in on this device</span>';
    modal.insertBefore(rememberRow, button);
    const remember = rememberRow.querySelector('input');
    const note = document.createElement('p');
    note.className = 'login-note hidden';
    modal.insertBefore(note, input);

    let mode = 'password';      // 'password' | 'open' | 'setup' | 'blocked'
    let credentials = null;     // what the next 'login' emit carries
    let extra = {};             // the page's campaignId/screen
    let socket = null;
    let started = false;
    let errorTimer = null;

    function showError(message) {
        if (!error) return;
        error.textContent = message;
        error.classList.remove('hidden');
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => error.classList.add('hidden'), 5000);
    }

    function reset() {
        button.disabled = mode === 'blocked';
        button.textContent = mode === 'setup' ? 'Create host account' : 'Login';
    }

    function applyMode(next) {
        mode = next;
        const setup = mode === 'setup';
        password.classList.toggle('hidden', mode === 'open' || mode === 'blocked');
        confirm.classList.toggle('hidden', !setup);
        rememberRow.classList.toggle('hidden', mode === 'blocked');
        input.classList.toggle('hidden', mode === 'blocked');
        password.autocomplete = setup ? 'new-password' : 'current-password';
        note.classList.toggle('hidden', !setup && mode !== 'blocked');
        if (setup) {
            note.textContent = 'First run: create the host account. The host adds every other ' +
                'player and approves new campaigns. Passwords cannot be changed later, so keep it safe.';
        } else if (mode === 'blocked') {
            note.textContent = 'This server has not been set up yet. The host must open it on ' +
                'the host computer first to create the host account.';
        }
        if (title && setup) title.textContent = 'Welcome — set up 3DX';
        reset();
    }

    function showForm() {
        overlay.classList.remove('hidden');
        fetch('/auth/status', { cache: 'no-store' })
            .then(response => response.json())
            .then(status => applyMode(status.open ? 'open'
                : status.setup === 'here' ? 'setup'
                : status.setup === 'elsewhere' ? 'blocked' : 'password'))
            .catch(() => applyMode('password'));
    }

    function send() {
        if (!started) { started = true; connect(); return; }
        if (socket && socket.connected) socket.emit('login', { ...credentials, ...extra });
        // Otherwise the page's 'connect' handler sends it once the socket is up
        // (a session the host ended leaves the socket closed: reopen it).
        else if (socket) socket.connect();
    }

    function submit() {
        if (mode === 'blocked') return;
        const username = input.value.trim();
        if (username.length < 2) { showError('Username must be at least 2 characters'); return; }
        if (mode !== 'open' && !password.value) { showError('Enter your password'); return; }
        if (mode === 'setup' && password.value !== confirm.value) {
            showError('The two passwords do not match');
            return;
        }
        credentials = { username, password: password.value, setup: mode === 'setup' || undefined };
        button.disabled = true;
        button.textContent = 'Connecting…';
        send();
    }

    button.addEventListener('click', submit);
    for (const field of [input, password, confirm]) {
        field.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
    }

    // Resume a stored session without showing the form.
    const storedToken = readStored(TOKEN_KEY);
    if (storedToken) {
        credentials = { token: storedToken };
        button.disabled = true;
        button.textContent = 'Connecting…';
        // Deferred: connect() uses the object this function is about to return.
        queueMicrotask(send);
    } else {
        showForm();
    }

    return {
        showError,
        reset,
        hide: () => overlay.classList.add('hidden'),
        // The 'login' payload for this page; call it from the socket's 'connect'.
        payload(pageExtra = {}) {
            extra = pageExtra;
            return { ...credentials, ...extra };
        },
        attach(pageSocket) {
            socket = pageSocket;
            socket.on('login-success', (data) => {
                let keep = remember.checked;
                try { keep = keep || !!localStorage.getItem(TOKEN_KEY); } catch (_) { /* storage blocked */ }
                for (const store of keep ? [sessionStorage, localStorage] : [sessionStorage]) {
                    try {
                        store.setItem(TOKEN_KEY, data.token);
                        store.setItem(USER_KEY, data.username);
                    } catch (_) { /* storage blocked: the session lasts until reload */ }
                }
                credentials = { token: data.token };
                password.value = '';
                confirm.value = '';
                overlay.classList.add('hidden');
            });
            socket.on('login-failed', (data) => {
                clearStored();
                credentials = null;
                showForm();
                showError((data && data.error) || 'Login failed');
            });
        }
    };
}
