// player.js — player screen (/player): shared-map view (GM-authored terrain is
// view-only), token moving, rulers, and the character-sheet HUD (Character /
// Inventory / Spells / Actions panels). Scene boilerplate, meshes and the ruler
// tool live in ../shared/.

import * as THREE from 'three';
import { loadSRD, ABILITIES, abilityMod, fmtMod, proficiencyBonus } from '../shared/srd.js';
import { loadMonsterModels } from '../shared/monster-models.js';
import { queueCombatFx, syncMonsterStances, tickMonsterAnimations } from '../shared/monster-anim.js';
import { createCombatAim, createZoneLayer } from '../shared/aiming.js';
import { Terrain } from '../shared/terrain.js';
import { Grass } from '../shared/grass.js';
import { Trees } from '../shared/trees.js';
import { GroundCover } from '../shared/groundcover.js';
import { watchClearings } from '../shared/scatter.js';
import { createTabletopScene, startRenderLoop, castFromPointer, snapToGrid, trackRightDrag, isCameraClick, styleGroundForTerrain, setGroundCut, buildBoundsRect, updateWorldFollow, setWorldOriginAt, maybeRebaseWorld, CameraFly, FOG_NEAR, FOG_FAR, GRID_CELL_SIZE, FEET_PER_GRID_CELL } from '../shared/scene.js';
import { buildObjectFromData, applyMove } from '../shared/models.js';
import { syncCharacterStances, tickRigCharacters } from '../shared/charmesh.js';
import { configureGrounding, tickGrounding } from '../shared/grounding.js';
import { pathCost, describeCost, normalizeMovement, MOVE_RULES } from '../shared/ground.js';
import { RulerTool } from '../shared/rulers.js';
import { bindLongPress, dismissSubmenusOnOutsideClick } from '../shared/ui.js';
import { attachTouchInput, createTouchBar, touchHint } from '../shared/touch.js';
import { setupLoginModal, storedUsername } from '../shared/login.js';
import {
    AbilityTargeting, CombatTracker, CombatOverlays, attackAvailable, attackPayloadOptions,
    combatAbilityButtonsHTML, combatAttackDamageLabel, combatOptionsHTML, deriveCombatStats,
    moveModesOf, remainingFeet, toggleAttackOption, EFFECTS, spellRounds, spellArea, aimShapeOf, spellForm, spellLight, spellSummon
} from '../shared/combat.js';
import { buildSheet, weaponProfile } from '../shared/rules.js';
import { combatInteger, combatModifier, combatSpellLevel } from '../shared/combat-safety.js';
import { FogMask, FogOverlay, chunkFogHexKey } from '../shared/fog.js';
import { createTabletopWorkspace } from '../shared/workspace.js';
import { ObjectNameplates, objectIdentity, setObjectSelected, updateObjectPresentation, updateObjectPositionData, revertUncommittedMove } from '../shared/object-ui.js';
import { disposeBuiltObject, structureLevel, structureStoreyLevel, structureTouchesLevel, isStructureType } from '../shared/structures.js';
import { AuthenticatedMapReload } from '../shared/sync-state.js';
import { TIER_WIDTH } from '../shared/hexworld.js';
import { readCampaignId, readPlayingIds } from '../shared/campaigns.js';
import { createAtmosphere } from '../shared/atmosphere.js';
import { createSkyChip } from '../shared/skypanel.js';
import { nearestDoor, normalizeSenses } from '../shared/vision.js';
import { buildBarriers, walkable, PROP_POSES } from '../shared/passage.js';
import { createRollLog } from '../shared/rolllog.js';
import { createChat } from '../shared/chat.js';
import { createReferencePanel } from '../shared/reference.js';
import { createRestDesk } from '../shared/rests.js';
import { createCastDesk } from '../shared/castdesk.js';
import { spellDetailHTML, spellCastRequest, spellMechanics, spellLevelLabel } from '../shared/spellinfo.js';
import { createVisionFx, describeSenses } from '../shared/visionfx.js';
import { createVisionChip } from '../shared/visionpanel.js';

// Tabletop screens always enter through the lobby with ?campaign=<id>.
// &chars=id1,id2 (set by the lobby picker) narrows the HUD to those characters.
const campaignId = readCampaignId();
if (!campaignId) location.replace('/lobby');
const playingIds = readPlayingIds() || []; // null = no `?chars=` narrowing

// ?chars (entry picker) narrows the session to these characters; a link
// without it plays the whole roster.
function inPlayingParty(char) {
    return !playingIds.length || playingIds.includes(char.id);
}

// Campaign context (campaign-joined + map-state stamps). Module scope: the
// camera landing reads it whenever a map-state arrives.
let campaignContext = null;
let pendingSpawnLanding = false;   // first unified landing after (re)join uses settings.spawn
// Journal snapshot from the server (party-visible entries only) + treasury + XP.
let journalState = { entries: [], treasury: {}, xp: { mode: 'milestone', awards: [] } };
let journalQuery = '';                  // filter box above the notes (player.html)

// Adopt campaign settings: seed + world shape drive local generation (reset
// picks them up automatically; without a reset, regenerate live ground only).
function applyCampaignContext(campaign) {
    campaignContext = campaign;
    const settings = campaign.settings || {};
    if (terrain && terrain.applyWorldSettings(settings) && terrainIsUnified) {
        terrain.regenerate();
        if (fogOverlay) fogOverlay.setAltitude(terrain.fogAltitude);
    }
    if (atmosphere) { atmosphere.setSeed(settings.seed); atmosphere.setSky(settings.sky); }
}

// --- Campaign hall: the briefing card over the live world (#campaign-hall).
// Open on first entry and whenever the GM closes the table; a refresh while
// the table is open skips it (sessionStorage), so reconnects cost nothing.
const HALL_RADIUS = 95, HALL_HEIGHT = 55, HALL_TURN = 0.05; // orbit: units, rad/s
const hall = { open: true, waiting: false, decided: false, entered: false, returnPose: null, at: 0 };
let hallRoster = [];               // players-updated presence roster
const hallSeenKey = () => `3dx-hall:${campaignId}`;
const hallSeen = () => { try { return sessionStorage.getItem(hallSeenKey()) === '1'; } catch (e) { return false; } };
const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

// The campaign's GM (and the host) are never held at a closed table.
function runsTable() {
    return isHostUser || !!(campaignContext && myUsername && sameName(campaignContext.owner, myUsername));
}

function renderHall() {
    const el = document.getElementById('campaign-hall');
    if (!el || !campaignContext) return;
    const text = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
    const premise = campaignContext.description || '', recap = campaignContext.recap || '';
    text('hall-kicker', campaignContext.owner ? `A campaign run by ${campaignContext.owner}` : 'Campaign');
    text('hall-title', campaignContext.name || 'Campaign');
    text('hall-premise', premise);
    text('hall-recap', recap);
    document.getElementById('hall-premise').classList.toggle('hidden', !premise);
    document.getElementById('hall-recap-block').classList.toggle('hidden', !recap);
    // Session history: everything older than the newest recap (that one is
    // already "Last time"), newest first.
    const history = (Array.isArray(campaignContext.sessions) ? campaignContext.sessions : []).slice(1);
    const sessionsBlock = document.getElementById('hall-sessions-block');
    const sessionsBox = document.getElementById('hall-sessions');
    if (sessionsBlock && sessionsBox) {
        sessionsBlock.classList.toggle('hidden', !history.length);
        sessionsBox.innerHTML = history.map(entry => {
            const date = entry.at ? new Date(entry.at).toLocaleDateString() : '';
            return `<details class="hall-session"><summary>Session ${escHtml(entry.n)}${date ? ` · ${escHtml(date)}` : ''}</summary><p>${escHtml(entry.text)}</p></details>`;
        }).join('');
    }
    const seen = new Set();
    document.getElementById('hall-roster').innerHTML = hallRoster
        .filter(p => p && p.username && !seen.has(p.username) && seen.add(p.username))
        .sort((a, b) => (b.isGM ? 1 : 0) - (a.isGM ? 1 : 0))
        .map(p => `<span class="${p.isGM ? 'gm' : ''}">${escHtml(p.username)}${p.isGM ? ' · GM' : ''}</span>`)
        .join('') || '<span>Just you so far</span>';
    text('hall-party', myCharacters.length
        ? myCharacters.map(c => c.name || 'Unnamed').join(', ')
        : 'No character yet — make one in the Studio');
    const button = document.getElementById('hall-enter');
    button.disabled = hall.waiting;
    button.textContent = hall.waiting ? 'The table is closed'
        : (hall.entered ? 'Return to the table' : 'Enter the world');
    text('hall-status', hall.waiting
        ? 'Waiting for the GM to open the table — you will be brought in together.'
        : '');
}

function openHall() {
    if (hall.open) return;
    hall.open = true;
    // Remember where the player was looking so leaving the hall returns there.
    if (terrain && camera && controls && hall.entered) {
        const o = terrain.worldOrigin, p = camera.position, t = controls.target;
        hall.returnPose = {
            pos: { x: p.x + o.x, y: p.y, z: p.z + o.z },
            look: { x: t.x + o.x, y: t.y, z: t.z + o.z }
        };
    }
    if (cameraFly) cameraFly.cancel();
    if (workspace) workspace.closeInspector();
    document.body.classList.add('hall-open');
    const el = document.getElementById('campaign-hall');
    if (el) el.classList.remove('hidden');
}

// Leave the hall: fly from the orbit down to the play camera (or back to
// where the player was when the hall reopened mid-session).
function enterWorld(fly = true) {
    if (!hall.open) return;
    hall.open = false;
    hall.waiting = false;
    hall.entered = true;
    try { sessionStorage.setItem(hallSeenKey(), '1'); } catch (e) { /* private mode */ }
    document.body.classList.remove('hall-open');
    const el = document.getElementById('campaign-hall');
    if (el) el.classList.add('hidden');
    if (fly && terrain && terrainIsUnified && cameraFly) {
        const o = terrain.worldOrigin, p = camera.position, t = controls.target;
        const dx = p.x - t.x, dz = p.z - t.z, k = 28.3 / (Math.hypot(dx, dz) || 1);
        cameraFly.start(hall.returnPose || {
            pos: { x: t.x + o.x + dx * k, y: t.y + 30, z: t.z + o.z + dz * k },
            look: { x: t.x + o.x, y: t.y, z: t.z + o.z }
        }, o, 1.8);
    }
    hall.returnPose = null;
}

// Reconcile the hall with the campaign's table state (join, GM update).
function syncHall() {
    if (!campaignContext) return;
    const held = campaignContext.session === 'closed' && !runsTable();
    if (held) {
        hall.waiting = true;
        openHall();
    } else if (hall.waiting) {
        hall.waiting = false;
        if (hall.open) enterWorld();          // the GM just opened the table
    } else if (!hall.decided && hallSeen()) {
        hall.entered = true;
        enterWorld(false);                    // refresh/reconnect: straight back in
    }
    hall.decided = true;
    renderHall();
}

// Slow orbit around the landing point while the hall is up (runs after the
// GM-flight tick, never during one), easing out to a wide establishing shot.
function orbitHall() {
    const now = performance.now(), dt = Math.min(0.1, (now - hall.at) / 1000);
    hall.at = now;
    if (!hall.open || !terrain || !terrainIsUnified || (cameraFly && cameraFly.active)) return;
    const t = controls.target, p = camera.position, o = terrain.worldOrigin;
    const dx = p.x - t.x, dz = p.z - t.z, r = Math.hypot(dx, dz) || 1;
    const angle = Math.atan2(dz, dx) + HALL_TURN * dt, ease = Math.min(1, dt * 1.5);
    const radius = r + (HALL_RADIUS - r) * ease;
    const x = t.x + Math.cos(angle) * radius, z = t.z + Math.sin(angle) * radius;
    const floor = terrain.sampleHeight(x + o.x, z + o.z) + 12; // stay out of hillsides
    p.set(x, Math.max(floor, p.y + (t.y + HALL_HEIGHT - p.y) * ease), z);
}

// Region-style campaigns lock navigation to one province lens (the server
// enforces the same rule); the camera zoom-out stops at that lens too.
function regionRoot() {
    const settings = campaignContext && campaignContext.settings;
    return settings && settings.mapStyle === 'region' && settings.regionKey
        ? settings.regionKey : null;
}

let terrain = null; // tactical terrain (heightmap + water), GM-authored, view-only here
let grass = null;   // instanced ground-cover grass (shared/grass.js)
let trees = null;   // procedural low-poly trees (shared/trees.js)
let groundCover = null;             // flowers/ferns/reeds/tufts/pebbles (shared/groundcover.js)
let atmosphere = null, skyChip = null, skyTickAt = 0; // sky + weather (shared/atmosphere.js)
let visionFx = null, visionChip = null;              // token vision (shared/visionfx.js)

// --- Character sheet state ---
let SRD = null;
let pendingHomebrew = null;
let myCharacters = [];
let activeCharId = null;
const hpState = {}; // charId -> current HP (mirrors the server, kept in sync)
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup;
let ruler;
let objects = [];
let selectedObject = null;

let socket = null; // created on login
let myUsername = null;
let isHostUser = false;      // the host account sees every sheet
let workspace = null;
let objectNameplates = null;
let selectionReturnContext = null;
let selectionOwnsInspector = false;

// --- Combat mode (server-authoritative, synced via combat-updated) ---
let combatState = null;
let combatTracker = null;
let pendingAttack = null;       // { combatantId, attackIndex } while picking a target
let pendingSpell = null;        // { combatantId, spellIndex } while picking a target
// Feature abilities (breath weapons, ki moves…) collect one or more targets.
const abilityTargeting = new AbilityTargeting({
    getSocket: () => socket,
    flash: (text) => { if (combatTracker) combatTracker.flash(text); },
    onChange: () => updatePlayerHintBar()
});
let rollLog = null;             // table log + roll requests (shared/rolllog.js), created with the socket
let chat = null;                // OOC table chat + whispers (shared/chat.js)
let reference = null;           // SRD browser overlay (shared/reference.js)
const openSpells = new Set();   // spell cards left open in the Spells panel
let restDesk = null;            // spent slots/pools + rest requests (shared/rests.js)
let castDesk = null;            // casting outside a fight: aim, ask the GM (shared/castdesk.js)
let dragStartPos = null;        // selected token's world position when the move began
let carryBlocked = false;       // the cursor is somewhere the carried token cannot walk to
let combatOverlays = null;      // turn/range rings + effect badges (created in init)
let combatAim = null;           // the area template a spell or breath is aimed with (shared/aiming.js)
let zoneLayer = null;           // areas that linger in a fight, drawn on the ground (shared/aiming.js)
let owedSaves = 0;              // saving throws waiting on this player
let closeAllPanels = () => {};  // assigned in init (needs the HUD overlay refs)
let showCharacterPanel = () => {}; // assigned in init; shared by cards + tabs

let currentTool = null;
let currentMoveMode = 'standard';
let toolMenuButtons = {};
let moveSubMenuButtons = {};
let moveSubMenu;
let isDraggingHeight = false;

let placeCharacter = null; // character being placed (place tool armed via the right menu)
let characterInstances = []; // my placed tokens across all maps (Instances tab), server-pushed
let partyMembers = [];       // campaign roster: identity only (Party tab)
let pendingFocus = null;     // world position to jump to once the next map-state lands
let seekOwnToken = false;    // first entry: land where the player's character stands
let pendingViewPose = null;  // GM-directed camera pose to apply after a relocate join

let rulerSubMenu, rulerSubMenuButtons = {};
let rulerSnapSubMenuButtons = {};
let wasRightDrag = null; // right-drag orbits the camera; see trackRightDrag
let boundsRect = null;   // pocket-map boundary rectangle
let currentMapKey = 'world'; // players travel between maps via portals
let terrainIsUnified = false; // is the loaded terrain the shared continuous world?
const mapReload = new AuthenticatedMapReload();
let hexTree = {};            // GM biome tags (generator overrides), synced via map-state
let regenTimer = null;       // debounce for biome-driven regeneration
// Fog of war (U4): the server only sends content inside GM-revealed regions;
// the mask mirrors the server and the overlay darkens everything outside it.
const fogMask = new FogMask();
let fogOverlay = null;       // created in init
// GM-directed camera (View control): the GM can fly/snap this view to a pose
// and optionally lock the controls until released.
let cameraFly = null;        // created in init
let touchInput = null;       // shared/touch.js: fingers on the map
let touchBar = null;         // ...and the buttons that stand in for Enter / Esc

// Local multi-storey cutaway. It never changes shared map state: each player
// may inspect the floor relevant to their token without changing anyone else.
const levelView = { active: 0, isolate: false };
let levelCutawayState = null;

const emitRuler = (data) => { if (socket) socket.emit('add-ruler', data); };

