// ui.js — small DOM helpers shared by the GM and player screens.

// Tool buttons open their submenu on a long press (1s) and act on a short press.
export function bindLongPress(button, { onShortPress, onLongPress, holdMs = 1000 }) {
    let timer = null;
    let longPressed = false;
    button.addEventListener('pointerdown', () => {
        longPressed = false;
        timer = setTimeout(() => { longPressed = true; onLongPress(); }, holdMs);
    });
    button.addEventListener('pointerup', () => {
        clearTimeout(timer);
        if (!longPressed) onShortPress();
    });
}

// Close open submenus when clicking anywhere outside them.
// pairs: [[submenuElement, ownerButton], ...]
export function dismissSubmenusOnOutsideClick(pairs) {
    window.addEventListener('pointerdown', (event) => {
        for (const [submenu, button] of pairs) {
            if (submenu.style.display === 'block' &&
                !submenu.contains(event.target) &&
                event.target !== button) {
                submenu.style.display = 'none';
            }
        }
    }, true);
}
