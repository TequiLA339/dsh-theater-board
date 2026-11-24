// Presentation-equivalent normalization only, never fuzzy business aliases.
export const normalizeHeader = value => String(value ?? '').trim().replace(/\u3000/g, ' ').replace(/（/g, '(').replace(/）/g, ')');