function init() {
    workspace = createTabletopWorkspace({
        panels: {
            'character-menu': { title: 'Characters', kicker: 'Your roster' },
            'selection-panel': { title: 'Selection', kicker: 'Map object' },
            'hud-panel-overlay': { title: 'Character', kicker: 'Character' }
        },
        defaultPanel: 'character-menu',
        dockVisible: false,
        onInspectorClose: () => {
            if (selectionOwnsInspector && ['selection-panel', 'hud-panel-overlay'].includes(workspace?.currentPanel())) {
                selectionReturnContext = null;
                selectionOwnsInspector = false;
            }
            if (workspace) workspace.setMode({ select: 'Select', move: 'Move', ruler: 'Measure', place: 'Place' }[currentTool] || 'Explore');
        },
        shortcuts: [
            { key: 'S', label: 'Select: click a token to inspect it without moving it' },
            { key: 'M', label: 'Move your selected character' },
            { key: 'R', label: 'Measure distance' },
            { key: 'C', label: 'Open your character library' },
            { key: 'A', label: 'Open character actions' },
            { key: 'E', label: 'Show or hide the encounter dock' },
            { key: '.', label: 'Focus the selected token' },
            { key: 'Esc', label: 'Cancel placement, targeting or selection' },
            { key: '?', label: 'Show this shortcut reference' }
        ]
    });

    ({ scene, camera, renderer, controls, plane, grid, raycaster, mouse, dirLight, worldGroup } =
        createTabletopScene(document.getElementById('scene-container')));
    objectNameplates = new ObjectNameplates();

    // Tactical terrain (GM-authored heightmap + water); hidden until a terrain arrives.
    terrain = new Terrain();
    // Figures settle onto the ground they stand on wherever the terrain is shown.
    configureGrounding({
        probe: (x, z) => (terrain.group.visible ? terrain.sampleHeight(x, z) : null),
        focus: () => ({ x: controls.target.x + terrain.worldOrigin.x, z: controls.target.z + terrain.worldOrigin.z })
    });
    terrain.group.visible = false;
    scene.add(terrain.group);
    grass = new Grass(terrain, scene);   // ground-cover, shown only at tactical zoom
    trees = new Trees(terrain, scene);   // biome-scattered low-poly trees
    groundCover = new GroundCover(terrain, scene); // close-up biome detail
    watchClearings(terrain, () => objects);   // buildings clear the vegetation they stand on
    atmosphere = createAtmosphere({ scene, camera, renderer, dirLight }); // day/night + weather
    skyChip = createSkyChip();

    // Token vision: the screen shows what the character being played can see.
    visionFx = createVisionFx({
        renderer, scene, camera,
        source: {
            objects: () => objects,
            origin: () => terrain.worldOrigin,
            settings: () => campaignContext && campaignContext.settings && campaignContext.settings.vision,
            viewer: visionViewer,
            sky: () => ({
                hour: atmosphere.info.hour,
                weather: terrainIsUnified ? atmosphere.info.weather : null,
                pocket: !terrainIsUnified
            }),
            keepVisible: playerOwnsObject,
            memoryKey: (object) => `3dx-seen:${campaignId}:${object.userData.characterData?.id || 'token'}:${terrainIsUnified ? 'world' : currentMapKey}`,
            cameraDistance: () => camera.position.distanceTo(controls.target)
        }
    });
    visionChip = createVisionChip({
        onLight: (light) => {
            const viewer = visionViewer();
            if (viewer && socket) socket.emit('set-vision', { id: viewer.userData.syncId, light });
        }
    });

    ruler = new RulerTool({
        scene: worldGroup, // ruler points/segments are world coords
        tooltip: document.getElementById('ruler-tooltip')
    });

    combatOverlays = new CombatOverlays({
        worldGroup,
        findMesh: findObjectMesh,
        feetToWorld: ft => (ft / FEET_PER_GRID_CELL) * GRID_CELL_SIZE
    });
    zoneLayer = createZoneLayer({ worldGroup, objects: () => objects, terrain: () => terrain });
    combatAim = createCombatAim({
        worldGroup, objects: () => objects, terrain: () => terrain, getSocket: () => socket,
        flash: (text) => { if (combatTracker) combatTracker.flash(text); },
        onChange: () => updatePlayerHintBar()
    });

    // Fog sheet over unrevealed regions (world coords; hidden until a unified
    // map-state arrives — pockets are never fogged).
    fogOverlay = new FogOverlay(worldGroup, { opacity: 0.94 });
    fogOverlay.setVisible(false);

    cameraFly = new CameraFly(camera, controls);
    // The player's own camera input wins over an UNLOCKED GM flight (otherwise
    // wheel/orbit compose with the fly and fight it). Locked views disable
    // controls, so these can't break a lock.
    renderer.domElement.addEventListener('wheel', () => { if (controls.enabled) cameraFly.cancel(); }, { passive: true });
    renderer.domElement.addEventListener('pointerdown', (e) => { if ((e.button !== 0 || isCameraClick(e)) && controls.enabled) cameraFly.cancel(); });

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('contextmenu', onContextMenu);
    renderer.domElement.addEventListener('dblclick', onDoubleClick); // portal travel
    window.addEventListener('keydown', onKeyDown);
    wasRightDrag = trackRightDrag(renderer.domElement);
    touchBar = createTouchBar({ after: updatePlayerHintBar });
    touchInput = attachTouchInput({
        surface: document.getElementById('scene-container'), camera, controls,
        handlers: {
            tap: touchTap, claim: touchClaim,
            hold: (ev) => { onContextMenu(ev); updatePlayerHintBar(); },
            doubleTap: (ev) => { onDoubleClick(ev); updatePlayerHintBar(); },
            camera: () => cameraFly.cancel(), // like the wheel: the player's own camera wins over an unlocked flight
            mode: updatePlayerHintBar
        }
    });

    // --- Tool Menu Listeners (Left) ---
    toolMenuButtons.select = document.getElementById('btn-tool-select');
    toolMenuButtons.move = document.getElementById('btn-tool-move');
    toolMenuButtons.ruler = document.getElementById('btn-tool-ruler');
    toolMenuButtons.select.addEventListener('click', () => setTool('select'));
    moveSubMenu = document.getElementById('move-submenu');
    moveSubMenuButtons.standard = document.getElementById('btn-move-standard');
    moveSubMenuButtons.x = document.getElementById('btn-move-x');
    moveSubMenuButtons.z = document.getElementById('btn-move-z');
    moveSubMenuButtons.y = document.getElementById('btn-move-y');

    bindLongPress(toolMenuButtons.move, {
        onShortPress: () => setMoveMode('standard'),
        onLongPress: () => { moveSubMenu.style.display = 'block'; }
    });
    moveSubMenuButtons.standard.addEventListener('click', () => setMoveMode('standard'));
    moveSubMenuButtons.x.addEventListener('click', () => setMoveMode('x-only'));
    moveSubMenuButtons.z.addEventListener('click', () => setMoveMode('z-only'));
    moveSubMenuButtons.y.addEventListener('click', () => setMoveMode('y-only'));

    rulerSubMenu = document.getElementById('ruler-submenu');
    rulerSubMenuButtons.straight = document.getElementById('btn-ruler-straight');
    rulerSubMenuButtons.curved = document.getElementById('btn-ruler-curved');

    bindLongPress(toolMenuButtons.ruler, {
        onShortPress: () => setRulerMode(ruler.mode),
        onLongPress: () => { rulerSubMenu.style.display = 'block'; }
    });
    rulerSubMenuButtons.straight.addEventListener('click', () => setRulerMode('straight'));
    rulerSubMenuButtons.curved.addEventListener('click', () => setRulerMode('curved'));

    rulerSnapSubMenuButtons.center = document.getElementById('btn-ruler-snap-center');
    rulerSnapSubMenuButtons.corner = document.getElementById('btn-ruler-snap-corner');
    rulerSnapSubMenuButtons.center.addEventListener('click', () => setRulerSnapMode('center'));
    rulerSnapSubMenuButtons.corner.addEventListener('click', () => setRulerSnapMode('corner'));

    document.querySelectorAll('#ruler-colors .color-swatch').forEach(swatch => {
        swatch.addEventListener('click', (e) => setRulerColor(e.target.dataset.color, e.target));
    });

    document.getElementById('level-view-down').addEventListener('click', () => stepPlayerLevel(-1));
    document.getElementById('level-view-up').addEventListener('click', () => stepPlayerLevel(1));
    document.getElementById('level-view-toggle').addEventListener('click', () => {
        levelView.isolate = !levelView.isolate;
        if (levelView.isolate && !availableStructureLevels().includes(levelView.active)) levelView.active = 0;
        applyPlayerLevelVisibility();
    });

    dismissSubmenusOnOutsideClick([
        [moveSubMenu, toolMenuButtons.move],
        [rulerSubMenu, toolMenuButtons.ruler]
    ]);

    // --- Character menu tabs (right): Spawn | Instances ---
    document.getElementById('char-tab-spawn').addEventListener('click', () => setCharacterTab('spawn'));
    document.getElementById('char-tab-instances').addEventListener('click', () => setCharacterTab('instances'));
    document.getElementById('char-tab-party').addEventListener('click', () => setCharacterTab('party'));

    // --- HUD panel logic ---
    const hudOverlay = document.getElementById('hud-panel-overlay');
    const hudButtons = document.querySelectorAll('#player-hud .hud-button');
    const closeButtons = document.querySelectorAll('.close-panel-btn');

    showCharacterPanel = (panelId) => {
        // Character work supersedes an armed placement gesture. Other map
        // tools remain selected underneath and resume when the inspector closes.
        if (currentTool === 'place') {
            placeCharacter = null;
            currentTool = null;
            for (const key in toolMenuButtons) toolMenuButtons[key].classList.remove('active');
            syncCharacterMenuActive();
        }
        if (workspace) workspace.setMode(panelId === 'character-menu' ? 'Characters' : 'Character');
        renderHUD(); // refresh sheet from latest character data
        document.querySelectorAll('.hud-panel').forEach(p => p.classList.add('hidden'));
        hudButtons.forEach(button => button.classList.toggle('active', button.dataset.panel === panelId));

        if (panelId === 'character-menu') {
            hudOverlay.style.display = 'none';
            if (workspace) workspace.showPanel('character-menu', 'Characters');
            return;
        }

        const panel = document.getElementById(panelId);
        if (!panel) return;
        hudOverlay.style.display = 'flex';
        if (workspace) workspace.showPanel('hud-panel-overlay', panel.querySelector('h3')?.textContent || 'Character');
        panel.classList.remove('hidden');
    };

    hudButtons.forEach(button => button.addEventListener('click', () => showCharacterPanel(button.dataset.panel)));
    const topCharacters = document.getElementById('btn-workspace-characters');
    if (topCharacters) topCharacters.addEventListener('click', () => showCharacterPanel('character-menu'));

    // Journal filter: re-render the notes under the box (the box itself is
    // static markup, so it keeps focus while the list rebuilds).
    const journalSearch = document.getElementById('journal-search');
    if (journalSearch) journalSearch.addEventListener('input', () => {
        journalQuery = journalSearch.value.trim();
        renderJournalPanel();
    });

    closeAllPanels = function () {
        if (workspace) workspace.closeInspector();
    };

    document.getElementById('hall-enter').addEventListener('click', () => enterWorld());
    document.getElementById('btn-workspace-hall').addEventListener('click', () => {
        if (hall.open) { if (!hall.waiting) enterWorld(); return; }
        openHall();
        renderHall();
    });

    document.getElementById('btn-end-turn').addEventListener('click', () => {
        if (socket) socket.emit('combat-end-turn', {});
    });

    closeButtons.forEach(btn => btn.addEventListener('click', closeAllPanels));
    updatePlayerHintBar();

    // Headless-testing handle (mirrors gm.js __dbg; socket attaches on login).
    window.__dbg = {
        terrain, scene, camera, controls, worldGroup, fogMask, cameraFly, atmosphere, visionFx, renderer,
        getObjects: () => objects,
        joinMap: (key) => { currentMapKey = key; if (socket) socket.emit('join-map', { key }); },
        forceRender: () => { updateTerrainLOD(); tickAtmosphere(); visionFx.update(); visionFx.render(); }
    };

    startRenderLoop({
        renderer, scene, camera, controls,
        render: () => visionFx.render(),
        onTick: () => {
            if (cameraFly && terrain) cameraFly.tick(terrain.worldOrigin); // GM-directed flight owns the camera this frame
            orbitHall();                                                   // campaign hall backdrop
            updateWorldFollow({ plane, grid, dirLight, camera }, controls.target); // ground/shadows follow
            if (combatOverlays) combatOverlays.tick(); // rings/badges track their tokens
            if (combatAim) combatAim.tick();           // the aimed template breathes
            if (zoneLayer) zoneLayer.tick();           // lingering areas pulse and follow their caster
            if (castDesk) castDesk.tick();             // so do a spell being asked for, and the others' ghosts
            tickRigCharacters();                                           // character idle/walk clips
            tickMonsterAnimations();                                       // monster rigs, combat fx, breath
            tickGrounding(worldGroup.children);                            // feet on the slope (after the clips)
            if (!terrain) return;
            terrain.tick(performance.now() / 1000);                       // water animation
            if (terrain.group.visible) updateTerrainLOD();                 // detailed chunks vs summary
            tickAtmosphere();                                              // sky, light, weather
            visionFx.update();                                             // what the played character sees
        }
    });
    // The map arrives from the server once the player logs in (see initSocket).
}

// Whose eyes the screen uses: the selected own token, else the active sheet's
// token, else any own token on this map. None (or the briefing hall) = no
// vision effect; the server still only sends what own tokens can see.
function visionViewer() {
    if (hall.open) return null;
    if (selectedObject && playerOwnsObject(selectedObject)) return selectedObject;
    const own = objects.filter(playerOwnsObject);
    return own.find(o => o.userData.characterData.id === activeCharId) || own[0] || null;
}

function visionEnabled() {
    return !!(campaignContext && campaignContext.settings && campaignContext.settings.vision &&
        campaignContext.settings.vision.enabled);
}

// A token sees with its sheet's senses: tell the server what the sheet
// derives for each of this player's tokens (it filters creatures by them).
const sentSenses = new Map();
function syncOwnSenses() {
    if (!socket || !SRD) return;
    for (const object of objects) {
        if (!playerOwnsObject(object)) continue;
        const char = myCharacters.find(c => c.id === object.userData.characterData.id);
        if (!char) continue;
        const senses = normalizeSenses(deriveSheet(char).senses);
        const wanted = JSON.stringify(senses);
        const id = object.userData.syncId;
        const stored = JSON.stringify(normalizeSenses((object.userData.objectData || {}).senses));
        if (wanted === stored || sentSenses.get(id) === wanted) continue;
        sentSenses.set(id, wanted);
        socket.emit('set-vision', { id, senses });
    }
}

function tickVisionChip() {
    if (!visionChip) return;
    if (!visionEnabled() || hall.open) { visionChip.set(null); return; }
    const viewer = visionViewer();
    if (!viewer) {
        visionChip.set({ name: 'Vision', note: 'Place a character on this map to see creatures' });
        return;
    }
    const info = visionFx.info || {};
    visionChip.set({
        name: `Seeing as ${viewer.userData.characterData.name || 'your character'}`,
        senses: info.senses || {}, light: (viewer.userData.objectData || {}).light || null,
        sightFeet: info.sightFeet, canLight: true
    });
}

// Sky + weather (shared/atmosphere.js): runs after the LOD pass set the fog
// range; the readout chip refreshes twice a second.
function tickAtmosphere() {
    if (!atmosphere) return;
    atmosphere.update({
        target: controls.target, dist: camera.position.distanceTo(controls.target),
        terrain, outdoors: terrainIsUnified
    });
    const now = performance.now();
    if (now - skyTickAt < 500) return;
    skyTickAt = now;
    if (skyChip) skyChip(atmosphere.info.label);
    tickVisionChip();
    const hallSky = hall.open && document.getElementById('hall-sky');
    if (hallSky && atmosphere.info.label) hallSky.textContent = atmosphere.info.label;
}

// LOD (U3): nested lit 3D rings under the fine chunks on the unified world;
// zooming out reveals more 3D world. Mirrors gm.js.
function updateTerrainLOD() {
    // Floating origin: slide the world under the camera when it wanders too far
    // for float32 (players free-roam the unified world too).
    if (terrainIsUnified) maybeRebaseWorld({ terrain, worldGroup, camera, controls });
    const dist = camera.position.distanceTo(controls.target);
    // Wheel zoom spans grass level to survey altitude — scale the speed with
    // distance (log) so the trip doesn't take hundreds of ticks while close-up
    // stays precise. Mirrors gm.js.
    controls.zoomSpeed = Math.min(4, Math.max(1, 0.8 + Math.log10(Math.max(1, dist / 25))));
    // Frustum follows zoom (mirrors gm.js): survey altitude needs a far plane
    // millions of units out, tactical work needs near=0.1. Only touch the
    // camera on real change — updateProjectionMatrix isn't free.
    const near = Math.max(0.1, Math.min(2000, dist * 0.002));
    const far = Math.max(40000, dist * 8);
    if (near < camera.near * 0.7 || near > camera.near * 1.4 ||
        far > camera.far * 1.4 || far < camera.far * 0.7) {
        camera.near = near; camera.far = far;
        camera.updateProjectionMatrix();
    }
    // The backdrop plane doubles as the ground-pick target (token moves,
    // rulers): scale it with zoom so rays from any screen point still hit it.
    plane.scale.setScalar(Math.max(1, (dist * 3) / 2000));
    terrain.setGridFade(1 - Math.max(0, Math.min(1, (dist - 15) / (40 - 15))));
    // Terrain streaming/LOD centers are world coords; the camera target is scene.
    const worldTarget = { x: controls.target.x + terrain.worldOrigin.x,
                          z: controls.target.z + terrain.worldOrigin.z };
    terrain.updateWindow(worldTarget);
    if (terrainIsUnified) {
        terrain.setLODVisible(true);
        terrain.setOceanEnabled(true);
        terrain.updateLODRings(worldTarget);
        plane.visible = false;
        scene.fog.near = Math.max(FOG_NEAR, dist * 1.5);
        scene.fog.far = Math.max(FOG_FAR, dist * 6);
    } else {
        terrain.setLODVisible(false);
        terrain.setOceanEnabled(false);
        setGroundCut(plane, terrain.dugBounds());   // pits dug below a pocket's floor show
        scene.fog.near = FOG_NEAR;
        scene.fog.far = FOG_FAR;
    }
    const vegetationVisible = terrainIsUnified && !levelCutawayState;
    if (grass) grass.update(camera, controls, vegetationVisible);
    if (trees) trees.update(camera, controls, vegetationVisible);
    if (groundCover) groundCover.update(camera, controls, vegetationVisible);
    if (fogOverlay) fogOverlay.update(fogMask, worldTarget.x, worldTarget.z, dist);
}

function onPointerDown(event) {
    // Left button = tools; right/middle and Ctrl+left = camera (OrbitControls).
    if (event.button !== 0 || isCameraClick(event)) return;

    if (isDraggingHeight) { finishHeightDrag(); return; }

    // Combat: an aimed area is released where the template lies.
    if (combatAim && combatAim.active) { combatAim.commit(); return; }
    // Outside a fight: releasing the template asks the GM.
    if (castDesk && castDesk.active) { castDesk.commit(); return; }

    castFromPointer(event, { renderer, camera, raycaster, mouse });
    // A token being carried rides under the cursor: it must never catch its
    // own drop click (that used to read as "deselect" and put it back).
    const carrying = carriedToken();
    const allObjects = [...(levelCutawayState ? [] : [plane]), ...objects.filter(o => o.visible && o !== carrying)];
    const intersects = raycaster.intersectObjects(allObjects, true);
    if (intersects.length === 0) return;

    const firstIntersect = intersects[0];
    let topLevelObject = firstIntersect.object;
    while (topLevelObject.parent && topLevelObject.parent !== scene && topLevelObject.parent !== worldGroup) {
        topLevelObject = topLevelObject.parent;
    }
    const clickedObject = objects.find(obj => obj === topLevelObject);

    // GM-built structures are scenery to players. A floor, tread or visible
    // roof hit becomes the support height for placement and movement. While a
    // token is carried, furniture and other props are just the spot it lands.
    const clickedType = clickedObject && clickedObject.userData.objectType;
    const clickedCreature = !!clickedObject && (!!clickedObject.userData.characterData || clickedType === 'token');
    const buildAsGround = isStructureType(clickedType) || (!!carrying && !!clickedObject && !clickedCreature);

    // Combat: an ability collecting targets takes every click until it fires.
    if (abilityTargeting.active) {
        const targetId = clickedObject && clickedObject.userData.syncId;
        abilityTargeting.click(targetId && combatState && combatState.combatants[targetId] ? targetId : null);
        return;
    }
    // Combat: with an attack pending, this click picks the target instead.
    if (pendingAttack) {
        const targetId = clickedObject && clickedObject.userData.syncId;
        if (targetId && combatState && combatState.combatants[targetId] && socket) {
            socket.emit('combat-action', {
                combatantId: pendingAttack.combatantId, kind: 'attack',
                targetId, attackIndex: pendingAttack.attackIndex,
                ...attackPayloadOptions(combatState.combatants[pendingAttack.combatantId])
            });
        } else if (combatTracker) {
            combatTracker.flash('Attack cancelled — that was not a combatant');
        }
        pendingAttack = null;
        updatePlayerHintBar();
        return;
    }
    if (pendingSpell) {
        const targetId = clickedObject && clickedObject.userData.syncId;
        if (targetId && combatState && combatState.combatants[targetId] && socket) {
            socket.emit('combat-action', {
                combatantId: pendingSpell.combatantId, kind: 'cast',
                spellIndex: pendingSpell.spellIndex, targetId,
                ...(pendingSpell.slotLevel ? { slotLevel: pendingSpell.slotLevel } : {})
            });
        } else if (combatTracker) {
            combatTracker.flash('Spell cancelled — that was not a combatant');
        }
        pendingSpell = null;
        updatePlayerHintBar();
        return;
    }

    if (clickedObject && !buildAsGround) {
        // Combat: combatant tokens are locked to their owner, on their turn.
        const deny = currentTool === 'move' ? combatSelectDenied(clickedObject) : null;
        if (deny) {
            selectObject(clickedObject, { openInspector: true });
            if (combatTracker) combatTracker.flash(deny);
            return;
        }
        if (currentTool === 'move' && !playerMayMove(clickedObject)) {
            selectObject(clickedObject, { openInspector: true });
            return;
        }
        if (currentTool === 'move' && currentMoveMode === 'y-only') {
            selectObject(clickedObject, { openInspector: false });
            isDraggingHeight = true;
        } else {
            if (selectedObject === clickedObject) {
                deselectObject();
            } else {
                selectObject(clickedObject, { openInspector: currentTool !== 'move' });
            }
        }
    } else if (firstIntersect.object.name === "tabletop" || buildAsGround) {
        const support = (buildAsGround || ['move', 'place', 'ruler'].includes(currentTool))
            ? pickPlayerSupportSurface(event, { exclude: selectedObject }) : null;
        const intersectPoint = support ? support.point : sceneToWorld(firstIntersect.point);

        switch (currentTool) {
            case 'move':
                dropCarried(support);
                break;
            case 'ruler':
                ruler.click(ruler.snap(intersectPoint), emitRuler);
                break;
            case 'place':
                placeCharacterAt(intersectPoint, support && support.object ? support.point.y : null);
                break;
            default:
                if (selectedObject) deselectObject();
                break;
        }
    }
}

