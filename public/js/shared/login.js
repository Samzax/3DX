// login.js — the username modal shared by the player screen, character creator
// and homebrew pages. (The GM screen auto-logs-in as 'GM' and skips this.)
// connect(username) is called on submit; the page hides the overlay itself once
// the server confirms ('login-success') and can reset() the button on error.

export function setupLoginModal(connect) {
    const overlay = document.getElementById('login-overlay');
    const input = document.getElementById('username-input');
    const button = document.getElementById('login-btn');
    const error = document.getElementById('login-error');

    function showError(message) {
        if (!error) return;
        error.textContent = message;
        error.classList.remove('hidden');
        setTimeout(() => error.classList.add('hidden'), 3000);
    }

    function submit() {
        const username = input.value.trim();
        if (!username || username.length < 2) {
            showError('Username must be at least 2 characters');
            return;
        }
        button.disabled = true;
        button.textContent = 'Connecting…';
        connect(username);
    }

    button.addEventListener('click', submit);
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') submit(); });

    // Auto-login if a username is already stored for this tab's session.
    const stored = sessionStorage.getItem('vtt_username');
    if (stored) {
        input.value = stored;
        submit();
    }

    return {
        showError,
        hide: () => overlay.classList.add('hidden'),
        reset: () => { button.disabled = false; button.textContent = 'Login'; }
    };
}
