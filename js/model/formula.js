// Formula columns: parse, validate, evaluate. No DOM, no eval().
import { NUMERIC } from './constants.js';

// A tiny arithmetic language: numbers, + - * /, parentheses, unary minus and
// {Column} references. Parsed into a tree once and evaluated per row - there
// is no eval() or Function(), so a formula can only ever produce a number.
// Stored with column ids ({#id}) so renaming a column never breaks it.
export const MAX_FORMULA = 300;

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if ('+-*/()'.includes(c)) { toks.push({ t: c }); i++; continue; }
    if (c === '{') {
      const j = src.indexOf('}', i);
      if (j < 0) throw new Error('A { has no matching }.');
      toks.push({ t: 'ref', v: src.slice(i + 1, j).trim() });
      i = j + 1;
      continue;
    }
    const m = src.slice(i).match(/^(\d+(\.\d+)?|\.\d+)/);
    if (!m) throw new Error(`Unexpected “${c}”. Use numbers, + - * / ( ) and {Column}.`);
    toks.push({ t: 'num', v: Number(m[0]) });
    i += m[0].length;
  }
  return toks;
}

// Recursive descent: expr := term (('+'|'-') term)*, term := unary (('*'|'/') unary)*,
// unary := '-' unary | atom, atom := num | ref | '(' expr ')'
function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]?.t;
  const expr = () => {
    let n = term();
    while (peek() === '+' || peek() === '-') n = { op: toks[p++].t, a: n, b: term() };
    return n;
  };
  const term = () => {
    let n = unary();
    while (peek() === '*' || peek() === '/') n = { op: toks[p++].t, a: n, b: unary() };
    return n;
  };
  const unary = () => (peek() === '-' ? (p++, { op: 'neg', a: unary() }) : atom());
  const atom = () => {
    const tk = toks[p++];
    if (!tk) throw new Error('The formula ends too early.');
    if (tk.t === 'num') return { num: tk.v };
    if (tk.t === 'ref') return { ref: tk.v };
    if (tk.t === '(') {
      const n = expr();
      if (toks[p++]?.t !== ')') throw new Error('A ( has no matching ).');
      return n;
    }
    throw new Error(`Unexpected “${tk.t}”.`);
  };
  if (!toks.length) throw new Error('Enter a formula, e.g. {Revenue} - {Cost}.');
  const tree = expr();
  if (p < toks.length) throw new Error(`Unexpected “${toks[p].t === 'ref' ? `{${toks[p].v}}` : toks[p].v ?? toks[p].t}”.`);
  return tree;
}

const refsOf = n => (n.ref ? [n.ref] : [n.a, n.b].filter(Boolean).flatMap(refsOf));

// {Name} → {#id}. Returns { text, error }.
/** @param {string} text @param {import('./types.js').Column[]} columns @param {string|null} [selfId] @returns {{text: string, error: string|null}} */
export function formulaToIds(text, columns, selfId = null) {
  const src = String(text ?? '').trim().slice(0, MAX_FORMULA);
  try {
    const tree = parseFormula(src);
    for (const r of refsOf(tree)) {
      const col = r.startsWith('#') ? columns.find(c => c.id === r.slice(1)) : columns.find(c => c.name.toLowerCase() === r.toLowerCase());
      if (!col) return { text: src, error: `There's no column called “${r}”.` };
      if (col.id === selfId) return { text: src, error: 'A formula can’t use its own column.' };
      if (!NUMERIC.has(col.type)) return { text: src, error: `“${col.name}” isn't a number or money column.` };
    }
  } catch (e) {
    return { text: src, error: e.message };
  }
  return { text: src.replace(/\{([^}]*)\}/g, (_, r) => {
    const k = r.trim();
    const col = k.startsWith('#') ? columns.find(c => c.id === k.slice(1)) : columns.find(c => c.name.toLowerCase() === k.toLowerCase());
    return `{#${col.id}}`;
  }), error: null };
}