// The height drag ends: the lifted token stays where it is.
function finishHeightDrag() {
    isDraggingHeight = false;
    if (selectedObject && playerMayMove(selectedObject) && selectedObject.userData.syncId && socket) {
        const position = { x: selectedObject.position.x, y: selectedObject.position.y, z: selectedObject.position.z };
        updateObjectPositionData(selectedObject);
        socket.emit('move-object', { id: selectedObject.userData.syncId, position });
        updateFlyStances();
    }
    deselectObject();
}

// The move tool lets go of the token it carries, where it stands now.
// `support` is the surface under the click that dropped it, if there was one.
function dropCarried(support = null) {
    if (!selectedObject) return;
    if (!playerMayMove(selectedObject)) { deselectObject(); return; }
    // Emit the move to the server (shared map)
    const docId = selectedObject.userData.syncId;
    if (docId && socket) {
        // The cursor is past a wall: the token stayed on this
        // side (onPointerMove) and stays in hand.
        if (carryBlocked) {
            notify('The way is blocked: walls, bars and shut doors stop you');
            return;
        }
        if (support) {
            const held = flyClearance(selectedObject);
            selectedObject.position.y = support.point.y + (selectedObject.userData.halfHeight || 0) + held;
        }
        const finalPosition = snapToGrid(selectedObject.position);
        selectedObject.position.x = finalPosition.x;
        selectedObject.position.z = finalPosition.z;
        // Dropped where it stood: nothing to send.
        if (dragStartPos && selectedObject.position.distanceToSquared(dragStartPos) < 1e-6) {
            deselectObject();
            return;
        }
        // The server refuses a walk through walls; say so here
        // and keep hold of the token instead of sending it.
        if (!wayIsOpen(selectedObject)) {
            notify('The way is blocked: walls, bars and shut doors stop you');
            return;
        }
        updateObjectPositionData(selectedObject);
        socket.emit('move-object', {
            id: docId,
            position: {
                x: finalPosition.x,
                y: selectedObject.position.y, // keep current height
                z: finalPosition.z
            }
        });
        updateFlyStances();
    }
    focusCameraOn(selectedObject.position);
    deselectObject();
}

function onPointerMove(event) {
    ruler.trackMouse(event);

    // Combat: the area template follows the cursor over the ground.
    if (combatAim && combatAim.active) {
        const spot = pickPlayerSupportSurface(event);
        if (spot) combatAim.move(spot.point);
        return;
    }
    if (castDesk && castDesk.active) {
        const spot = pickPlayerSupportSurface(event);
        if (spot) castDesk.move(spot.point);
        return;
    }

    if (isDraggingHeight && selectedObject) {
        const deltaY = event.movementY * -0.01;
        selectedObject.position.y += deltaY;
        const halfHeight = selectedObject.userData.halfHeight || 0;
        if (selectedObject.position.y < halfHeight) {
            selectedObject.position.y = halfHeight;
        }
        return;
    }

    if (currentTool === 'place' && placeCharacter) {
        // Reuse the ruler tooltip as the placement hint (the tools are exclusive).
        const el = document.getElementById('ruler-tooltip');
        if (el) {
            el.textContent = `Place ${placeCharacter.name || 'character'} — click the ground (Esc cancels)`;
            el.style.display = 'block';
            el.style.left = (event.clientX + 14) + 'px';
            el.style.top = (event.clientY + 14) + 'px';
        }
        return;
    }

    if (currentTool !== 'move' && currentTool !== 'ruler') return;
    const support = pickPlayerSupportSurface(event, { exclude: selectedObject });
    if (!support) return;
    const intersectPoint = support.point;

    if (currentTool === 'move' && selectedObject && playerMayMove(selectedObject)) {
        // Standard movement follows the clicked terrain/floor/stair/roof surface.
        // A carried token never passes a wall, bars or a shut door: it waits at
        // the last spot it could walk to while the cursor is beyond them.
        const held = selectedObject.position.clone();
        applyMove(selectedObject, snapToGrid(intersectPoint), currentMoveMode,
            (x, z, halfHeight) => intersectPoint.y + halfHeight);
        carryBlocked = !wayIsOpen(selectedObject);
        if (carryBlocked) selectedObject.position.copy(held);
        updateMoveCostTooltip(event); // combat: live «X ft — Y ft left»
        updateBlockedTooltip(event);
    }

    if (currentTool === 'ruler' && ruler.points.length > 0) {
        const previewPoints = [...ruler.points, ruler.snap(intersectPoint)];
        ruler.updatePreview(previewPoints);
        ruler.updateTooltip(previewPoints, false);
    } else if (currentTool === 'ruler') {
        ruler.updateTooltip([], false, true); // show "0 ft" at the cursor
    }

}

// Double-click a portal to travel to its target map (the server sends the new
// map-state back; players navigate the world exclusively through portals).
function onDoubleClick(event) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = raycaster.intersectObjects(objects, true)[0];
    if (!hit) return;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
    const obj = objects.find(o => o === top);
    if (obj && obj.userData.objectType === 'portal' && obj.userData.portalTarget && socket) {
        enterPortal(obj);
    } else if (obj && obj.userData.objectType === 'wall' && socket) {
        // Doors open and close for a character standing at them.
        const at = sceneToWorld(hit.point);
        const door = nearestDoor({ ...obj.userData.objectData, position: obj.position }, at.x, at.z, 0.85);
        if (door) socket.emit('toggle-door', { id: obj.userData.syncId, index: door.index });
    } else if (obj && socket && propUse(obj)) {
        useProp(obj);
    }
}

function enterPortal(portal) {
    currentMapKey = portal.userData.portalTarget;
    socket.emit('join-map', { key: currentMapKey });
    // Fresh map, fresh viewpoint.
    controls.target.set(0, 0, 0);
    camera.position.set(20, 30, 20);
}

// Furniture a character can use (shared/passage.js): a cot to lie on, a bench
// or a high seat to sit on. → the verb for its button, or null.
function propUse(object) {
    const data = object && object.userData.objectType === 'prop' ? (object.userData.objectData || {}) : null;
    const pose = data && PROP_POSES[data.kind];
    if (!pose) return null;
    const occupant = objects.find(o => o.userData.pose && o.userData.pose.prop === object.userData.syncId);
    if (occupant && playerOwnsObject(occupant)) return 'Get up';
    return pose === 'lying' ? 'Lie down' : 'Sit down';
}
// The selected own character uses it, else whichever of mine stands nearest.
function useProp(object) {
    const mine = selectedObject && playerOwnsObject(selectedObject) ? selectedObject.userData.syncId : undefined;
    socket.emit('use-prop', { id: object.userData.syncId, tokenId: mine });
}

// The own token riding under the cursor in the move tool, if any.
function carriedToken() {
    return currentTool === 'move' && currentMoveMode !== 'y-only' && selectedObject && playerMayMove(selectedObject)
        ? selectedObject : null;
}

// Walls, shut doors and bars (shared/passage.js — the server runs the same
// check on the same records). Rebuilt at most twice a second while dragging.
let barrierCache = null, barrierCacheAt = 0;
function mapBarriers() {
    const now = performance.now();
    if (!barrierCache || now - barrierCacheAt > 500) {
        barrierCacheAt = now;
        barrierCache = buildBarriers(objects.map(object => ({
            ...(object.userData.objectData || {}),
            type: object.userData.characterData ? 'character' : object.userData.objectType,
            position: { x: object.position.x, y: object.position.y, z: object.position.z }
        })));
    }
    return barrierCache;
}
function wayIsOpen(object) {
    const rules = normalizeMovement(campaignContext && campaignContext.settings && campaignContext.settings.movement);
    if (!rules.walls || !dragStartPos) return true;
    const soles = object.userData.halfHeight || 0;
    return walkable(mapBarriers(),
        { x: dragStartPos.x, z: dragStartPos.z, feet: dragStartPos.y - soles },
        { x: object.position.x, z: object.position.z, feet: object.position.y - soles }).ok;
}
function updateBlockedTooltip(event) {
    if (!selectedObject || !carryBlocked) {
        if (!(combatState && combatState.started)) hideMoveTooltip();
        return;
    }
    const el = document.getElementById('ruler-tooltip');
    if (!el) return;
    el.textContent = 'Blocked';
    el.style.color = '#ff6b6b';
    el.style.display = 'block';
    el.style.left = (event.clientX + 14) + 'px';
    el.style.top = (event.clientY + 14) + 'px';
}

// A short message in the corner (refusals, blocked moves) — also in the
// encounter tracker when a fight is on.
function notify(text) {
    if (rollLog) rollLog.notice(text);
    if (combatTracker) combatTracker.flash(text);
}

function onContextMenu(event) {
    event.preventDefault();
    if (wasRightDrag && wasRightDrag(event)) return; // right-drag = camera orbit, not a click
    if (currentTool !== 'ruler') return;
    const support = pickPlayerSupportSurface(event);
    if (support) ruler.restartAt(ruler.snap(support.point), emitRuler);
}

function onKeyDown(event) {
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        const key = event.key.toLowerCase();
        if (key === 's') { event.preventDefault(); setTool('select'); return; }
        if (key === 'm') { event.preventDefault(); setMoveMode('standard'); return; }
        if (key === 'r') { event.preventDefault(); setRulerMode(ruler.mode); return; }
        if (key === 'c') { event.preventDefault(); showCharacterPanel('character-menu'); return; }
        if (key === 'a') { event.preventDefault(); showCharacterPanel('actions-panel'); return; }
        if (key === 'e') { event.preventDefault(); workspace?.toggleDock(); return; }
        if (event.key === '.' && selectedObject) { event.preventDefault(); jumpCameraTo(selectedObject.position); return; }
    }

    if (event.key === "Enter" && abilityTargeting.active) {
        abilityTargeting.confirm();
        return;
    }
    // No delete for players
    if (event.key === "Escape") {
        if (combatAim && combatAim.cancel()) return;
        if (castDesk && castDesk.cancel()) return;
        if (abilityTargeting.cancel()) return;
        if (pendingAttack) {
            pendingAttack = null;
            if (combatTracker) combatTracker.flash('Attack cancelled');
            updatePlayerHintBar();
            return;
        } else if (pendingSpell) {
            pendingSpell = null;
            if (combatTracker) combatTracker.flash('Spell cancelled');
            updatePlayerHintBar();
            return;
        }
        if (currentTool === 'place') {
            setTool('move'); // also drops placeCharacter (see setTool)
        } else if (currentTool === 'ruler' && ruler.points.length > 0) {
            ruler.clearInProgress();
        } else if (isDraggingHeight) {
            isDraggingHeight = false;
            deselectObject();
        } else if (selectedObject) {
            deselectObject();
        }
    }
}

// --- Touch (shared/touch.js) -------------------------------------------------
// A finger cannot hover, so what rides under the mouse cursor (a carried
// token, a spell's template) is put down by a tap or dragged, and the action
// bar lets go of it; everything else a tap does is the left click.
const pressKey = (key) => onKeyDown({ key, target: null, preventDefault() {} });

function touchPicking() { return !!(pendingAttack || pendingSpell || abilityTargeting.active); }

function touchTap(event) {
    if ((combatAim && combatAim.active) || (castDesk && castDesk.active)) {
        onPointerMove(event); // the template goes there; Cast releases it
    } else if (isDraggingHeight || touchPicking()) {
        onPointerDown(event);
    } else if (carriedToken()) {
        onPointerMove(event); // the token goes there; "Move here" drops it
    } else {
        if (currentTool === 'ruler') onPointerMove(event);
        onPointerDown(event);
    }
    updatePlayerHintBar();
}

// What a one-finger drag starting here does, or null for a camera pan.
function touchClaim(event) {
    if ((combatAim && combatAim.active) || (castDesk && castDesk.active) || isDraggingHeight) {
        return { move: onPointerMove, end: updatePlayerHintBar };
    }
    if (currentTool !== 'move' || touchPicking()) return null;
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const hit = raycaster.intersectObjects(objects.filter(o => o.visible), true)[0];
    let top = hit && hit.object;
    while (top && top.parent && top.parent !== scene && top.parent !== worldGroup) top = top.parent;
    const token = top && objects.find(o => o === top);
    if (!token || !playerMayMove(token) || combatSelectDenied(token)) return null;
    if (currentMoveMode === 'y-only') {
        // Press a token and drag: it rises and sinks with the finger.
        return { start: (ev) => { if (!isDraggingHeight) onPointerDown(ev); }, move: onPointerMove, end: updatePlayerHintBar };
    }
    // Press a token and drag: it is carried, and dropped where the finger lifts.
    return {
        start: () => { if (selectedObject !== token) selectObject(token, { openInspector: false }); },
        move: onPointerMove,
        end: (ev) => { onPointerMove(ev); dropCarried(); updatePlayerHintBar(); },
        cancel: () => deselectObject()
    };
}

function touchActions() {
    const cancel = { label: 'Cancel', run: () => pressKey('Escape') };
    if (combatAim && combatAim.active) return [{ label: 'Cast', kind: 'primary', run: () => combatAim.commit() }, cancel];
    if (castDesk && castDesk.active) return [{ label: 'Ask the GM', kind: 'primary', run: () => castDesk.commit() }, cancel];
    if (abilityTargeting.active) return [{ label: 'Fire', kind: 'primary', run: () => pressKey('Enter') }, cancel];
    if (pendingAttack || pendingSpell) return [cancel];
    if (currentTool === 'place' && placeCharacter) return [cancel];
    if (isDraggingHeight) return [{ label: 'Done', kind: 'primary', run: finishHeightDrag }, cancel];
    const carried = carriedToken();
    if (carried) {
        const moved = dragStartPos && carried.position.distanceToSquared(dragStartPos) > 1e-6;
        return [...(moved ? [{ label: 'Move here', kind: 'primary', run: () => dropCarried() }] : []),
            { label: 'Put back', run: () => deselectObject() }];
    }
    if (currentTool === 'ruler' && ruler.points.length) {
        return [...(ruler.points.length > 1 ? [{ label: 'Finish', kind: 'primary', run: () => ruler.finalize(emitRuler) }] : []),
            { label: 'Clear', run: () => ruler.clearInProgress() }];
    }
    if (selectedObject && socket) {
        if (selectedObject.userData.objectType === 'portal' && selectedObject.userData.portalTarget) {
            const portal = selectedObject;
            return [{ label: 'Enter', kind: 'primary', run: () => enterPortal(portal) }];
        }
        const verb = propUse(selectedObject);
        if (verb) { const prop = selectedObject; return [{ label: verb, kind: 'primary', run: () => useProp(prop) }]; }
    }
    return [];
}

function updatePlayerHintBar() {
    const touch = !!(touchInput && touchInput.touch);
    if (touchBar) touchBar.set(touch ? touchActions() : []);
    const bar = document.getElementById('hint-bar');
    if (!bar) return;
    const cam = 'RMB orbit · MMB pan · wheel zoom';
    if (combatAim && combatAim.active) {
        bar.textContent = `${combatAim.hint()} · ${cam}`;
    } else if (castDesk && castDesk.active) {
        bar.textContent = `${castDesk.hint()} · ${cam}`;
    } else if (abilityTargeting.active) {
        bar.textContent = `${abilityTargeting.hint()} · ${cam}`;
    } else if (pendingAttack || pendingSpell) {
        bar.textContent = `Pick a combat target · click a token · Esc cancel · ${cam}`;
    } else if (currentTool === 'place' && placeCharacter) {
        bar.textContent = `Place ${placeCharacter.name || 'character'} · click the ground · Esc cancel · ${cam}`;
    } else if (currentTool === 'move') {
        bar.textContent = selectedObject && playerMayMove(selectedObject)
            ? `Move ${objectIdentity(selectedObject, objects).displayName} · click where it goes · Esc puts it back · ${cam}`
            : `Move · click one of your character tokens, then where it goes · ${cam}`;
    } else if (currentTool === 'ruler') {
        bar.textContent = `Measure · click to add points · right-click restart · Esc cancel · ${cam}`;
    } else if (selectedObject) {
        bar.textContent = `${objectIdentity(selectedObject, objects).displayName} selected · . focus · Esc clear · ${cam}`;
    } else {
        bar.textContent = `Click a token to inspect · double-click a door, a cot or a seat to use it · M move · R measure · ${cam}`;
    }
    if (touch) bar.textContent = touchHint(bar.textContent, !!(combatAim && combatAim.active) || !!(castDesk && castDesk.active) || isDraggingHeight);
}

// Scene <-> world conversion at the raycast/camera boundary (floating origin).
function sceneToWorld(p) {
    return new THREE.Vector3(p.x + terrain.worldOrigin.x, p.y, p.z + terrain.worldOrigin.z);
}

const _flyFrom = new THREE.Vector3();
const FLY_DOWN = new THREE.Vector3(0, -1, 0);

