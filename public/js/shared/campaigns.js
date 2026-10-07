// campaigns.js — campaign context helpers shared by the lobby, GM, player and
// creator screens. Campaign names/descriptions are user text: always render
// through escHtml (or textContent) — a stored-XSS surface like homebrew.

export function escHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// The tabletop screens require a campaign (`/gm?campaign=<id>`); without one
// they redirect to the lobby. The creator treats a missing id as "show picker".
export function readCampaignId() {
    const raw = new URLSearchParams(window.location.search).get('campaign');
    return raw && /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : null;
}

// Entry-as-character selection from the lobby (`&chars=id1,id2`).
export function readPlayingIds() {
    const raw = new URLSearchParams(window.location.search).get('chars');
    if (!raw) return null;
    const ids = raw.split(',').map(part => part.trim())
        .filter(id => /^[A-Za-z0-9_-]{1,80}$/.test(id));
    return ids.length ? ids : null;
}

export function pagePath(page, campaignId, extra = {}) {
    const params = new URLSearchParams();
    if (campaignId) params.set('campaign', campaignId);
    for (const [key, value] of Object.entries(extra)) {
        if (value != null && value !== '') params.set(key, value);
    }
    const query = params.toString();
    return query ? `${page}?${query}` : page;
}

export const MAP_STYLE_LABELS = {
    ladder: 'Grand campaign',
    region: 'Single region'
};

export function campaignStyleLabel(settings) {
    return MAP_STYLE_LABELS[settings && settings.mapStyle] || MAP_STYLE_LABELS.ladder;
}