// {#id} → {Name}, for display and editing.
export const formulaToNames = (text, columns) => String(text ?? '').replace(/\{#([\w-]+)\}/g, (_, id) => `{${columns.find(c => c.id === id)?.name ?? '?'}}`);

const compiled = new Map();
function compile(text) {
  if (!compiled.has(text)) {
    let tree = null;
    try { tree = parseFormula(text); } catch { /* invalid: evaluates to blank */ }
    if (compiled.size > 500) compiled.clear();
    compiled.set(text, tree);
  }
  return compiled.get(text);
}

// Finds a loop between formula columns (A uses B, B uses A...). Returns the
// name of a column in the loop, or null. Saving rejects loops; evaluation
// is safe against them regardless (see cellValue).
export function formulaCycle(columns) {
  const byId = new Map(columns.map(c => [c.id, c]));
  const state = new Map(); // 1 = visiting, 2 = done
  const visit = c => {
    if (state.get(c.id) === 2) return null;
    if (state.get(c.id) === 1) return c;
    state.set(c.id, 1);
    const tree = c.type === 'formula' ? compile(c.formula || '') : null;
    for (const r of tree ? refsOf(tree) : []) {
      const dep = byId.get(r.replace(/^#/, ''));
      const hit = dep && visit(dep);
      if (hit) return hit;
    }
    state.set(c.id, 2);
    return null;
  };
  for (const c of columns) {
    const hit = visit(c);
    if (hit) return hit.name;
  }
  return null;
}

// Value of any cell; formulas are computed (blank if any input is blank,
// the formula is invalid, or it divides by zero). Formulas may use other
// formulas: each is computed once per row (memo), a loop evaluates to blank,
// and a work budget caps pathological input, so cost is linear and bounded.
const OVER_BUDGET = Symbol('budget');
/** @param {import('./types.js').TableSection} sec @param {import('./types.js').Column} col @param {import('./types.js').Row} row @returns {string|number|boolean|string[]|null} */
export function cellValue(sec, col, row, ctx = null) {
  if (col.type !== 'formula') return row.v[col.id] ?? null;
  ctx ||= { memo: new Map(), visiting: new Set(), budget: 10000 };
  if (ctx.memo.has(col.id)) return ctx.memo.get(col.id);
  if (ctx.visiting.has(col.id)) return null; // loop
  ctx.visiting.add(col.id);
  const tree = compile(col.formula || '');
  const ev = n => {
    if (--ctx.budget < 0) throw OVER_BUDGET;
    if (n.num != null) return n.num;
    if (n.ref) {
      const c = sec.table.columns.find(x => x.id === n.ref.slice(1));
      const v = c ? cellValue(sec, c, row, ctx) : null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    const a = ev(n.a);
    if (n.op === 'neg') return a == null ? null : -a;
    const b = ev(n.b);
    if (a == null || b == null) return null;
    if (n.op === '/') return b === 0 ? null : a / b;
    return n.op === '+' ? a + b : n.op === '-' ? a - b : a * b;
  };
  let v = null;
  if (tree) {
    try { v = ev(tree); } catch (e) { if (e !== OVER_BUDGET) throw e; v = null; }
  }
  ctx.visiting.delete(col.id);
  v = v == null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
  ctx.memo.set(col.id, v);
  return v;
}

// Why a formula cell is blank, for the settings preview.
export function formulaBlankReason(sec, col, row) {
  if (!compile(col.formula || '')) return 'The formula has an error.';
  if (formulaCycle(sec.table.columns)) return 'Formulas depend on each other in a loop.';
  const refs = refsOf(compile(col.formula));
  const missing = refs.map(r => sec.table.columns.find(c => c.id === r.slice(1))).filter(c => c && cellValue(sec, c, row) == null);
  if (missing.length) return `${missing.map(c => c.name).join(', ')} ${missing.length === 1 ? 'is' : 'are'} blank in this row.`;
  return 'It divides by zero.';
}

// A formula shows as money if it uses any money column. Each column is
// visited once (shared `seen`), so this is linear and loop-safe.
export function formulaUnit(sec, col, seen = new Set()) {
  if (col.type === 'currency') return 'currency';
  if (col.type !== 'formula' || seen.has(col.id)) return 'number';
  seen.add(col.id);
  const tree = compile(col.formula || '');
  return tree && refsOf(tree).some(r => {
    const c = sec.table.columns.find(x => x.id === r.slice(1));
    return c && formulaUnit(sec, c, seen) === 'currency';
  }) ? 'currency' : 'number';
}

