// Sample data so a new section can be explored before real numbers arrive.
import { today, addDays, round2 } from '../ui.js';
import { makeItem, newRow } from './base.js';

const now = () => Date.now();

// ---------- sample data ----------
export function addSample(sec) {
  let seed = [...sec.template].reduce((a, c) => a + c.charCodeAt(0), 7);
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const t = today();
  const walk = (end, start, days = 90, noise = 0.012) => {
    const h = [];
    for (let i = days - 1; i >= 0; i--) {
      const f = (days - 1 - i) / (days - 1);
      const v = start + (end - start) * f + (i ? (rand() - 0.5) * Math.abs(end) * noise : 0);
      h.push([addDays(t, -i), round2(i ? v : end)]);
    }
    return h;
  };
  const item = (name, note, value, start, extra = {}) => ({ ...makeItem({ name, note, value, ...extra }), history: walk(value, start) });
  sec.sample = true;
  switch (sec.template) {
    case 'accounts':
      sec.items = [
        item('Everyday Checking', 'Sample Bank', 4820.55, 3900),
        item('High-Yield Savings', 'Sample Bank', 18250, 15100),
        item('Rewards Card', 'Sample Card Co.', 1342.18, 900, { liability: true }),
        item('Auto Loan', 'Sample Lender', 9650, 10900, { liability: true }),
      ];
      break;
    case 'investments':
      sec.items = [item('Brokerage', 'Sample Brokerage', 26400, 23100), item('Roth IRA', 'Sample Brokerage', 12800, 11600)];
      break;
    case 'social':
      sec.items = [item('TikTok', '@yourhandle', 12480, 11200), item('Instagram', '@yourhandle', 8930, 8710), item('YouTube', '@yourhandle', 2140, 1890)];
      break;
    case 'goals':
      sec.items = [item('Emergency fund', 'Sample goal', 8200, 6000, { target: 15000 }), item('Trip fund', 'Sample goal', 1300, 400, { target: 4000 })];
      break;
    case 'sales': {
      const [dc, oc, rc] = sec.table.columns;
      sec.rows = [];
      for (let i = 89; i >= 0; i--) {
        const d = addDays(t, -i);
        const wk = [0, 6].includes(new Date(`${d}T12:00`).getDay());
        const orders = Math.max(0, Math.round((wk ? 9 : 6) + (rand() - 0.5) * 7 + (89 - i) / 25));
        sec.rows.push(newRow({ [dc.id]: d, [oc.id]: orders, [rc.id]: round2(orders * (38 + rand() * 18)) }));
      }
      break;
    }
    case 'subscriptions': {
      const [n, c, , r, cat] = sec.table.columns;
      sec.rows = [
        ['Store platform plan', 39, 'Business'], ['Email marketing', 20, 'Business'], ['Video streaming', 15.49, 'Entertainment'],
        ['Music streaming', 10.99, 'Entertainment'], ['Cloud storage', 2.99, 'Software'], ['Gym', 45, 'Personal'],
      ].map(([name, cost, category], i) => newRow({ [n.id]: `${name} (sample)`, [c.id]: cost, [r.id]: addDays(t, 3 + i * 5), [cat.id]: category }));
      break;
    }
    default:
      sec.sample = false;
  }
}

export function clearSample(sec) {
  if (sec.type === 'tracker') sec.items = [];
  else sec.rows = [];
  sec.sample = false;
  sec.updatedAt = now();
}