function supportUnderToken(token) {
    const structures = objects.filter(o => o.visible && ['floor', 'stair', 'roof'].includes(o.userData.objectType));
    const targets = [...structures];
    if (!levelCutawayState) {
        if (terrain && terrain.group.visible) targets.push(terrain.chunkGroup);
        targets.push(plane);
    }
    if (!targets.length) return null;
    const origin = terrain ? terrain.worldOrigin : { x: 0, z: 0 };
    _flyFrom.set(token.position.x - origin.x, token.position.y + 0.5, token.position.z - origin.z);
    raycaster.set(_flyFrom, FLY_DOWN);
    const hit = raycaster.intersectObjects(targets, true)[0];
    return hit ? hit.point.y : null;
}

function tokenIsAirborne(token) {
    return flyClearance(token) > 0;
}

// How far the token's soles hang free of the support below (0 = standing on it).
function flyClearance(token) {
    const support = supportUnderToken(token);
    if (support == null) return 0;
    const clear = token.position.y - (token.userData.halfHeight || 0) - support;
    return clear > MOVE_RULES.airborne ? clear : 0;
}

// Recompute which tokens hang free of their support and hand the result to the
// stance syncs: those hover (fly clip) whether or not combat is running.
function updateFlyStances() {
    const airborne = new Set();
    for (const token of objects) {
        const data = token.userData;
        if (!data || !(data.rigCharacter || data.monsterIndex) || !token.visible || !token.parent) continue;
        if (tokenIsAirborne(token)) airborne.add(data.syncId);
    }
    syncMonsterStances(combatState, airborne);
    syncCharacterStances(combatState, airborne);
}

function pickPlayerSupportSurface(event, { exclude = null } = {}) {
    castFromPointer(event, { renderer, camera, raycaster, mouse });
    const structures = objects.filter(o => o !== exclude && o.visible &&
        ['floor', 'stair', 'roof'].includes(o.userData.objectType));
    const targets = [...structures];
    if (!levelCutawayState) {
        if (terrain && terrain.group.visible) targets.push(terrain.chunkGroup);
        targets.push(plane);
    }
    const hit = raycaster.intersectObjects(targets, true)[0];
    if (!hit) return null;
    let top = hit.object;
    while (top.parent && top.parent !== scene && top.parent !== worldGroup && top.parent !== terrain?.chunkGroup) top = top.parent;
    return { point: sceneToWorld(hit.point), object: objects.find(o => o === top) || null };
}

function availableStructureLevels() {
    const levels = new Set([0]);
    for (const object of objects) {
        const data = object.userData.objectData || {};
        if (!isStructureType(object.userData.objectType)) continue;
        const here = structureStoreyLevel(data);
        levels.add(here);
        if (data.type === 'stair') {
            const there = Number.isFinite(Number(data.toLevel))
                ? Math.round(Number(data.toLevel))
                : here + Math.sign(Number(data.rise) || 1);
            levels.add(there);
        }
    }
    return [...levels].sort((a, b) => a - b);
}

function playerLevelName(level) {
    return level < 0 ? `B${Math.abs(level)}` : level > 0 ? `L${level}` : 'Ground';
}

function stepPlayerLevel(direction) {
    const levels = availableStructureLevels();
    if (!levelView.isolate) {
        const candidates = direction < 0 ? levels.filter(n => n < 0).reverse() : levels.filter(n => n > 0);
        levelView.active = candidates[0] ?? 0;
        levelView.isolate = true;
    } else {
        const next = direction < 0
            ? [...levels].reverse().find(n => n < levelView.active)
            : levels.find(n => n > levelView.active);
        if (next != null) levelView.active = next;
    }
    applyPlayerLevelVisibility();
}

function restorePlayerCutaway() {
    if (!levelCutawayState) return;
    if (terrain) terrain.group.visible = levelCutawayState.terrain;
    if (plane) plane.visible = levelCutawayState.plane;
    levelCutawayState = null;
}

function applyPlayerLevelVisibility() {
    const levels = availableStructureLevels();
    const vertical = levels.some(n => n !== 0);
    if (!vertical) levelView.isolate = false;
    for (const object of objects) {
        const type = object.userData.objectType;
        if (!isStructureType(type)) continue;
        const data = object.userData.objectData || { type };
        object.visible = !levelView.isolate || structureTouchesLevel(data, levelView.active);
    }
    const cutAwayTerrain = vertical && levelView.isolate && levelView.active < 0;
    if (cutAwayTerrain && terrain && plane) {
        if (!levelCutawayState) levelCutawayState = { terrain: terrain.group.visible, plane: plane.visible };
        terrain.group.visible = false;
        plane.visible = false;
        if (grass) grass.hide();
        if (trees) trees.hide();
        if (groundCover) groundCover.hide();
    } else if (!cutAwayTerrain) {
        restorePlayerCutaway();
    }

    const panel = document.getElementById('level-view');
    if (panel) panel.classList.toggle('hidden', !vertical);
    const toggle = document.getElementById('level-view-toggle');
    if (toggle) toggle.textContent = levelView.isolate ? playerLevelName(levelView.active) : 'All levels';
    const down = document.getElementById('level-view-down');
    const up = document.getElementById('level-view-up');
    const pivot = levelView.isolate ? levelView.active : 0;
    if (down) down.disabled = !levels.some(n => n < pivot);
    if (up) up.disabled = !levels.some(n => n > pivot);
}

function focusCameraOn(worldPos) {
    controls.target.set(worldPos.x - terrain.worldOrigin.x, worldPos.y, worldPos.z - terrain.worldOrigin.z);
}

// GM view lock: while locked the GM owns this camera — orbit/pan/zoom are
// disabled (tools still work) and a banner says so.
function setViewLock(locked) {
    controls.enabled = !locked;
    const banner = document.getElementById('view-lock-banner');
    if (banner) banner.classList.toggle('hidden', !locked);
}

// --- Character menu (right): place your own character on the map ---
// Click a character button: select it for the HUD and arm placement for a new
// token instance (click again to cancel). Spawn selection is deliberately
// camera-neutral; the Instances tab is the explicit "jump to token" control.
function armPlaceCharacter(char) {
    if (!char) return;
    activeCharId = char.id;
    renderHUD();
    // Selecting a character means the player is taking control — stop any
    // in-progress GM-directed flight (unlocked only, mirroring the wheel/pointer
    // handlers) so it can't keep dragging the camera back to the GM's view.
    if (controls.enabled) {
        if (cameraFly) cameraFly.cancel();
        pendingViewPose = null;
    }
    if (currentTool === 'place' && placeCharacter && placeCharacter.id === char.id) {
        setTool('move'); // toggle off (also drops placeCharacter, see setTool)
        return;
    }
    placeCharacter = char;
    setTool('place');
    syncCharacterMenuActive();
    if (workspace) workspace.closeInspector();
}

// Mirrors the GM's loadCharactersToMenu: one button per character, colored.
function renderCharacterMenu() {
    const listContainer = document.getElementById('character-button-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';

    if (!myCharacters.length) {
        listContainer.innerHTML = '<div class="workspace-empty">You do not have a character yet.<br><button class="workspace-primary" data-workspace-studio="/creator">Create your first character</button></div>';
        return;
    }

    myCharacters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'character-card';
        card.style.setProperty('--character-color', char.color || '#7f8a99');

        const main = document.createElement('button');
        main.className = 'character-card-main';
        const classes = (char.classes || []).map(c => `${c.class || 'class'} ${c.level || 1}`).join(' / ');
        main.innerHTML = '<span class="character-card-name"></span><span class="character-card-meta"></span>';
        main.querySelector('.character-card-name').textContent = char.name || 'Unnamed';
        main.querySelector('.character-card-meta').textContent = classes || char.race || 'Character';
        main.title = 'Open character sheet';
        main.addEventListener('click', () => {
            activeCharId = char.id;
            renderHUD();
            showCharacterPanel('char-panel');
        });

        const place = document.createElement('button');
        place.className = 'character-card-place';
        place.textContent = 'Place';
        place.title = 'Place another token instance';
        place.dataset.charId = char.id;
        place.addEventListener('click', () => armPlaceCharacter(char));

        card.append(main, place);
        listContainer.appendChild(card);
    });
    syncCharacterMenuActive();
}

function syncCharacterMenuActive() {
    document.querySelectorAll('#character-button-list .character-card-place').forEach(btn => {
        btn.classList.toggle('active', !!placeCharacter && btn.dataset.charId === placeCharacter.id);
    });
}

// --- Character menu tabs: Spawn (place tokens) | Instances (where they are) |
// Party (who is in this campaign — identity only, no numbers) ---
function setCharacterTab(tab) {
    document.getElementById('char-tab-spawn').classList.toggle('active', tab === 'spawn');
    document.getElementById('char-tab-instances').classList.toggle('active', tab === 'instances');
    document.getElementById('char-tab-party').classList.toggle('active', tab === 'party');
    document.getElementById('character-button-list').classList.toggle('hidden', tab !== 'spawn');
    document.getElementById('character-instance-list').classList.toggle('hidden', tab !== 'instances');
    document.getElementById('character-party-list').classList.toggle('hidden', tab !== 'party');
    if (tab === 'instances' && socket) socket.emit('get-character-instances'); // fresh on open
    if (tab === 'party' && socket) socket.emit('get-party');                   // fresh on open
}

// The party roster: names, owners and the class/level line — deliberately
// identity-only (HP/AC/conditions of other characters stay hidden from players).
function renderPartyList() {
    const list = document.getElementById('character-party-list');
    if (!list) return;
    if (!partyMembers.length) {
        list.innerHTML = '<p style="font-size: 12px; color: #999;">No one in the party yet.</p>';
        return;
    }
    list.innerHTML = '';
    const classNameOf = (index) => {
        const cls = (typeof SRD !== 'undefined' && SRD) ? SRD.get('classes', index) : null;
        return cls ? cls.name : String(index || '').replace(/^\w/, c => c.toUpperCase());
    };
    partyMembers.forEach(member => {
        const row = document.createElement('div');
        row.className = 'instance-row';
        const main = document.createElement('div');
        main.className = 'instance-row-main';
        const name = document.createElement('div');
        name.className = 'inst-name';
        name.textContent = member.name || 'Unnamed';
        const line = document.createElement('div');
        line.className = 'inst-loc';
        line.textContent = [member.race ? String(member.race).replace(/^\w/, c => c.toUpperCase()) : '',
            member.cls ? `${classNameOf(member.cls)} ${member.level || 1}` : ''].filter(Boolean).join(' · ') || '—';
        const by = document.createElement('div');
        by.className = 'inst-by';
        by.textContent = `Played by ${member.owner || 'unknown'}`;
        main.append(name, line, by);
        row.appendChild(main);
        list.appendChild(row);
    });
}

// Tactical paths share the '@world' room server-side; mirror that routing so
// "already on this map" checks match the room the server actually joined us to.
function roomKeyOf(key) {
    return /^world(\/-?\d+,-?\d+){3}$/.test(key) ? '@world' : key;
}

// Snap the orbit target to a world position and re-seat the camera beside it
// (same fresh viewpoint as portal travel). On the unified world we re-seat the
// floating origin at the destination first, so we land there exactly however
// far the origin sat before (e.g. left at the GM's look point by a "Bring to my
// view") — not relying on maybeRebaseWorld to inch there over later frames.
function jumpCameraTo(worldPos) {
    if (cameraFly) cameraFly.cancel();
    if (terrainIsUnified) setWorldOriginAt({ terrain, worldGroup }, worldPos.x, worldPos.z);
    focusCameraOn(worldPos);
    camera.position.set(controls.target.x + 8, controls.target.y + 12, controls.target.z + 8);
}

// Click an instance row: fly to the token if its map is already loaded,
// otherwise travel there (join its map, then jump once map-state lands).
function gotoInstance(inst) {
    // A locked GM view stays authoritative. Spawn selection remains available
    // for the HUD, but explicit camera travel waits until the GM releases it.
    if (!inst || !socket || !controls.enabled) return;
    if (selectedObject) deselectObject({ restoreContext: false });
    if (workspace) workspace.closeInspector();
    if (cameraFly) cameraFly.cancel();
    pendingViewPose = null;
    const pos = inst.position || { x: 0, y: 0, z: 0 };
    if (inst.mapKey === currentMapKey || inst.mapKey === roomKeyOf(currentMapKey)) {
        jumpCameraTo(pos);
        return;
    }
    currentMapKey = inst.mapKey;
    pendingFocus = { ...pos };
    socket.emit('join-map', { key: inst.mapKey });
}

// First entry into a campaign: open on the map the player's character is
// standing on (the GM may have placed it in a dungeon the overworld fog still
// hides) instead of the campaign spawn. The roster arrives before the first
// map-state, so a same-map token only queues the camera jump.
function landOnOwnToken() {
    if (!seekOwnToken) return;
    seekOwnToken = false;
    // A GM on this screen is sent everyone's tokens: only our own count.
    const mine = characterInstances.filter(entry => entry.owner === myUsername);
    const inst = mine.find(entry => entry.charId === activeCharId) || mine[0];
    if (!inst || !socket) return;
    pendingFocus = { ...(inst.position || { x: 0, y: 0, z: 0 }) };
    if (inst.mapKey === currentMapKey || inst.mapKey === roomKeyOf(currentMapKey)) return;
    currentMapKey = inst.mapKey;
    socket.emit('join-map', { key: inst.mapKey });
}

function renderInstanceList() {
    const list = document.getElementById('character-instance-list');
    if (!list) return;
    list.innerHTML = '';
    if (!characterInstances.length) {
        list.innerHTML = '<p style="font-size: 12px; color: #999;">No characters on any map yet.</p>';
        return;
    }
    const instanceGroups = new Map();
    characterInstances.forEach(inst => {
        const key = inst.charId || `${inst.owner || ''}:${inst.charName || ''}`;
        if (!instanceGroups.has(key)) instanceGroups.set(key, []);
        instanceGroups.get(key).push(inst);
    });
    instanceGroups.forEach(group => group.sort((a, b) => String(a.id).localeCompare(String(b.id))));
    characterInstances.forEach(inst => {
        const row = document.createElement('div');
        row.className = 'instance-row';
        if (inst.color) row.style.borderLeftColor = inst.color;

        const main = document.createElement('button');
        main.className = 'instance-row-main';
        main.type = 'button';
        main.title = 'Click: jump to this token';

        const name = document.createElement('div');
        name.className = 'inst-name';
        const group = instanceGroups.get(inst.charId || `${inst.owner || ''}:${inst.charName || ''}`) || [inst];
        const ordinal = group.indexOf(inst) + 1;
        name.textContent = `${inst.charName || 'Unnamed'}${group.length > 1 ? ` · ${ordinal} of ${group.length}` : ''}`;
        if (inst.color) name.style.color = inst.color;

        const loc = document.createElement('div');
        loc.className = 'inst-loc';
        const p = inst.position || {};
        loc.textContent = `${inst.mapName || inst.mapKey} (${Math.round(p.x || 0)}, ${Math.round(p.z || 0)})`;

        const by = document.createElement('div');
        by.className = 'inst-by';
        by.textContent = `Spawned by ${inst.addedBy || 'unknown'}`;

        main.append(name, loc, by);
        main.addEventListener('click', () => gotoInstance(inst));

        const remove = document.createElement('button');
        remove.className = 'instance-row-delete';
        remove.type = 'button';
        remove.title = 'Delete this character token';
        remove.setAttribute('aria-label', `Delete ${inst.charName || 'character token'}`);
        remove.textContent = '×';
        remove.addEventListener('click', event => {
            event.stopPropagation();
            if (!socket || !confirm(`Delete ${inst.charName || 'this character token'} from ${inst.mapName || inst.mapKey}?`)) return;
            socket.emit('delete-character-instance', { id: inst.id, mapKey: inst.mapKey });
        });

        row.append(main, remove);
        list.appendChild(row);
    });
}

function placeCharacterAt(worldPoint, supportY = null) {
    if (!placeCharacter || !socket) return;
    const heightScale = (placeCharacter.appearance && placeCharacter.appearance.height) || 1;
    const halfHeight = (1 * heightScale) / 2 * 0.4;
    const snapped = snapToGrid(worldPoint);
    // A clicked upper/basement floor wins; otherwise retain the terrain fallback.
    const base = Number.isFinite(supportY)
        ? supportY
        : (terrain && terrain.group.visible) ? terrain.sampleHeight(snapped.x, snapped.z) : 0;
    socket.emit('add-object', {
        type: 'character',
        characterData: placeCharacter,
        position: { x: snapped.x, y: base + halfHeight, z: snapped.z }
    });
    placeCharacter = null;
    setTool('select');
}

// --- Object Management ---
function replaceObjectGeometry(object, patch) {
    const index = objects.indexOf(object);
    if (index < 0) return object;
    const source = object.userData.objectData || {};
    const data = {
        ...source,
        ...patch,
        position: { x: object.position.x, y: object.position.y, z: object.position.z }
    };
    const replacement = buildObjectFromData(object.userData.syncId, data);
    if (!replacement) return object;
    const wasSelected = selectedObject === object;
    if (wasSelected) setObjectSelected(object, false);
    if (objectNameplates) objectNameplates.removeFrom(object);
    worldGroup.remove(object);
    disposeBuiltObject(object);
    worldGroup.add(replacement);
    objects[index] = replacement;
    if (wasSelected) {
        selectedObject = replacement;
        dragStartPos = replacement.position.clone();
        setObjectSelected(replacement, true);
    }
    applyPlayerLevelVisibility();
    return replacement;
}

function createObjectFromData(id, data) {
    const mesh = buildObjectFromData(id, data);
    if (mesh) {
        worldGroup.add(mesh); // synced positions are world coords
        objects.push(mesh);
        applyPlayerLevelVisibility();
        if (objectNameplates) objectNameplates.sync(objects);
    }
}

function applyStructureBatchResult(result = {}) {
    const resultIsPocket = typeof result.key === 'string' && result.key.startsWith('pocket/');
    const currentIsPocket = currentMapKey.startsWith('pocket/');
    if (result.key && result.key !== currentMapKey && (resultIsPocket || currentIsPocket)) return;
    const created = Array.isArray(result.created) ? result.created : [];
    const updated = Array.isArray(result.updated) ? result.updated : [];
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    for (const record of created) {
        if (record && record.id && !objects.some(object => object.userData.syncId === record.id)) {
            createObjectFromData(record.id, record);
        }
    }
    for (const entry of updated) {
        if (!entry || !entry.id || !entry.patch) continue;
        const object = objects.find(candidate => candidate.userData.syncId === entry.id);
        if (!object) continue;
        const type = object.userData.objectType;
        const geometryChanged = (type === 'wall' && (Object.prototype.hasOwnProperty.call(entry.patch, 'segments') ||
            Object.prototype.hasOwnProperty.call(entry.patch, 'doors'))) ||
            ((type === 'floor' || type === 'roof') && Object.prototype.hasOwnProperty.call(entry.patch, 'tiles'));
        if (geometryChanged) replaceObjectGeometry(object, entry.patch);
        else updateObjectPresentation(object, entry.patch);
    }
    for (const entry of deleted) {
        const id = typeof entry === 'string' ? entry : entry && entry.id;
        const object = objects.find(candidate => candidate.userData.syncId === id);
        if (!object) continue;
        if (selectedObject === object) deselectObject();
        if (objectNameplates) objectNameplates.removeFrom(object);
        worldGroup.remove(object);
        disposeBuiltObject(object);
        objects = objects.filter(candidate => candidate !== object);
    }
    applyPlayerLevelVisibility();
    if (objectNameplates) objectNameplates.sync(objects);
}

