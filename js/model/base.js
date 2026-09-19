// The small constructors and helpers every other model module builds on.
import { sid, today, round2 } from '../ui.js';
import { MAX_COL_NAME } from './constants.js';

const now = () => Date.now();
export const clampStr = (v, n, fallback = '') => String(v ?? fallback).slice(0, n);

export const makeColumn = (name, type, options = [], formula = '') => ({ id: sid(8), name, type, options, ...(type === 'formula' ? { formula } : {}) });

export function makeItem({ name, note = '', value = 0, liability = false, target = null }) {
  return { id: sid(), name, note, value: round2(value), liability, target, source: null, updatedAt: now(), history: [[today(), round2(value)]] };
}

export function newRow(v = {}) {
  const t = now();
  return { id: sid(), v, createdAt: t, updatedAt: t };
}

// Marks a section/item/row as changed.
export function touch(x) {
  x.updatedAt = now();
  x.rev = (x.rev || 0) + 1;
  return x;
}

export function uniqueName(taken, name) {
  const has = n => (taken instanceof Set ? taken.has(n.toLowerCase()) : taken.some(t => t.toLowerCase() === n.toLowerCase()));
  if (!has(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const n = name.slice(0, MAX_COL_NAME - suffix.length) + suffix;
    if (!has(n)) return n;
  }
}
