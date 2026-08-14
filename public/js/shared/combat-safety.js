// Pure render-boundary helpers for combat data. Socket mutations are already
// bounded server-side, but older persisted combats may predate those checks.

export function combatNumber(value, { fallback = 0, min = -1000000, max = 1000000 } = {}) {
    const numeric = (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
        ? Number(value)
        : NaN;
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
}

export function combatInteger(value, options = {}) {
    return Math.round(combatNumber(value, options));
}

export function combatModifier(value) {
    const modifier = combatInteger(value, { fallback: 0, min: -1000, max: 1000 });
    return modifier >= 0 ? `+${modifier}` : String(modifier);
}

export function combatSpellLevel(value) {
    return combatInteger(value, { fallback: 0, min: 0, max: 9 });
}

export function combatCssColor(value, fallback = '#dd4444') {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const numeric = Math.max(0, Math.min(0xffffff, Math.round(value)));
        return `#${numeric.toString(16).padStart(6, '0')}`;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}