function playerOwnsObject(object) {
    const char = object?.userData?.characterData;
    return !!(char && myUsername && char.owner === myUsername);
}
// What the move tool may carry: own characters, and what their spells summoned.
function playerMayMove(object) {
    if (playerOwnsObject(object)) return true;
    const data = object?.userData?.objectType === 'summon' ? object.userData.objectData : null;
    return !!(data && myUsername && data.owner === myUsername);
}

function playerModeLabel() {
    return ({ select: 'Select', move: 'Move', ruler: 'Measure', place: 'Place' })[currentTool] || 'Explore';
}

function playerSelectionMetric(label, value) {
    return `<div class="selection-metric"><span>${escHtml(label)}</span><strong>${escHtml(value)}</strong></div>`;
}

function renderPlayerSelectionInspector({ open = true } = {}) {
    const object = selectedObject;
    const content = document.getElementById('selection-content');
    if (!object || !content) return;
    const id = object.userData.syncId;
    const data = object.userData.objectData || {};
    const char = object.userData.characterData || null;
    const monster = data.monsterData || null;
    const type = char ? 'character' : (object.userData.objectType || data.type || 'object');
    const identity = objectIdentity(object, objects);
    const combatant = combatState && combatState.combatants[id];
    const owner = char?.owner || '';
    const ownerLabel = /^gm$/i.test(owner) ? 'the GM' : owner;
    const typeLabel = char ? 'Character token' : ({ token: 'Creature token', portal: 'Portal', cave: 'Cave', arch: 'Rock arch', prop: 'Prop', cube: 'Object', sphere: 'Object' }[type] || 'Map object');
    const effects = (Array.isArray(combatant?.effects) ? combatant.effects : [])
        .map(effect => EFFECTS[effect.key]?.label || effect.label || effect.key);
    const classes = (char?.classes || []).map(entry => `${entry.class || 'class'} ${entry.level || 1}`).join(' / ');
    const monsterMeta = monster
        ? `${monster.size || 'Medium'} ${monster.type || 'creature'}`
        : '';
    const meta = [typeLabel, identity.instanceText, owner ? `Controlled by ${ownerLabel}` : '', char?.race || '', classes, monsterMeta].filter(Boolean).join(' · ');

    const roundLabel = combatState?.round == null
        ? '—'
        : combatInteger(combatState.round, { fallback: 0, min: 0, max: 1000000 });
    const combatHTML = combatant ? `<div class="selection-section">
        <div class="selection-section-title"><span>Encounter</span><span>${combatState.started && combatState.activeId === id ? 'Active turn' : `Round ${escHtml(roundLabel)}`}</span></div>
        <div class="selection-metrics">
            ${playerSelectionMetric('HP', `${combatant.hp?.current ?? '—'}/${combatant.maxHP}`)}
            ${playerSelectionMetric('AC', combatant.ac)}
            ${playerSelectionMetric('Speed', `${combatInteger(combatant.speedFeet, { fallback: 0, min: 0, max: 1000000 })} ft`)}
            ${playerSelectionMetric('Initiative', combatant.initiative ?? '—')}
            ${playerSelectionMetric('Movement', combatState.activeId === id ? `${remainingFeet(combatant)} ft` : '—')}
            ${playerSelectionMetric('Conditions', effects.length || 0)}
        </div>
        ${effects.length ? `<div class="selection-effects" style="margin-top:8px">${effects.map(effect => `<span class="selection-effect active">${escHtml(effect)}</span>`).join('')}</div>` : ''}
    </div>` : '';

    const note = char
        ? `${ownerLabel === 'the GM' ? 'The GM' : (ownerLabel || 'The GM')} controls this character. Its game details are read-only here.`
        : 'The GM controls this map object. You can inspect it and focus your camera without changing it.';
    content.innerHTML = `<div class="selection-hero" style="--selection-color:${escHtml(identity.color)}">
            <span class="selection-color"></span>
            <div><span class="selection-name">${escHtml(identity.displayName)}</span><span class="selection-meta">${escHtml(meta)}</span></div>
        </div>
        ${combatHTML}
        <div class="selection-section">
            <div class="selection-section-title"><span>Location</span></div>
            <div class="selection-metrics">
                ${playerSelectionMetric('X', Math.round(object.position.x))}
                ${playerSelectionMetric('Y', Number(object.position.y).toFixed(1))}
                ${playerSelectionMetric('Z', Math.round(object.position.z))}
            </div>
        </div>
        <div class="selection-section"><div class="selection-readonly">${escHtml(note)}</div>
            <div class="selection-actions">
                <button type="button" class="selection-button primary wide" data-player-selection-act="focus">Focus camera</button>
                ${type === 'portal' && object.userData.portalTarget ? '<button type="button" class="selection-button wide" data-player-selection-act="portal">Enter portal</button>' : ''}
                ${propUse(object) ? `<button type="button" class="selection-button wide" data-player-selection-act="use">${propUse(object)}</button>` : ''}
            </div>
        </div>`;

    content.querySelectorAll('[data-player-selection-act]').forEach(button => button.addEventListener('click', () => {
        if (selectedObject !== object) return;
        if (button.dataset.playerSelectionAct === 'focus') jumpCameraTo(object.position);
        if (button.dataset.playerSelectionAct === 'use' && socket) useProp(object);
        if (button.dataset.playerSelectionAct === 'portal' && socket && object.userData.portalTarget) {
            currentMapKey = object.userData.portalTarget;
            socket.emit('join-map', { key: currentMapKey });
        }
    }));

    if (open && workspace) {
        workspace.showPanel('selection-panel', identity.displayName, typeLabel);
        if (currentTool == null) workspace.setMode('Inspect');
    }
}

function selectObject(object, { openInspector = true } = {}) {
    if (!object) return;
    if (!selectedObject && workspace && openInspector) {
        selectionReturnContext = { panel: workspace.currentPanel(), open: workspace.isInspectorOpen() };
    }
    if (selectedObject) deselectObject({ restoreContext: false, preserveReturn: true });
    selectedObject = object;
    dragStartPos = object.position.clone(); // combat movement is measured from here
    carryBlocked = false;
    setObjectSelected(object, true);
    selectionOwnsInspector = openInspector;

    const char = object.userData.characterData;
    if (openInspector && char && playerOwnsObject(object)) {
        activeCharId = char.id;
        renderHUD();
        showCharacterPanel('char-panel');
    } else if (openInspector) {
        renderPlayerSelectionInspector({ open: true });
    }
    updatePlayerHintBar();
}

function deselectObject({ restoreContext = true, preserveReturn = false } = {}) {
    if (selectedObject) {
        revertUncommittedMove(selectedObject, dragStartPos);
        setObjectSelected(selectedObject, false);
    }
    selectedObject = null;
    dragStartPos = null;
    hideMoveTooltip();
    const selectionPanels = new Set(['selection-panel', 'hud-panel-overlay']);
    if (restoreContext && selectionOwnsInspector && workspace && selectionPanels.has(workspace.currentPanel())) {
        const context = selectionReturnContext;
        if (context?.open && context.panel && !selectionPanels.has(context.panel)) workspace.showPanel(context.panel);
        else workspace.closeInspector();
        workspace.setMode(playerModeLabel());
    }
    if (!preserveReturn) {
        selectionReturnContext = null;
        selectionOwnsInspector = false;
    }
    updatePlayerHintBar();
}

// --- Combat mode -------------------------------------------------------------

function findObjectMesh(id) { return objects.find(o => o.userData.syncId === id); }
const combatantDown = c => (c.effects || []).some(e => e.key === 'down');

// Why a click on a token is refused during combat (null = allowed).
function combatSelectDenied(obj) {
    if (!combatState || !combatState.started) return null;
    const c = combatState.combatants[obj.userData.syncId];
    if (!c) return null; // not a combatant: moves freely
    if (c.owner !== myUsername) return `You don't control ${c.name}`;
    if (combatState.activeId !== c.id) return `Not ${c.name}'s turn`;
    if (combatantDown(c)) return `${c.name} is down`;
    return null;
}

// Every combat-updated re-applies the whole state: tracker, overlays, HUD.
function setCombat(combat) {
    const previousActiveId = combatState && combatState.activeId;
    const hadCombat = !!combatState;
    combatState = combat;
    if (combatTracker) combatTracker.setState(combat);
    answerStatsPending();
    if (combatOverlays) combatOverlays.sync(combat);
    if (zoneLayer) zoneLayer.sync(combat && combat.zones);
    updateFlyStances();
    renderHUD(); // the Actions panel reflects turn state
    const endBtn = document.getElementById('btn-end-turn');
    if (endBtn) {
        const active = combat && combat.started && combat.combatants[combat.activeId];
        endBtn.classList.toggle('hidden', !(active && active.owner === myUsername));
    }
    if (workspace) {
        workspace.setDockVisible(!!combat);
        const active = combat?.started && combat.combatants[combat.activeId];
        const activeObject = active && findObjectMesh(active.id);
        const activeName = activeObject ? objectIdentity(activeObject, objects).displayName : active?.name;
        const myTurn = !!(active && active.owner === myUsername);
        const gathering = combat && !combat.started ? `${Object.keys(combat.combatants).length} combatants · Roll initiative` : '';
        const status = !combat ? 'Waiting for the GM'
            : myTurn ? `Your turn · ${remainingFeet(active)} ft left`
                : active ? `Round ${combat.round} · ${activeName}`
                    : gathering || `Round ${combat.round || '—'}`;
        workspace.setEncounterStatus(status, !!combat, myTurn);
        if (combat && (!hadCombat || (myTurn && previousActiveId !== combat.activeId))) workspace.setDockExpanded(true);
    }
    if (!combat) { pendingAttack = null; pendingSpell = null; abilityTargeting.cancel(true); hideMoveTooltip(); }
    if (combatAim) { if (!combat) combatAim.cancel(true); else combatAim.refresh(); }
    // A saving throw is waiting on this player: open the tracker and say so.
    const owed = combatTracker && combat ? combatTracker.owedSaves() : 0;
    if (owed > owedSaves) {
        if (workspace) workspace.setDockExpanded(true);
        notify(owed > 1 ? `${owed} saving throws to roll — see the encounter tracker` : 'Roll your saving throw — see the encounter tracker');
    }
    owedSaves = owed;
    if (selectedObject && !playerOwnsObject(selectedObject)) renderPlayerSelectionInspector({ open: false });
    updatePlayerHintBar();
}

// Character combatants join with statsPending: their owner's client answers
// with SRD-derived numbers (first write wins server-side). answeredStats stops
// re-sends while our write is still in flight.
const answeredStats = new Set();
function answerStatsPending() {
    if (!combatState || !SRD || !socket) return;
    for (const c of Object.values(combatState.combatants)) {
        if (!c.statsPending || c.owner !== myUsername || !c.charId || answeredStats.has(c.id)) continue;
        const char = myCharacters.find(x => x.id === c.charId);
        if (!char) continue;
        answeredStats.add(c.id);
        socket.emit('combat-set-stats', { combatantId: c.id, ...deriveCombatStats(char, SRD) });
    }
}

function beginAbilityPick(combatantId, abilityIndex, ability) {
    pendingAttack = null;
    pendingSpell = null;
    abilityTargeting.cancel(true);
    // An area with a size is aimed on the map; the rest pick creatures.
    if (combatAim && combatAim.begin(combatantId, abilityIndex, ability, 'ability', attackPayloadOptions(combatState.combatants[combatantId]))) {
        closeAllPanels();
        return;
    }
    if (ability && ability.maxTargets > 0) closeAllPanels();
    abilityTargeting.begin(combatantId, abilityIndex, ability);
}

function beginTargetPick(combatantId, attackIndex, attack) {
    abilityTargeting.cancel(true);
    if (combatAim) combatAim.cancel(true);
    pendingSpell = null;
    pendingAttack = { combatantId, attackIndex };
    closeAllPanels();
    if (combatTracker) combatTracker.flash(`Pick a target for ${attack.name}: click a token (Esc cancels)`);
    updatePlayerHintBar();
}

function beginSpellPick(combatantId, spellIndex, spell, slotLevel = null) {
    abilityTargeting.cancel(true);
    pendingAttack = null;
    pendingSpell = null;
    closeAllPanels();
    // A spell with an area is aimed on the map; the rest pick a creature.
    if (combatAim && combatAim.begin(combatantId, spellIndex, spell, 'cast', slotLevel ? { slotLevel } : {})) return;
    // No roll (Bless, Invisibility): pick who gets it, Enter = the caster.
    if (spell && !spell.attackType && !spell.saveAbility) {
        abilityTargeting.begin(combatantId, spellIndex, spell, 'cast', slotLevel ? { slotLevel } : {});
        return;
    }
    pendingSpell = { combatantId, spellIndex, slotLevel };
    if (combatTracker) combatTracker.flash(`Pick a target for ${spell.name}: click a token (Esc cancels)`);
    updatePlayerHintBar();
}

// Live «12 ft — 18 ft left» while dragging the active combatant. Reuses the
// ruler tooltip element (move and ruler tools are mutually exclusive).
function updateMoveCostTooltip(event) {
    if (!dragStartPos || !selectedObject || !combatState || !combatState.started) return;
    const c = combatState.combatants[selectedObject.userData.syncId];
    if (!c || combatState.activeId !== c.id) return;
    const el = document.getElementById('ruler-tooltip');
    if (!el) return;
    const flat = Math.hypot(selectedObject.position.x - dragStartPos.x,
        selectedObject.position.z - dragStartPos.z) / GRID_CELL_SIZE * FEET_PER_GRID_CELL;
    // What the server will charge: the ground under the line (ground.js).
    const rules = normalizeMovement(campaignContext && campaignContext.settings && campaignContext.settings.movement);
    const soles = selectedObject.userData.halfHeight || 0;
    const priced = rules.terrain && terrain && flat <= 600 ? pathCost(
        { x: dragStartPos.x, y: dragStartPos.y - soles, z: dragStartPos.z },
        { x: selectedObject.position.x, y: selectedObject.position.y - soles, z: selectedObject.position.z },
        terrain.costGround(), { modes: moveModesOf(c), snow: rules.snow }) : null;
    const feet = priced ? priced.cost : flat;
    const over = priced && feet > flat + 0.5 ? describeCost(priced) : '';
    const left = c.speedFeet + c.dashFeet - c.movementUsedFeet;
    el.textContent = `${Math.round(flat)} ft${over ? ` (costs ${Math.round(feet)}: ${over})` : ''} — ${Math.max(0, Math.round(left - feet))} ft left`;
    el.style.color = feet > left + 0.5 ? '#ff6b6b' : '';
    el.style.display = 'block';
    el.style.left = (event.clientX + 14) + 'px';
    el.style.top = (event.clientY + 14) + 'px';
}

function hideMoveTooltip() {
    if (currentTool === 'ruler') return; // the ruler owns the tooltip right now
    const el = document.getElementById('ruler-tooltip');
    if (el) { el.style.display = 'none'; el.style.color = ''; }
}

// --- Character sheet HUD rendering ---
function activeChar() {
    return myCharacters.find(c => c.id === activeCharId) || myCharacters[0] || null;
}

// The HUD sheet is the shared derivation (rules.js): race/class/background
// features, feats and item grants all land here and in combat alike.
function deriveSheet(char) {
    return buildSheet(char, SRD);
}

// Current HP is server-persisted: seed from the character's stored hp.current
// (falling back to full HP), and push every change back to the server.
function getCurrentHP(char, maxHP) {
    if (hpState[char.id] == null) {
        hpState[char.id] = (char.hp && typeof char.hp.current === 'number')
            ? Math.min(char.hp.current, maxHP) : maxHP;
    }
    return Math.max(0, Math.min(hpState[char.id], maxHP));
}
function setCurrentHP(char, value, maxHP) {
    const v = Math.max(0, Math.min(Math.round(value), maxHP));
    hpState[char.id] = v;
    if (char.hp) char.hp.current = v; else char.hp = { current: v };
    if (socket) socket.emit('update-hp', { id: char.id, current: v });
}

// The player's Journal tab: party-visible campaign notes, the shared treasury
// and the XP log — all read-only (the GM authors them from the campaign panel).
function renderJournalPanel() {
    const box = document.getElementById('journal-content');
    if (!box) return;
    const kindTags = { quest: 'Quest', npc: 'NPC', lore: 'Lore', handout: 'Handout' };
    const coins = ['pp', 'gp', 'ep', 'sp', 'cp'].filter(c => journalState.treasury[c])
        .map(c => `${journalState.treasury[c]} ${c}`).join(' · ');
    const entries = journalState.entries.length
        ? journalState.entries.filter(entry => {
            if (!journalQuery) return true;
            const query = journalQuery.toLowerCase();
            return [entry.title, entry.text, kindTags[entry.kind]].filter(Boolean)
                .join(' ').toLowerCase().includes(query);
        }).map(entry => {
            const tag = kindTags[entry.kind] || 'Quest';
            return `<details class="spell-lvl"><summary><b>${escHtml(entry.title)}</b> <span class="muted">${escHtml(tag)}</span></summary>
                <div class="muted" style="white-space:pre-wrap; margin-top:4px;">${escHtml(entry.text)}</div></details>`;
        }).join('')
        : `<p class="muted">${journalQuery ? 'No notes match that filter.' : 'Nothing in the journal yet.'}</p>`;
    const awards = journalState.xp.awards.length
        ? journalState.xp.awards.slice().reverse().map(award => {
            const date = award.at ? new Date(award.at).toLocaleDateString() : '';
            return `<div class="row-item"><span>${escHtml(award.text)}${date ? ` <span class="muted">${escHtml(date)}</span>` : ''}</span><b>${award.xp ? `+${award.xp} XP` : ''}</b></div>`;
        }).join('')
        : '<p class="muted">No XP awarded yet.</p>';
    box.innerHTML = `
        <h4>Notes</h4>
        ${entries}
        <h4>Treasury</h4>
        <div class="row-item"><span>Party coin</span><b>${coins ? escHtml(coins) : '—'}</b></div>
        <h4>Experience ${journalState.xp.mode === 'xp' ? '' : '<span class="muted">(milestone)</span>'}</h4>
        ${awards}`;
}

function renderHUD() {
    const cc = document.getElementById('char-content');
    const ic = document.getElementById('inv-content');
    const sc = document.getElementById('spells-content');
    const ac = document.getElementById('actions-content');
    if (!cc) return;
    if (!SRD) { const m = '<p class="muted">Loading character data…</p>'; cc.innerHTML = ic.innerHTML = sc.innerHTML = ac.innerHTML = m; return; }
    const char = activeChar();
    if (!char) {
        const m = '<p class="muted">No character is assigned to you yet. Build one in the Character Creator (the “/” page) and it will appear here.</p>';
        cc.innerHTML = ic.innerHTML = sc.innerHTML = ac.innerHTML = m;
        document.getElementById('char-title').textContent = 'Character';
        return;
    }
    const d = deriveSheet(char);
    sendVitals();
    renderCharPanel(char, d);
    renderInvPanel(char, d);
    renderSpellsPanel(char, d);
    renderActionsPanel(char, d);
}

