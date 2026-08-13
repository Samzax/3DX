// workspace.js — shared tabletop application shell for GM and player screens.
//
// The game pages still own their mechanics. This module owns the spatial UI
// contract around them: one context inspector, one encounter dock, one top-bar
// status, and an in-app studio overlay for character/homebrew work.

export function createTabletopWorkspace({
    panels = {}, defaultPanel = null, dockVisible = false, onInspectorClose = null,
    shortcuts = []
} = {}) {
    const inspector = document.getElementById('workspace-inspector');
    const inspectorBody = document.getElementById('workspace-inspector-body');
    const inspectorNav = document.getElementById('workspace-inspector-nav');
    const inspectorTitle = document.getElementById('workspace-inspector-title');
    const inspectorKicker = document.querySelector('.workspace-inspector-kicker');
    const inspectorClose = document.getElementById('workspace-inspector-close');
    const dock = document.getElementById('encounter-dock');
    const dockToggle = document.getElementById('workspace-dock-collapse');
    const encounterButton = document.getElementById('btn-workspace-encounter');
    const modeLabel = document.getElementById('workspace-mode');
    const locationLabel = document.getElementById('workspace-location-label');
    const userLabel = document.getElementById('workspace-user');
    const encounterLabel = document.getElementById('workspace-encounter-label');
    const studio = document.getElementById('workspace-studio');
    const studioFrame = document.getElementById('workspace-studio-frame');
    const studioTitle = document.getElementById('workspace-studio-title');
    const studioClose = document.getElementById('workspace-studio-close');
    const helpButton = document.getElementById('btn-workspace-help');

    const panelMap = new Map();
    for (const [id, config] of Object.entries(panels)) {
        const node = document.getElementById(id);
        if (!node) continue;
        if (inspectorBody && node.parentElement !== inspectorBody) inspectorBody.appendChild(node);
        node.classList.add('workspace-panel');
        panelMap.set(id, {
            node,
            title: typeof config === 'string' ? config : config?.title,
            kicker: typeof config === 'object' ? config?.kicker : null
        });
    }

    // The GM's older centered breadcrumb is adopted by the shared top bar.
    const layerNav = document.getElementById('layer-nav');
    const contextSlot = document.querySelector('#workspace-topbar .workspace-context');
    if (layerNav && contextSlot && layerNav.parentElement !== contextSlot) {
        if (locationLabel) locationLabel.remove();
        contextSlot.appendChild(layerNav);
    }

    const playerHud = document.getElementById('player-hud');
    if (playerHud && inspectorNav && playerHud.parentElement !== inspectorNav) inspectorNav.appendChild(playerHud);

    let currentPanel = null;
    let dockIsVisible = false;
    let shortcutDialog = null;

    function setInspectorOpen(open) {
        if (!inspector) return;
        inspector.classList.toggle('is-closed', !open);
        document.body.classList.toggle('workspace-inspector-closed', !open);
        inspector.setAttribute('aria-hidden', String(!open));
        document.querySelectorAll('[data-workspace-open]').forEach(button => {
            button.setAttribute('aria-expanded', String(open && button.dataset.workspaceOpen === currentPanel));
        });
    }

    function showPanel(id, titleOverride, kickerOverride) {
        const entry = panelMap.get(id);
        if (!entry) return;
        currentPanel = id;
        for (const [key, item] of panelMap) item.node.classList.toggle('hidden', key !== id);
        if (inspectorTitle) inspectorTitle.textContent = titleOverride || entry.title || 'Inspector';
        if (inspectorKicker) inspectorKicker.textContent = kickerOverride || entry.kicker || 'Inspector';
        if (inspector) inspector.dataset.panel = id;
        entry.node.classList.remove('workspace-panel-enter');
        // Restart the short panel transition even when returning to a panel
        // that was already mounted inside the inspector.
        void entry.node.offsetWidth;
        entry.node.classList.add('workspace-panel-enter');
        setInspectorOpen(true);
    }

    function closeInspector() {
        setInspectorOpen(false);
        if (typeof onInspectorClose === 'function') onInspectorClose();
    }

    function setDockExpanded(expanded) {
        if (!dock) return;
        dock.classList.toggle('is-collapsed', !expanded);
        document.body.classList.toggle('workspace-encounter-open', dockIsVisible && expanded);
        if (dockToggle) {
            dockToggle.setAttribute('aria-expanded', String(expanded));
            dockToggle.textContent = expanded ? 'Hide' : 'Show';
        }
        if (encounterButton) encounterButton.setAttribute('aria-expanded', String(expanded));
    }

    function toggleDock() {
        if (!dockIsVisible) return;
        setDockExpanded(dock.classList.contains('is-collapsed'));
    }

    function setDockVisible(visible, { expand = false } = {}) {
        dockIsVisible = !!visible;
        if (dock) dock.classList.toggle('hidden', !dockIsVisible);
        if (encounterButton) encounterButton.classList.toggle('hidden', !dockIsVisible);
        if (!dockIsVisible) document.body.classList.remove('workspace-encounter-open');
        else setDockExpanded(expand || !dock.classList.contains('is-collapsed'));
    }

    function setEncounterStatus(text, active = false, urgent = false) {
        if (encounterLabel) encounterLabel.textContent = text || 'Encounter';
        if (encounterButton) encounterButton.classList.toggle('is-active', !!active);
        if (encounterButton) encounterButton.classList.toggle('is-your-turn', !!urgent);
        if (dock) dock.classList.toggle('is-active', !!active);
        if (dock) dock.classList.toggle('is-your-turn', !!urgent);
    }

    function setMode(text) {
        if (modeLabel) modeLabel.textContent = text || 'Explore';
    }

    function setLocation(text) {
        if (locationLabel) locationLabel.textContent = text || 'World';
    }

    function setUser(text) {
        if (userLabel) userLabel.textContent = text || '';
    }

    function openStudio(path = '/', title = 'Character Studio') {
        if (!studio || !studioFrame) return;
        if (studioTitle) studioTitle.textContent = title;
        const next = new URL(path, window.location.origin).href;
        if (studioFrame.src !== next) studioFrame.src = next;
        studio.classList.remove('hidden');
        studio.setAttribute('aria-hidden', 'false');
    }

    function closeStudio() {
        if (!studio) return;
        studio.classList.add('hidden');
        studio.setAttribute('aria-hidden', 'true');
    }

    function buildShortcutDialog() {
        if (shortcutDialog || !shortcuts.length) return shortcutDialog;
        shortcutDialog = document.createElement('div');
        shortcutDialog.id = 'workspace-shortcuts';
        shortcutDialog.className = 'hidden';
        shortcutDialog.setAttribute('aria-hidden', 'true');

        const card = document.createElement('section');
        card.className = 'workspace-shortcuts-card';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', 'workspace-shortcuts-title');
        const header = document.createElement('header');
        const title = document.createElement('div');
        title.id = 'workspace-shortcuts-title';
        title.textContent = 'Keyboard shortcuts';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'workspace-shortcuts-close';
        close.setAttribute('aria-label', 'Close keyboard shortcuts');
        close.textContent = '×';
        close.addEventListener('click', closeShortcuts);
        header.append(title, close);

        const list = document.createElement('div');
        list.className = 'workspace-shortcuts-list';
        shortcuts.forEach(item => {
            const row = document.createElement('div');
            const key = document.createElement('kbd');
            key.textContent = item.key;
            const label = document.createElement('span');
            label.textContent = item.label;
            row.append(key, label);
            list.appendChild(row);
        });
        card.append(header, list);
        shortcutDialog.appendChild(card);
        shortcutDialog.addEventListener('pointerdown', event => {
            if (event.target === shortcutDialog) closeShortcuts();
        });
        document.body.appendChild(shortcutDialog);
        return shortcutDialog;
    }

    function openShortcuts() {
        const dialog = buildShortcutDialog();
        if (!dialog) return;
        dialog.classList.remove('hidden');
        dialog.setAttribute('aria-hidden', 'false');
        dialog.querySelector('.workspace-shortcuts-close')?.focus();
    }

    function closeShortcuts() {
        if (!shortcutDialog) return;
        shortcutDialog.classList.add('hidden');
        shortcutDialog.setAttribute('aria-hidden', 'true');
    }

    function toggleShortcuts() {
        if (!shortcutDialog || shortcutDialog.classList.contains('hidden')) openShortcuts();
        else closeShortcuts();
    }

    if (inspectorClose) inspectorClose.addEventListener('click', closeInspector);
    if (dockToggle) dockToggle.addEventListener('click', toggleDock);
    if (encounterButton) encounterButton.addEventListener('click', toggleDock);
    if (studioClose) studioClose.addEventListener('click', closeStudio);
    if (helpButton) helpButton.addEventListener('click', toggleShortcuts);

    // Delegation keeps dynamically rendered empty states and character cards
    // connected to the same shell without page-specific wiring.
    document.addEventListener('click', event => {
        const open = event.target.closest('[data-workspace-open]');
        if (open) showPanel(open.dataset.workspaceOpen, open.dataset.workspaceTitle);

        const studioTrigger = event.target.closest('[data-workspace-studio]');
        if (studioTrigger) {
            event.preventDefault();
            openStudio(studioTrigger.dataset.workspaceStudio || '/', studioTrigger.dataset.workspaceStudioTitle || 'Character Studio');
        }
    });

    window.addEventListener('keydown', event => {
        const tag = event.target && event.target.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;
        if (!typing && event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggleShortcuts();
            return;
        }
        if (event.key !== 'Escape') return;
        if (studio && !studio.classList.contains('hidden')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeStudio();
            return;
        }
        if (shortcutDialog && !shortcutDialog.classList.contains('hidden')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closeShortcuts();
        }
    }, true);

    if (defaultPanel && panelMap.has(defaultPanel)) showPanel(defaultPanel);
    else setInspectorOpen(false);
    setDockVisible(dockVisible, { expand: false });

    return {
        showPanel,
        closeInspector,
        openInspector: () => setInspectorOpen(true),
        isInspectorOpen: () => !!inspector && !inspector.classList.contains('is-closed'),
        currentPanel: () => currentPanel,
        setDockVisible,
        setDockExpanded,
        toggleDock,
        setEncounterStatus,
        setMode,
        setLocation,
        setUser,
        openStudio,
        closeStudio,
        openShortcuts,
        closeShortcuts,
        toggleShortcuts,
        setInspectorKicker: text => { if (inspectorKicker) inspectorKicker.textContent = text || 'Inspector'; }
    };
}