function selectorHTML(activeId) {
    if (myCharacters.length <= 1) return '';
    const opts = myCharacters.map(c => `<option value="${escHtml(c.id)}" ${c.id === activeId ? 'selected' : ''}>${escHtml(c.name || 'Unnamed')}</option>`).join('');
    return `<select id="char-select" class="char-select">${opts}</select>`;
}

function renderCharPanel(char, d) {
    const cc = document.getElementById('char-content');
    const cur = getCurrentHP(char, d.maxHP);
    const pct = d.maxHP > 0 ? Math.round((cur / d.maxHP) * 100) : 0;
    const race = SRD.get('races', char.race);
    const sub = char.subrace && SRD.get('subraces', char.subrace);
    const classTxt = (char.classes || []).map(c => {
        const cl = SRD.get('classes', c.class); const s = c.subclass && SRD.get('subclasses', c.subclass);
        return `${escHtml(cl ? cl.name : c.class)} ${c.level}${s ? ` (${escHtml(s.name)})` : ''}`;
    }).join(' / ') || '—';
    document.getElementById('char-title').innerHTML = `${escHtml(char.name || 'Unnamed')} <span class="sheet-sub">${escHtml(sub ? sub.name : (race ? race.name : ''))} · ${classTxt}</span>`;

    // Anything carrying data-roll rolls a d20 with that bonus at the table
    // (shared/rolllog.js; the server rolls and everyone sees the result).
    // A check can carry the sheet's own rules: a die that reads at least
    // `min` (Reliable Talent) and a total never below `floor` (Indomitable Might).
    const rollable = (label, bonus, { min = 0, floor = 0 } = {}) => `data-roll="${escHtml(label)}" data-roll-bonus="${Number(bonus) || 0}"${min > 1 ? ` data-roll-min="${Number(min)}"` : ''}${floor > 0 ? ` data-roll-floor="${Number(floor)}"` : ''} title="Roll ${escHtml(label)}${min > 1 ? ` (the d20 counts as at least ${Number(min)})` : ''}${floor > 0 ? ` (never below ${Number(floor)})` : ''}"`;
    const checkMods = d.rollMods.check;
    const floorOf = (ability) => checkMods.floor.includes(ability) ? d.finals[ability] : 0;
    const metrics = [
        ['HP', `${cur}/${d.maxHP}`], ['AC', d.ac], ['Speed', d.speed],
        ['Init', fmtMod(d.init), rollable('Initiative', d.init)], ['Prof', fmtMod(d.prof)], ['PP', d.pp]
    ].map(([l, v, roll]) => roll
        ? `<button type="button" class="metric-card rollable" ${roll}><div class="l">${l}</div><div class="v">${v}</div></button>`
        : `<div class="metric-card"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

    const abilities = ABILITIES.map(a => {
        const isSave = d.saves.has(a);
        const save = d.mods[a] + (isSave ? d.prof : 0);
        const name = a.toUpperCase();
        return `<div class="ability-cell"><div class="ab-name">${name}</div><div class="ab-score">${d.finals[a]}</div>
            <button type="button" class="ab-roll" ${rollable(`${name} check`, d.mods[a], { floor: floorOf(a) })}>check ${fmtMod(d.mods[a])}</button>
            <button type="button" class="ab-roll" ${rollable(`${name} saving throw`, save)}>save ${fmtMod(save)}${isSave ? ' ✓' : ''}</button></div>`;
    }).join('');

    const skills = SRD.skills.slice().sort((a, b) => a.name.localeCompare(b.name)).map(sk => {
        const ab = sk.ability_score.index;
        const isProf = d.proficient.has(sk.index);
        const bonus = d.skillBonus(sk.index, ab);
        return `<button type="button" class="row-item rollable" ${rollable(`${sk.name} (${ab.toUpperCase()}) check`, bonus, { min: isProf ? checkMods.minDie : 0, floor: floorOf(ab) })}><span>${d.expertise.has(sk.index) ? '◆' : isProf ? '●' : '<span style="color:#555">○</span>'} ${escHtml(sk.name)} <span class="tag">${ab}</span></span><b>${fmtMod(bonus)}</b></button>`;
    }).join('');

    const selectedToken = selectedObject?.userData?.characterData?.id === char.id && playerOwnsObject(selectedObject)
        ? objectIdentity(selectedObject, objects) : null;
    const tokenContext = selectedToken ? `<div class="selection-token-context">
        <span>${escHtml(selectedToken.displayName)} · selected on this map</span>
        <span><button class="selection-button" type="button" data-owned-token-act="focus">Focus</button> <button class="selection-button" type="button" data-owned-token-act="instances">Instances</button> <button class="selection-button primary" type="button" data-owned-token-act="move">Move</button></span>
    </div>` : '';

    cc.innerHTML = `${tokenContext}${selectorHTML(char.id)}
        <div class="metrics-row">${metrics}</div>
        <div class="stat-bar-group">
            <label>Hit Points</label>
            <div class="stat-bar-outer"><div class="stat-bar-inner" style="width:${pct}%; background-color:${pct < 30 ? '#d14444' : (pct < 60 ? '#d1a544' : '#44d17a')};"></div></div>
            <span>${cur} / ${d.maxHP}</span>
            <div class="hp-controls">
                <button class="dmg" data-hp="-5">−5</button>
                <button class="dmg" data-hp="-1">−1</button>
                <button class="heal" data-hp="1">+1</button>
                <button class="heal" data-hp="5">+5</button>
                <button data-hp="full">Full</button>
            </div>
        </div>
        <h4>Abilities <span class="muted roll-hint">click to roll · advantage is set in Rolls</span></h4>
        <div class="ability-grid">${abilities}</div>
        <h4>Skills</h4>
        ${skills}
        ${sheetDetailsHTML(char, d)}`;
    bindRollables(cc, char);

    const sel = document.getElementById('char-select');
    if (sel) sel.onchange = e => { activeCharId = e.target.value; renderHUD(); };
    cc.querySelectorAll('.hp-controls button').forEach(btn => btn.onclick = () => {
        const v = btn.dataset.hp;
        if (v === 'full') setCurrentHP(char, d.maxHP, d.maxHP);
        else setCurrentHP(char, getCurrentHP(char, d.maxHP) + (+v), d.maxHP);
        renderCharPanel(char, d);
    });
    cc.querySelectorAll('[data-owned-token-act]').forEach(button => button.onclick = () => {
        if (!selectedObject || !playerOwnsObject(selectedObject)) return;
        if (button.dataset.ownedTokenAct === 'focus') jumpCameraTo(selectedObject.position);
        if (button.dataset.ownedTokenAct === 'move') setTool('move', { preserveSelection: true });
        if (button.dataset.ownedTokenAct === 'instances') {
            deselectObject({ restoreContext: false });
            setCharacterTab('instances');
            showCharacterPanel('character-menu');
        }
    });
}

// data-roll (+ data-roll-bonus for a d20, data-roll-dice for damage): one
// click asks the server for that roll in the character's name.
function bindRollables(root, char) {
    root.querySelectorAll('[data-roll]').forEach(el => el.onclick = () => {
        if (!rollLog) return;
        const request = { actor: char.name || 'Adventurer', label: el.dataset.roll };
        if (el.dataset.rollBonus != null) {
            request.d20 = {
                bonus: Number(el.dataset.rollBonus) || 0,
                min: Number(el.dataset.rollMin) || 0, floor: Number(el.dataset.rollFloor) || 0
            };
        }
        if (el.dataset.rollDice) request.dice = [{ expr: el.dataset.rollDice, type: el.dataset.rollType || '' }];
        rollLog.roll(request);
    });
}

// Senses, languages, proficiencies and every feature the character owns.
function sheetDetailsHTML(char, d) {
    const line = (label, value) => value ? `<div class="row-item"><span>${label}</span><b>${escHtml(value)}</b></div>` : '';
    const speeds = Object.entries(d.speeds || {}).map(([mode, feet]) => `${mode} ${feet} ft`).join(', ');
    // Party treasury + this character's XP (campaign journal state).
    const coins = ['pp', 'gp', 'ep', 'sp', 'cp'].filter(c => journalState.treasury[c])
        .map(c => `${journalState.treasury[c]} ${c}`).join(' · ');
    const party = [
        line('Treasury', coins),
        Number.isFinite(char.xp) ? line('XP', String(char.xp)) : ''
    ].join('');
    const traits = [
        line('Senses', Object.keys(d.senses || {}).length ? describeSenses(d.senses) : ''),
        line('Other speeds', speeds),
        line('Resistances', d.resistances.join(', ')),
        line('Immunities', d.immunities.join(', ')),
        line('Languages', d.languages.join(', ')),
        line('Proficiencies', d.proficiencies.join(', '))
    ].join('');
    const features = d.features.map(f =>
        `<details class="spell-lvl"><summary>${escHtml(f.name)} <span class="muted">${escHtml(f.sourceLabel || '')}</span></summary><div class="muted" style="white-space:pre-wrap;">${escHtml(f.desc || 'No description.')}</div></details>`
    ).join('') || '<p class="muted">No features.</p>';
    const notes = char.notes ? `<h4>Notes</h4><div class="muted" style="white-space:pre-wrap;">${escHtml(char.notes)}</div>` : '';
    return `${traits ? '<h4>Traits</h4>' + traits : ''}${party ? '<h4>Party</h4>' + party : ''}<h4>Features</h4>${features}${notes}`;
}

function renderInvPanel(char, d) {
    const ic = document.getElementById('inv-content');
    const eq = char.equipment || {};
    const armor = eq.armor ? SRD.get('equipment', eq.armor) : null;
    const armorTxt = armor ? armor.name : 'None';
    const weapons = (eq.weapons || []).map(wi => {
        const w = SRD.get('equipment', wi); if (!w) return '';
        const a = weaponProfile(w, d, SRD, char.classes || []);
        return `<div class="row-item"><span>${escHtml(w.name)} <span class="tag">${a.ranged ? 'ranged ' + a.rangeFt + ' ft' : 'melee'}</span></span><b>${fmtMod(a.attack)} · ${escHtml(a.damage)} ${escHtml(a.damageType)}</b></div>`;
    }).join('') || '<p class="muted">No weapons.</p>';
    const gear = (eq.items || []).map(gi => SRD.get('equipment', gi)).filter(Boolean)
        .map(g => `<div class="row-item"><span>${escHtml(g.name)}</span></div>`).join('') || '<p class="muted">No gear.</p>';
    ic.innerHTML = `
        <h4>Armor</h4>
        <div class="row-item"><span>${escHtml(armorTxt)}${eq.shield ? ' + Shield' : ''}</span><b>AC ${d.ac}</b></div>
        <div class="muted" style="margin-top:4px;">${escHtml(d.acSource)}</div>
        <h4>Weapons</h4>${weapons}
        <h4>Gear</h4>${gear}`;
}

function renderSpellsPanel(char, d) {
    const sc = document.getElementById('spells-content');
    const casters = (char.classes || []).filter(c => SRD.isCaster(c.class));
    if (!casters.length) { sc.innerHTML = '<p class="muted">This character has no spellcasting classes.</p>'; return; }
    const si = d.spellInfo;
    // What is left of each slot level (the server keeps what was spent).
    const slotsLeft = (level) => restDesk ? restDesk.slotsLeft(char.id, level, si.slots[level] || 0) : (si.slots[level] || 0);
    const pactLeft = () => si.pact ? (restDesk ? restDesk.pactLeft(char.id, si.pact.count) : si.pact.count) : 0;
    const leftAt = (level) => slotsLeft(level) + (si.pact && si.pact.level === level ? pactLeft() : 0);
    const slotLine = Object.entries(si.slots).filter(([l, n]) => n > 0)
        .map(([l, n]) => `<span class="slot-count${slotsLeft(l) ? '' : ' spent'}">L${l} ${slotsLeft(l)}/${n}</span>`).join('  ·  ');
    const pactLine = si.pact ? `<span class="slot-count${pactLeft() ? '' : ' spent'}">Pact L${si.pact.level} ${pactLeft()}/${si.pact.count}</span>` : '';
    const casterSummary = si.casters.map(ci => {
        const cl = SRD.get('classes', ci.class);
        return `<div class="row-item"><span>${escHtml(cl ? cl.name : ci.class)} <span class="tag">${ci.ability ? ci.ability.toUpperCase() : ''}</span></span><b>DC ${ci.dc} · atk ${fmtMod(ci.atk)}</b></div>`;
    }).join('');
    const known = (char.spells || []).map(x => SRD.get('spells', x)).filter(Boolean).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    const charLevel = SRD.totalLevel(char.classes || []) || 1;
    // Each spell is cast with the class that has it on its list.
    const casterFor = (spell) => {
        const ci = si.casters.find(c => (spell.classes || []).some(x => x.index === c.class)) || si.casters[0] || {};
        return { atk: ci.atk || 0, dc: ci.dc || 8, abilityMod: (ci.ability && d.mods[ci.ability]) || 0, charLevel };
    };
    const slotLevels = Object.entries(si.slots).filter(([, n]) => n > 0).map(([l]) => Number(l));
    if (si.pact && !slotLevels.includes(si.pact.level)) slotLevels.push(si.pact.level);
    const byLevel = {};
    known.forEach(sp => { (byLevel[sp.level] = byLevel[sp.level] || []).push(sp); });
    const spellSections = Object.keys(byLevel).map(Number).sort((a, b) => a - b).map(lv => {
        const label = lv === 0 ? 'Cantrips' : `Level ${lv}`;
        const items = byLevel[lv].map(sp => {
            const caster = casterFor(sp);
            const upcast = slotLevels.filter(l => l >= sp.level).sort((a, b) => a - b);
            const firstLeft = upcast.find(l => leftAt(l) > 0);
            const slotPick = sp.level > 0 && upcast.length > 1
                ? `<select class="spell-slot" aria-label="Spell slot">${upcast.map(l => `<option value="${l}"${leftAt(l) ? '' : ' disabled'}${l === firstLeft ? ' selected' : ''}>${escHtml(spellLevelLabel(l))} slot (${leftAt(l)} left)</option>`).join('')}</select>` : '';
            const empty = sp.level > 0 && firstLeft == null;
            const mechanics = spellMechanics(sp, caster);
            return `<details class="spell-card" data-spell="${escHtml(sp.index)}"${openSpells.has(sp.index) ? ' open' : ''}>
                <summary><span>${escHtml(sp.name)}${sp.concentration ? ' <span class="tag">C</span>' : ''}${sp.ritual ? ' <span class="tag">R</span>' : ''}</span><span class="muted">${escHtml(mechanics || sp.casting_time || '')}</span></summary>
                ${spellDetailHTML(sp, caster)}
                <div class="spell-cast">${slotPick}<button type="button" class="btn-combat" data-cast="${escHtml(sp.index)}"${empty ? ' disabled title="No spell slots left: ask for a rest"' : ''}>✨ Cast ${escHtml(sp.name)}</button></div>
            </details>`;
        }).join('');
        return `<details class="spell-lvl" open><summary>${label} <span class="muted">(${byLevel[lv].length})</span></summary>${items}</details>`;
    }).join('') || '<p class="muted">No spells known. Add them in the Character Creator.</p>';
    // The spell being held: the tracker's word in a fight, the pool's outside.
    const fighter = combatState ? Object.values(combatState.combatants || {}).find(c => c && c.charId === char.id) : null;
    const held = fighter ? (fighter.concentration || null) : (restDesk ? restDesk.concentrationOf(char.id) : null);
    const owed = !fighter && held && held.dc;
    const heldHTML = held ? `<div class="conc-held${owed ? ' owed' : ''}"><span>◎ Concentrating on <b>${escHtml(held.name)}</b></span>
        ${owed ? `<button type="button" class="btn-combat roll" data-conc="save">🎲 CON save · DC ${escHtml(held.dc)}</button>` : ''}
        <button type="button" class="btn-combat" data-conc="drop">Let it go</button></div>` : '';
    sc.innerHTML = `${heldHTML}
        <div class="row-item"><span>Spell slots</span><b>${slotLine || '—'}${pactLine ? '  ·  ' + pactLine : ''}</b></div>
        <h4>Spellcasting</h4>${casterSummary}
        <h4>Known / Prepared <span class="muted roll-hint">open a spell to read it and cast it</span></h4>${spellSections}`;

    sc.querySelectorAll('[data-conc]').forEach(btn => btn.onclick = () => {
        if (btn.dataset.conc === 'drop') {
            if (fighter) socket.emit('combat-concentration', { combatantId: fighter.id });
            else socket.emit('drop-concentration', { charId: char.id });
        } else if (rollLog) {
            const mods = (d.rollMods && d.rollMods.save) || {};
            rollLog.roll({
                actor: char.name || 'Adventurer', label: 'concentration',
                d20: { bonus: d.mods.con + (d.saves.has('con') ? d.prof : 0) + (mods.bonus || 0) },
                ...(mods.concentration || (mods.advantage || []).includes('con') ? { mode: 'adv' } : {}),
                concSave: { charId: char.id }
            });
        }
    });
    sc.querySelectorAll('details.spell-card').forEach(card => card.addEventListener('toggle', () => {
        if (card.open) openSpells.add(card.dataset.spell); else openSpells.delete(card.dataset.spell);
    }));
    sc.querySelectorAll('[data-cast]').forEach(btn => btn.onclick = () => {
        const spell = SRD.get('spells', btn.dataset.cast);
        if (!spell) return;
        const picked = btn.parentElement.querySelector('.spell-slot');
        const level = picked ? Number(picked.value) : spell.level;
        // Which slot burns: an ordinary one first, else the warlock's pact slot.
        let slot = null;
        if (spell.level > 0) {
            slot = slotsLeft(level) > 0 || !(si.pact && si.pact.level === level && pactLeft() > 0)
                ? { charId: char.id, level, max: si.slots[level] || 0 }
                : { charId: char.id, level, max: si.pact.count, pact: true };
        }
        castSpell(char, spell, casterFor(spell), level, slot);
    });
}

// On your turn in a fight a damage spell goes through the tracker (pick a
// target; the server spends the slot and the action and applies the damage).
// Anything else is a table roll: attack and damage dice in the log, the save
// DC and the spell's range and duration beside them.
function castSpell(char, spell, caster, slotLevel, slot = null) {
    const active = combatState && combatState.started && combatState.combatants[combatState.activeId];
    if (active && active.owner === myUsername && active.charId === char.id) {
        // My turn: the tracker spends the action and the slot. A damage spell
        // picks its target (upcast dice included); any other spell is cast
        // and its effect is the table's to apply.
        const index = (Array.isArray(active.spells) ? active.spells : []).findIndex(known => known && known.name === spell.name);
        if (index >= 0 && (slotLevel === spell.level || (active.spells[index].bySlot || {})[slotLevel] || !active.spells[index].damage)) {
            const quick = active.spells[index].time === 'bonus';
            if (quick ? active.bonusUsed : active.actionUsed) { notify(quick ? 'Bonus action already used this turn' : 'Action already used this turn'); return; }
            beginSpellPick(active.id, index, active.spells[index], slotLevel);
            return;
        }
        const request = spellCastRequest(spell, caster, slotLevel);
        socket.emit('combat-action', {
            combatantId: active.id, kind: 'cast', slotLevel,
            utility: {
                name: spell.name, level: spell.level, note: request.note,
                time: /bonus/i.test(spell.casting_time || '') ? 'bonus' : 'action',
                ...(spell.concentration ? { concentration: true, rounds: spellRounds(spell) } : {})
            }
        });
        return;
    }
    // Outside a fight every spell is asked of the GM: an area is aimed on the
    // map first (the GM watches the template), then the request waits.
    if (castDesk && !(combatState && combatState.started)) {
        const token = objects.find(o => playerOwnsObject(o) && o.userData.characterData && o.userData.characterData.id === char.id);
        const summon = spellSummon(spell);
        const shape = token ? aimShapeOf({ saveAbility: true, summon, ...spellArea(spell) }, 'cast') : null;
        if (shape) closeAllPanels();
        castDesk.request({
            charId: char.id, tokenId: token ? token.userData.syncId : null,
            name: spell.name, level: slotLevel,
            type: ((spell.damage && spell.damage.damage_type && spell.damage.damage_type.name) || '').toLowerCase(),
            shape, roll: spellCastRequest(spell, caster, slotLevel), slot, concentration: !!spell.concentration,
            form: spellForm(spell), light: spellLight(spell), summon
        });
        return;
    }
    // A fight is on and it is not this character's turn (a reaction): the
    // server spends the slot with the roll and refuses when none is left.
    if (rollLog) rollLog.roll({
        actor: char.name || 'Adventurer', ...spellCastRequest(spell, caster, slotLevel), ...(slot ? { slot } : {}),
        ...(spell.concentration ? { concentration: { charId: char.id, name: spell.name } } : {})
    });
}

// What the server needs to heal a character without a sheet: maximum hit
// points, CON modifier and hit dice per die size (shared/rests.js, set-vitals).
const sentVitals = new Map(); // charId -> last payload sent (only changes go out)
function sendVitals(force = false) {
    if (!socket || !SRD) return;
    if (force) sentVitals.clear();
    for (const char of myCharacters) {
        const sheet = deriveSheet(char);
        const hd = {};
        for (const entry of (char.classes || [])) {
            const cls = SRD.get('classes', entry.class);
            const die = cls && Number(cls.hit_die);
            if (die) hd[die] = (hd[die] || 0) + (Number(entry.level) || 0);
        }
        const payload = { charId: char.id, maxHP: sheet.maxHP, con: (sheet.mods && sheet.mods.con) || 0, hd };
        const stamp = JSON.stringify(payload);
        if (sentVitals.get(char.id) === stamp) continue;
        sentVitals.set(char.id, stamp);
        socket.emit('set-vitals', payload);
    }
}

function renderActionsPanel(char, d) {
    const ac = document.getElementById('actions-content');

    // Combat, my turn: the panel becomes the action bar for the ACTIVE
    // combatant (its server-held attacks, not the HUD character's — a player
    // with several tokens acts with whichever one has the turn).
    const active = combatState && combatState.started && combatState.combatants[combatState.activeId];
    if (active && active.owner === myUsername && !combatantDown(active)) {
        const c = active;
        const activeObject = findObjectMesh(c.id);
        const activeLabel = activeObject ? objectIdentity(activeObject, objects).displayName : c.name;
        const dis = c.actionUsed ? 'disabled' : '';
        const atkBtns = (Array.isArray(c.attacks) ? c.attacks : []).map((a, i) =>
            `<button class="btn-combat atk" data-combat-atk="${i}" ${attackAvailable(c, a) ? '' : 'disabled'}>⚔ ${escHtml(a?.name)} <span class="tag">${combatModifier(a?.attack)} · ${escHtml(combatAttackDamageLabel(a))}</span></button>`
        ).join('') || '<p class="muted">No attacks.</p>';
        const abilityBtns = combatAbilityButtonsHTML(c);
        const attacksLeft = combatInteger(c.attacksLeft, { fallback: 0, min: 0, max: 4 })
            + combatInteger(c.bonusAttacks?.count, { fallback: 0, min: 0, max: 4 });
        const spellBtns = (Array.isArray(c.spells) ? c.spells : []).map((spell, i) => {
            const spellLevel = combatSpellLevel(spell?.level);
            const slots = combatInteger(c.slots?.[spellLevel], { fallback: 0, min: 0, max: 99 });
            const spellDis = c.actionUsed || (spellLevel > 0 && slots < 1) ? 'disabled' : '';
            const level = spellLevel === 0 ? 'Cantrip' : `L${spellLevel}`;
            return `<button class="btn-combat" data-combat-spell="${i}" ${spellDis}>✨ ${escHtml(spell?.name)} <span class="tag">${level} · ${escHtml(spell?.damage)} ${escHtml(spell?.damageType)}</span></button>`;
        }).join('') || '<p class="muted">No spells.</p>';
        const round = combatInteger(combatState.round, { fallback: 1, min: 0, max: 1000000 });
        const speed = combatInteger(c.speedFeet, { fallback: 0, min: 0, max: 1000000 });
        ac.innerHTML = `
            <div class="row-item"><span>▶ ${escHtml(activeLabel)}'s turn — Round ${round}</span><b>${remainingFeet(c)} ft left</b></div>
            ${c.actionUsed ? `<p class="muted">Action used this turn${attacksLeft > 0 ? ` — ${attacksLeft} attack${attacksLeft > 1 ? 's' : ''} left` : ''}${c.bonusUsed ? '' : ' — bonus action still available'}. You can still move, then end your turn.</p>` : ''}
            <div class="combat-actions-list combat-options">${combatOptionsHTML(c)}</div>
            <h4>Attacks</h4>
            <div class="combat-actions-list">${atkBtns}</div>
            ${abilityBtns ? `<h4>Abilities</h4><div class="combat-actions-list">${abilityBtns}</div>` : ''}
            <h4>Spells</h4>
            <div class="combat-actions-list">${spellBtns}</div>
            <h4>Other Actions</h4>
            <div class="combat-actions-list">
                <button class="btn-combat" data-combat-act="dash" ${dis}>💨 Dash <span class="tag">+${speed} ft move</span></button>
                <button class="btn-combat" data-combat-act="dodge" ${dis}>🛡 Dodge <span class="tag">attacks vs you at disadv.</span></button>
                <button class="btn-combat" data-combat-act="disengage" ${dis}>↪ Disengage</button>
                <button class="btn-combat end" data-combat-act="end-turn">■ End Turn</button>
            </div>`;
        ac.querySelectorAll('[data-combat-atk]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.combatAtk;
            if (c.attacks[i]) beginTargetPick(c.id, i, c.attacks[i]);
        });
        ac.querySelectorAll('[data-opt]').forEach(btn => btn.onclick = () => {
            if (toggleAttackOption(btn)) renderActionsPanel(char, d);
        });
        ac.querySelectorAll('[data-act="ability"]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.ability;
            if (c.abilities && c.abilities[i]) beginAbilityPick(c.id, i, c.abilities[i]);
        });
        ac.querySelectorAll('[data-combat-spell]').forEach(btn => btn.onclick = () => {
            const i = +btn.dataset.combatSpell;
            if (c.spells[i]) beginSpellPick(c.id, i, c.spells[i]);
        });
        ac.querySelectorAll('[data-combat-act]').forEach(btn => btn.onclick = () => {
            const act = btn.dataset.combatAct;
            if (!socket) return;
            if (act === 'end-turn') socket.emit('combat-end-turn', {});
            else socket.emit('combat-action', { combatantId: c.id, kind: act });
        });
        return;
    }

    // Outside combat (or waiting for the turn): the reference list.
    const activeObject = active && findObjectMesh(active.id);
    const activeLabel = activeObject ? objectIdentity(activeObject, objects).displayName : active?.name;
    const waiting = combatState && combatState.started
        ? `<p class="muted">⚔ Combat — waiting for ${escHtml(activeLabel || '…')}'s turn.</p>` : '';
    const eq = char.equipment || {};
    // Outside a fight an attack is a table roll: to hit and damage together.
    const attackRow = (a, range) => `<button type="button" class="row-item rollable" data-roll="${escHtml(a.name)} attack" data-roll-bonus="${Number(a.attack) || 0}" data-roll-dice="${escHtml(a.damage)}" data-roll-type="${escHtml(a.damageType)}" title="Roll ${escHtml(a.name)}"><span>${escHtml(a.name)} <span class="tag">${escHtml(range)}</span></span><b>${fmtMod(a.attack)} to hit · ${escHtml(a.damage)} ${escHtml(a.damageType)}</b></button>`;
    const attacks = (eq.weapons || []).map(wi => {
        const w = SRD.get('equipment', wi); if (!w) return '';
        const a = weaponProfile(w, d, SRD, char.classes || []);
        return attackRow(a, a.ranged ? 'ranged ' + a.rangeFt + ' ft' : 'melee');
    }).join('') || '<p class="muted">No weapon attacks.</p>';
    const kit = d.combat;
    const naturalAttacks = kit.attacks.filter(a => (a.tags || []).includes('natural') || (a.tags || []).includes('unarmed'))
        .map(a => attackRow(a, a.ranged ? 'ranged' : 'melee')).join('');
    // Outside a fight a feature with a pool is used from here: the server
    // spends the use and rolls its dice into the table log.
    const fighting = !!(combatState && Object.values(combatState.combatants || {}).some(c => c.charId === char.id));
    const usesLeft = (a) => {
        const r = a.resource && kit.resources[a.resource];
        return r && (r.recharge === 'short' || r.recharge === 'long') && restDesk
            ? restDesk.resourceLeft(char.id, a.resource, r.max) : null;
    };
    const abilityRows = kit.abilities.map((a, i) => {
        const left = usesLeft(a);
        const use = !fighting && left != null
            ? ` <button type="button" class="btn-combat use-feature" data-use-ability="${i}"${left < (a.resourceCost || 1) ? ' disabled' : ''}>Use</button>` : '';
        return `<div class="row-item"><span>${escHtml(a.name)}</span><b>${escHtml(combatAbilityLabelFor(a, kit))}${use}</b></div>`;
    }).join('');
    const riderRows = kit.riders.map(r =>
        `<div class="row-item"><span>${escHtml(r.name)}</span><b>+${escHtml(r.damage)} ${escHtml(r.damageType)}${r.oncePerTurn ? ' · once per turn' : ''}</b></div>`).join('');
    const resourceRows = Object.values(kit.resources).filter(r => r.max > 0).map(r =>
        `<div class="row-item"><span>${escHtml(r.name)}</span><b>${r.recharge === 'short' || r.recharge === 'long'
            ? `${restDesk ? restDesk.resourceLeft(char.id, Object.keys(kit.resources).find(key => kit.resources[key] === r), r.max) : r.max}/${r.max} · ${escHtml(r.recharge)} rest`
            : `${r.max} per ${escHtml(r.recharge)}`}</b></div>`).join('');
    const standard = ['Attack', 'Cast a Spell', 'Dash', 'Disengage', 'Dodge', 'Help', 'Hide', 'Ready', 'Search', 'Use an Object']
        .map(x => `<div class="row-item"><span>${x}</span></div>`).join('');
    ac.innerHTML = `${waiting}
        <h4>Attacks</h4>${attacks}${naturalAttacks}
        ${kit.attacksPerAction > 1 ? `<div class="muted">Extra Attack: ${kit.attacksPerAction} attacks per Attack action.</div>` : ''}
        ${abilityRows ? `<h4>Abilities</h4>${abilityRows}` : ''}
        ${riderRows ? `<h4>Bonus Damage</h4>${riderRows}` : ''}
        ${resourceRows ? `<h4>Resources</h4>${resourceRows}` : ''}
        <h4>Standard Actions</h4>${standard}
        <div class="muted" style="margin-top:8px;">Bonus actions &amp; reactions depend on your class features and prepared spells.</div>`;
    bindRollables(ac, char);
    ac.querySelectorAll('[data-use-ability]').forEach(btn => btn.onclick = () => {
        const ability = kit.abilities[Number(btn.dataset.useAbility)];
        const pool = ability && kit.resources[ability.resource];
        if (!pool || !rollLog) return;
        const heal = ability.type === 'heal';
        rollLog.roll({
            actor: char.name || 'Adventurer', label: `uses ${ability.name}`,
            ...(ability.type === 'attack' ? { d20: { bonus: ability.attack || 0 } } : {}),
            ...(ability.damage ? { dice: [{ expr: String(ability.damage).replace(/\s+/g, ''), type: heal ? 'healing' : (ability.damageType || '') }] } : {}),
            note: ability.type === 'save' ? `DC ${ability.dc} ${String(ability.saveAbility).toUpperCase()} save` : '',
            resource: {
                charId: char.id, key: ability.resource, cost: ability.resourceCost || 1, max: pool.max,
                recharge: pool.recharge, name: pool.name,
                // A self-heal (Second Wind) lands on the character at once.
                heal: heal && (ability.area === 'self' || ability.maxTargets <= 1)
            }
        });
    });
}

// Sheet-side summary of a kit ability (no live combatant to read pools from).
function combatAbilityLabelFor(ability, kit) {
    const parts = [ability.cost === 'bonus' ? 'bonus action' : ability.cost === 'free' ? 'free' : 'action'];
    if (ability.type === 'heal') parts.push(`heal ${ability.damage}`);
    else if (ability.damage) parts.push([ability.damage, ability.damageType].filter(Boolean).join(' '));
    if (ability.type === 'attack') parts.push(`${fmtMod(ability.attack)} to hit`);
    if (ability.type === 'save') parts.push(`DC ${ability.dc} ${String(ability.saveAbility).toUpperCase()}`);
    if (ability.area !== 'single' && ability.area !== 'self') parts.push(`${ability.areaFt} ft ${ability.area}`);
    const resource = ability.resource && kit.resources[ability.resource];
    if (resource) parts.push(/^use-/.test(ability.resource) ? `${resource.max}/${resource.recharge} rest` : `${resource.name} ${ability.resourceCost}`);
    return parts.join(' · ');
}

// --- UI Management (Left Menu) ---
function setTool(toolName, { preserveSelection = false } = {}) {
    if (selectedObject && !preserveSelection) deselectObject({ restoreContext: false });
    if (currentTool === 'ruler' && toolName !== 'ruler') {
        ruler.clearAll(() => { if (socket) socket.emit('clear-rulers'); });
    }
    if (toolName !== 'ruler') {
        ruler.hideTooltip();
    }
    if (toolName !== 'place') placeCharacter = null;
    currentTool = toolName;
    for (const key in toolMenuButtons) {
        toolMenuButtons[key].classList.toggle('active', key === toolName);
    }
    if (workspace) {
        workspace.setMode({ select: 'Select', move: 'Move', ruler: 'Measure', place: 'Place' }[toolName] || 'Explore');
        workspace.closeInspector();
    }
    syncCharacterMenuActive();
    updatePlayerHintBar();
}

// --- Move Tool ---
function setMoveMode(mode) {
    currentMoveMode = mode;
    setTool('move');
    for (const key in moveSubMenuButtons) {
        moveSubMenuButtons[key].classList.toggle('active',
            key === mode || (key === 'standard' && mode === 'standard'));
    }
    moveSubMenu.style.display = 'none';
}

// --- Ruler Tool ---
function setRulerMode(mode) {
    ruler.setMode(mode);
    setTool('ruler');
    rulerSubMenuButtons.straight.classList.toggle('active', mode === 'straight');
    rulerSubMenuButtons.curved.classList.toggle('active', mode === 'curved');
}
function setRulerSnapMode(mode) {
    ruler.setSnapMode(mode);
    rulerSnapSubMenuButtons.center.classList.toggle('active', mode === 'center');
    rulerSnapSubMenuButtons.corner.classList.toggle('active', mode === 'corner');
}
function setRulerColor(colorValue, clickedButton) {
    ruler.setColor(colorValue);
    document.querySelectorAll('#ruler-colors .color-swatch').forEach(swatch => {
        swatch.classList.remove('active');
    });
    clickedButton.classList.add('active');
}

// --- Socket.IO: receive and share the GM's map in real time ---
function initSocket() {
    socket = io();
    login.attach(socket);
    // Known up front for a resumed session; confirmed by login-success.
    myUsername = storedUsername();
    if (window.__dbg) window.__dbg.socket = socket; // headless testing
    rollLog = createRollLog({
        socket, isGM: () => false,
        actor: () => (activeChar() && activeChar().name) || myUsername || ''
    });
    chat = createChat({ socket, username: () => myUsername });
    reference = createReferencePanel({
        roll: (request) => rollLog && rollLog.roll(request),
        getActor: () => myUsername
    });
    castDesk = createCastDesk({
        socket, isGM: () => false, username: () => myUsername,
        worldGroup, objects: () => objects, terrain: () => terrain,
        notify, onChange: () => updatePlayerHintBar(),
        onStrike: (summon) => abilityTargeting.begin(summon.casterId, 0, { name: summon.name, maxTargets: 1 }, 'strike', { summonId: summon.id }),
        onFx: (entry) => queueCombatFx(entry, findObjectMesh)
    });
    restDesk = createRestDesk({
        socket, isGM: () => false, username: () => myUsername,
        characters: () => myCharacters.map(c => ({ id: c.id, name: c.name })),
        notify, onChange: (charId) => { if (!charId) sendVitals(true); renderHUD(); },
        // A long rest heals: the owner's screen knows the sheet's maximum.
        onRest: (charId, kind) => {
            const char = kind === 'long' && SRD && myCharacters.find(c => c.id === charId);
            if (char) { const max = deriveSheet(char).maxHP; setCurrentHP(char, max, max); }
        }
    });
    combatTracker = new CombatTracker({
        container: document.getElementById('combat-tracker'),
        socket, isGM: false, username: myUsername,
        onPickTarget: (id, index, item, mode) => mode === 'cast'
            ? beginSpellPick(id, index, item)
            : mode === 'ability' ? beginAbilityPick(id, index, item)
                : beginTargetPick(id, index, item),
        onFocusCombatant: (id) => {
            const object = findObjectMesh(id);
            if (!object) return;
            selectObject(object, { openInspector: false });
            jumpCameraTo(object.position);
        },
        getMapObjects: () => objects.map(object => ({
            id: object.userData.syncId,
            name: objectIdentity(object, objects).displayName,
            type: object.userData.characterData ? 'character' : object.userData.objectType
        }))
    });

    socket.on('connect', () => {
        mapReload.onConnect();
        console.log('Conectado ao servidor com ID:', socket.id);
        socket.emit('login', login.payload({ campaignId, screen: 'player' }));
    });

    socket.on('login-success', (userData) => {
        mapReload.onAuthenticated();
        console.log('Player signed in:', userData);
        myUsername = userData.username;
        isHostUser = !!userData.isGM;
        if (combatTracker) combatTracker.username = myUsername;
        if (workspace) workspace.setUser(userData.username);
        // Rejoin only after application authentication. A delayed pre-login
        // snapshot must not satisfy reconnect recovery.
        if (currentMapKey !== 'world') socket.emit('join-map', { key: currentMapKey });
    });

    // Campaign context arrives before the first map-state (server order).
    // Adopt startKey only on first entry — on reconnect login-success already
    // rejoins the map the player was actually looking at.
    socket.on('campaign-joined', (campaign) => {
        if (!campaign || campaign.ok === false) {
            console.warn('Campaign join failed:', campaign && campaign.error);
            location.replace('/lobby');
            return;
        }
        applyCampaignContext(campaign);
        pendingSpawnLanding = true;
        if (currentMapKey === 'world') seekOwnToken = true;
        if (currentMapKey === 'world' && campaign.startKey) currentMapKey = campaign.startKey;
        if (workspace) workspace.setCampaign({ id: campaign.id, name: campaign.name, owner: campaign.owner });
        syncHall();
        if (rollLog) rollLog.refresh();
        if (chat) chat.refresh();
        if (restDesk) restDesk.refresh();
        if (castDesk) castDesk.refresh();
        socket.emit('get-journal');
        socket.emit('get-party');
    });

    socket.on('campaign-updated', (campaign) => {
        if (!campaign || !campaignContext || campaign.id !== campaignContext.id) return;
        applyCampaignContext({ ...campaignContext, ...campaign });
        if (workspace) workspace.setCampaign({ id: campaign.id, name: campaign.name, owner: campaignContext.owner });
        syncHall();
    });

    // Presence roster: who is at the table (campaign hall).
    socket.on('players-updated', ({ players } = {}) => {
        hallRoster = Array.isArray(players) ? players : [];
        if (hall.open) renderHall();
    });

    socket.on('campaign-deleted', () => { location.replace('/lobby'); });

    // Journal snapshot (server already filtered to party-visible entries).
    socket.on('journal', (data) => {
        if (!data || typeof data !== 'object') return;
        journalState = {
            entries: Array.isArray(data.entries) ? data.entries : [],
            treasury: (data.treasury && typeof data.treasury === 'object') ? data.treasury : {},
            xp: (data.xp && typeof data.xp === 'object') ? data.xp : { mode: 'milestone', awards: [] }
        };
        if (!Array.isArray(journalState.xp.awards)) journalState.xp.awards = [];
        renderJournalPanel();
        renderHUD(); // treasury + XP line on the sheet
    });
    socket.on('journal-denied', ({ error } = {}) => {
        if (typeof notify === 'function' && error) notify(error);
    });

    // --- Character data for the HUD ---
    socket.on('load-user-characters', (chars) => {
        myCharacters = (Array.isArray(chars) ? chars : []).filter(inPlayingParty);
        if (!myCharacters.find(c => c.id === activeCharId)) {
            activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        }
        renderHUD();
        renderCharacterMenu();
        if (hall.open) renderHall();
        answerStatsPending(); // combat may have arrived before the characters
        syncOwnSenses();
    });

    // Instances tab: where my character tokens sit, across every map. Pushed
    // by the server on any character add/move/delete and re-requested on tab open.
    socket.on('character-instances', (data) => {
        characterInstances = (data && Array.isArray(data.instances)) ? data.instances
            : [];
        if (playingIds.length) {
            characterInstances = characterInstances.filter(entry => playingIds.includes(entry.charId));
        }
        renderInstanceList();
        landOnOwnToken();
    });

    // Party tab: the campaign roster (identity only — the server sends no numbers).
    socket.on('party', (data) => {
        partyMembers = (data && Array.isArray(data.members)) ? data.members : [];
        renderPartyList();
    });

    socket.on('load-homebrew', (hb) => {
        pendingHomebrew = hb;
        if (SRD) { SRD.setHomebrew(hb); renderHUD(); }
    });

    socket.on('character-updated', (char) => {
        if (!char || !char.id) return;
        const i = myCharacters.findIndex(c => c.id === char.id);
        if (i >= 0) myCharacters[i] = char;
        else if (inPlayingParty(char) && (char.owner === myUsername || isHostUser)) myCharacters.push(char);
        renderHUD();
        renderCharacterMenu();
        syncOwnSenses();
    });

    socket.on('character-deleted', (charId) => {
        myCharacters = myCharacters.filter(c => c.id !== charId);
        if (activeCharId === charId) activeCharId = myCharacters[0] ? myCharacters[0].id : null;
        renderHUD();
        renderCharacterMenu();
    });

    // --- Combat sync ---
    socket.on('combat-updated', (combat) => setCombat(combat));
    socket.on('combat-log', (entry) => {
        if (combatTracker) combatTracker.appendLog(entry);
        queueCombatFx(entry, findObjectMesh); // model animation + breath effect
    });
    socket.on('combat-denied', ({ reason }) => notify(reason || 'Not allowed'));

    // Live HP sync: another client (or this one elsewhere) changed current HP.
    socket.on('hp-updated', ({ id, current }) => {
        hpState[id] = current;
        const c = myCharacters.find(x => x.id === id);
        if (c) { if (c.hp) c.hp.current = current; else c.hp = { current }; }
        const a = activeChar();
        if (a && a.id === id) renderHUD();
    });

    // GM-directed camera (View control): fly or snap to a world-space pose the
    // GM chose, optionally locking the controls until camera-unlock. Long jumps
    // snap regardless of mode — a cross-continent glide would drag dozens of
    // floating-origin rebases (and minutes of terrain streaming) behind it.
    function applyViewPose(pose, mode, lock) {
        setViewLock(!!lock);
        const origin = terrain.worldOrigin;
        const dist = Math.hypot(pose.look.x - (controls.target.x + origin.x),
                                pose.look.z - (controls.target.z + origin.z));
        if (mode === 'snap' || dist > 20000) {
            cameraFly.cancel();
            // Re-seat the floating origin at the destination (mirrors the
            // map-state worldCenter landing) so scene coords start near zero.
            // Pockets keep their pinned origin — they live near 0 anyway.
            const o = terrainIsUnified
                ? setWorldOriginAt({ terrain, worldGroup }, pose.look.x, pose.look.z)
                : origin;
            camera.position.set(pose.pos.x - o.x, pose.pos.y, pose.pos.z - o.z);
            controls.target.set(pose.look.x - o.x, pose.look.y, pose.look.z - o.z);
        } else {
            cameraFly.start(pose, origin);
        }
    }
    socket.on('camera-goto', ({ pose, mode, lock, mapKey } = {}) => {
        if (!pose || !pose.pos || !pose.look) return;
        // A GM command supersedes an unfinished Instances jump. If another map
        // state is already in flight, retain the newest GM pose and apply it
        // only after that state has loaded instead of briefly steering the old
        // scene and then being overwritten by the join response.
        const waitingForMap = !!pendingFocus || !!pendingViewPose;
        pendingFocus = null;
        // Relocate: the GM is on another map/tier — join it and land on the pose
        // once that map-state arrives (mirrors focusInstance's pendingFocus).
        if (mapKey && (mapKey !== currentMapKey || waitingForMap)) {
            const needsJoin = mapKey !== currentMapKey;
            currentMapKey = mapKey;
            pendingViewPose = { pose, mode, lock };
            setViewLock(!!lock);
            if (needsJoin) socket.emit('join-map', { key: mapKey });
            return;
        }
        pendingViewPose = null;
        applyViewPose(pose, mode, lock);
    });
    socket.on('camera-unlock', () => {
        // Release also updates a relocation that is still waiting on map-state;
        // otherwise its stale lock flag would re-lock the player on arrival.
        if (pendingViewPose) pendingViewPose.lock = false;
        setViewLock(false);
    });

    // Full map state on connect
    socket.on('map-state', (data) => {
        if (!mapReload.acceptsMapState(data.key, currentMapKey)) return;
        // Campaign stamp: adopt settings/name even if campaign-joined was
        // missed (late loads, room re-joins).
        if (data.campaign) {
            const unchanged = campaignContext && campaignContext.id === data.campaign.id &&
                campaignContext.name === data.campaign.name &&
                JSON.stringify(campaignContext.settings || null) ===
                    JSON.stringify(data.campaign.settings || null);
            if (!unchanged) {
                const first = !campaignContext;
                // The stamp has no hall fields (premise/recap/table state): keep ours.
                applyCampaignContext({ ...(campaignContext || {}), startKey: data.key, ...data.campaign });
                if (first) pendingSpawnLanding = true;
            }
            if (workspace) workspace.setCampaign({ id: data.campaign.id, name: data.campaign.name, owner: data.campaign.owner });
        }
        restorePlayerCutaway();
        levelView.active = 0;
        levelView.isolate = false;
        if (workspace) {
            const location = data.meta && data.meta.name
                ? data.meta.name
                : (data.unified ? 'Shared world' : (data.key || 'World'));
            workspace.setLocation(location);
        }
        // A map switch resets the camera context: abort any GM-directed flight
        // and drop a stale view lock (the GM can re-lock on the new map).
        if (cameraFly) cameraFly.cancel();
        setViewLock(false);
        if (selectedObject) deselectObject();
        if (objectNameplates) objectNameplates.clear(objects);
        objects.forEach(obj => {
            worldGroup.remove(obj);
            disposeBuiltObject(obj);
        });
        objects = [];
        ruler.removeSegments();

        data.objects.forEach(objData => createObjectFromData(objData.id, objData));
        data.rulers.forEach(rulerData => ruler.addFromData(rulerData.id, rulerData));
        setCombat(data.combat || null); // joiners land mid-combat fully synced

        // Pocket-map boundary rectangle (dungeons/rooms).
        if (boundsRect) { scene.remove(boundsRect); boundsRect.geometry.dispose(); boundsRect = null; }
        if (data.meta && data.meta.kind === 'pocket') {
            boundsRect = buildBoundsRect(data.meta.width, data.meta.height);
            scene.add(boundsRect);
        }

        // Terrain.
        if (terrain) {
            // GM-painted hex biomes override generation — players generate the
            // same world locally, so they need the same tag tree.
            if (data.hexTree) { hexTree = data.hexTree; terrain.setBiomeOverrides(hexTree); }
            if (data.unified) {
                // Fog of war: adopt the server's revealed set and show the fog
                // sheet (the server already withheld hidden objects/chunks).
                fogMask.setList(data.fog || []);
                if (fogOverlay) fogOverlay.setAltitude(terrain.fogAltitude);
                if (fogOverlay) fogOverlay.setVisible(true);
                // One continuous world: load once, then fly between provinces.
                const replacesUnified = mapReload.shouldReplaceUnified(terrainIsUnified);
                // Campaign seed + world shape drive local generation (reset
                // picks them up; without a reset, regenerate ground only).
                if (data.campaign && data.campaign.settings &&
                    terrain.applyWorldSettings(data.campaign.settings) &&
                    !replacesUnified && terrainIsUnified) terrain.regenerate();
                if (replacesUnified) {
                    terrain.generatorOn = true;
                    terrain.reset();
                    if (data.terrain) terrain.applyData(data.terrain);
                    terrainIsUnified = true;
                }
                terrain.group.visible = true;
                styleGroundForTerrain(plane, true);
                // The unified world renders at every altitude (LOD rings + ocean):
                // players can zoom out to survey, not just hug the ground.
                // Single-region campaigns stop at the region lens instead.
                const regionDepth = regionRoot()
                    ? Math.max(0, regionRoot().split('/').length - 1) : null;
                controls.maxDistance = regionDepth != null
                    ? TIER_WIDTH[regionDepth] * 8 * 1.6
                    : 811008;
                if (data.worldCenter) {
                    // First entry after a (re)join lands on the campaign spawn.
                    const spawn = pendingSpawnLanding && campaignContext && campaignContext.settings
                        && campaignContext.settings.spawn;
                    const c = spawn || data.worldCenter;
                    // Land with the floating origin already under the province, so
                    // scene coords start near zero however far out the world we are.
                    const o = setWorldOriginAt({ terrain, worldGroup }, c.x, c.z);
                    // Land ON the ground: highlands can stand taller than the
                    // default camera height, which would start it inside a peak.
                    const gy = Math.max(0, terrain.sampleHeight(c.x, c.z));
                    controls.target.set(c.x - o.x, gy, c.z - o.z);
                    camera.position.set(c.x - o.x + 20, gy + 30, c.z - o.z + 20);
                    pendingSpawnLanding = false;
                }
            } else {
                // Pockets are never fogged (entering one means you're inside).
                if (fogOverlay) fogOverlay.setVisible(false);
                // Pockets live near the true origin: pin the floating origin to 0.
                // Generator OFF: pocket ground is implicit flat 0 plus edits.
                setWorldOriginAt({ terrain, worldGroup }, 0, 0);
                terrainIsUnified = false;
                terrain.generatorOn = false;
                controls.maxDistance = 6000;   // finite room: no surveying the void
                terrain.reset();
                const hasTerrain = !!data.terrain;
                if (hasTerrain) terrain.applyData(data.terrain);
                terrain.group.visible = hasTerrain;
                styleGroundForTerrain(plane, hasTerrain);
            }
        }

        // Instances-tab travel: we joined this map to find a token — jump to it
        // (after the terrain/worldCenter landing above so the jump wins).
        if (pendingFocus) { jumpCameraTo(pendingFocus); pendingFocus = null; }
        // A GM "Bring to my view" that crossed maps: land on the pose now that
        // the target map is loaded (snap — we just teleported here).
        if (pendingViewPose) { applyViewPose(pendingViewPose.pose, 'snap', pendingViewPose.lock); pendingViewPose = null; }
        applyPlayerLevelVisibility();
        sentSenses.clear();
        syncOwnSenses();
        mapReload.onMapStateApplied();
    });

    // Live terrain edits from the GM (partial chunk payload).
    socket.on('terrain-updated', (data) => {
        if (terrain) {
            terrain.applyData(data);
            terrain.group.visible = true;
            styleGroundForTerrain(plane, true);
            applyPlayerLevelVisibility();
            updateFlyStances();
        }
    });

    // Regional and pocket resets are published only after the server commits
    // chunks and water together. Apply that canonical result exactly like a
    // live terrain update, then reassert any basement cutaway.
    socket.on('terrain-reset-applied', (data) => {
        const belongsHere = data?.scope === 'map'
            ? data.contextKey === currentMapKey
            : data?.scope === 'province' ? terrainIsUnified : true;
        if (terrain && belongsHere) {
            terrain.applyData(data);
            terrain.group.visible = true;
            styleGroundForTerrain(plane, true);
            applyPlayerLevelVisibility();
            updateFlyStances();
        }
    });

    // Fog of war: the GM revealed or hid regions. Revealed content (objects,
    // terrain chunks) arrives via the normal object-added/terrain-updated
    // events; on hide the server sends object deletes and we drop our copy of
    // any GM-edited chunks there (the ground falls back to the generator).
    socket.on('fog-updated', ({ hexes, revealed }) => {
        if (!Array.isArray(hexes)) return;
        for (const hk of hexes) fogMask.set(hk, revealed);
        if (!revealed && terrain && terrainIsUnified) {
            const hidden = new Set(hexes);
            const del = {};
            for (const [k, c] of terrain.chunks) {
                if (!c.generated && hidden.has(chunkFogHexKey(k))) del[k] = null;
            }
            if (Object.keys(del).length) terrain.applyData({ chunks: del });
        }
    });

    // GM painted/cleared a biome hex: the world regenerates under it.
    // (Debounced — rapid paint strokes coalesce into one heavy rebuild.)
    socket.on('hex-updated', ({ key, hex, biome }) => {
        if (!key || !terrain) return;
        const layer = { ...(hexTree[key] || {}) };
        if (biome) layer[hex] = { biome };
        else delete layer[hex];
        hexTree = { ...hexTree, [key]: layer };
        terrain.setBiomeOverrides(hexTree);
        clearTimeout(regenTimer);
        regenTimer = setTimeout(() => terrain.regenerate(), 400);
    });

    socket.on('object-added', (data) => {
        if (!objects.find(o => o.userData.syncId === data.id)) {
            createObjectFromData(data.id, data);
            syncOwnSenses();
        }
        if (['token', 'character', 'floor', 'stair', 'roof'].includes(data.type)) updateFlyStances();
    });

    socket.on('object-moved', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            object.position.set(data.position.x, data.position.y, data.position.z);
            updateObjectPositionData(object);
            if (selectedObject === object && !playerOwnsObject(object)) renderPlayerSelectionInspector({ open: false });
            updateFlyStances();
        }
    });

    socket.on('object-updated', ({ id, patch } = {}) => {
        const object = objects.find(o => o.userData.syncId === id);
        if (!object || !patch) return;
        const type = object.userData.objectType;
        const geometryChanged = (type === 'wall' &&
            (Object.prototype.hasOwnProperty.call(patch, 'segments') ||
                Object.prototype.hasOwnProperty.call(patch, 'doors'))) ||
            ((type === 'floor' || type === 'roof') &&
                Object.prototype.hasOwnProperty.call(patch, 'tiles'));
        const updated = geometryChanged
            ? replaceObjectGeometry(object, patch)
            : object;
        if (updated === object) updateObjectPresentation(object, patch);
        if (objectNameplates) objectNameplates.sync(objects);
        if (selectedObject === updated && !playerOwnsObject(updated)) renderPlayerSelectionInspector({ open: false });
        if (geometryChanged && ['floor', 'stair', 'roof'].includes(type)) updateFlyStances();
    });

    socket.on('structure-batch-applied', (result) => { applyStructureBatchResult(result); updateFlyStances(); });

    socket.on('object-deleted', (data) => {
        const object = objects.find(o => o.userData.syncId === data.id);
        if (object) {
            if (selectedObject === object) deselectObject();
            if (objectNameplates) objectNameplates.removeFrom(object);
            worldGroup.remove(object);
            disposeBuiltObject(object);
            objects = objects.filter(o => o.userData.syncId !== data.id);
            if (['token', 'character', 'floor', 'stair', 'roof'].includes(object.userData.objectData?.type)) updateFlyStances();
            applyPlayerLevelVisibility();
            if (objectNameplates) objectNameplates.sync(objects);
        }
    });

    socket.on('ruler-added', (data) => {
        if (!ruler.hasSegment(data.id)) {
            ruler.addFromData(data.id, data);
        }
    });

    socket.on('rulers-cleared', () => {
        ruler.removeSegments();
    });

    socket.on('error', (message) => {
        console.error('Erro do servidor:', message);
        login.showError(message);
        login.reset();
    });

    socket.on('disconnect', () => {
        mapReload.onDisconnect();
        console.log('Desconectado do servidor.');
    });
}

// --- Init ---
try {
    init();
} catch (e) {
    console.error('Fatal Error on Init:', e);
}

const login = setupLoginModal(initSocket);

// Load SRD data for the character-sheet HUD (independent of the 3D scene).
loadSRD().then(srd => {
    SRD = srd;
    setTimeout(syncOwnSenses, 0);
    if (pendingHomebrew) SRD.setHomebrew(pendingHomebrew);
    renderHUD();
    answerStatsPending(); // combat may have arrived before the SRD finished loading
}).catch(e => console.error('Failed to load SRD data:', e));

// Monster body-plan manifest; late arrivals swap their disc placeholder in
// place (see shared/monster-models.js).
loadMonsterModels();
