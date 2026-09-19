// Limits, column kinds and headline modes shared by every model module.
import { today, addDays } from '../ui.js';

export const VERSION = 2;
export const PALETTE_SIZE = 8;
export const MAX_ROWS = 20000; // what forms, imports and connections may add to one table
// A safety net for data that arrives already bigger (another window's merge, a
// tampered backup): normalize keeps up to this many, the newest, never fewer
// than MAX_ROWS, so nothing the app itself added is ever dropped on load.
export const HARD_MAX_ROWS = MAX_ROWS * 2;
export const MAX_HISTORY = 3650;
export const MAX_DELETED = 2000;
export const MAX_NAME = 60;
export const MAX_COL_NAME = 40;
export const EARLIEST = () => addDays(today(), -365 * 30); // oldest date accepted for values
export const MAX_POINTS = 400; // charts downsample beyond this

export const UNITS = { currency: 'Money', number: 'Number', percent: 'Percent' };
export const GOOD = { up: 'Higher is better', down: 'Lower is better', none: 'Neutral' };
export const COLUMN_TYPES = {
  text: 'Text', longtext: 'Long text', number: 'Number', currency: 'Money', date: 'Date',
  select: 'Choice', tags: 'Tags (several choices)', checkbox: 'Checkbox', url: 'Link', formula: 'Formula',
};
export const NUMERIC = new Set(['number', 'currency', 'formula']); // columns whose value is a number
export const ENTERED = new Set(['number', 'currency']); // numbers the user types in
export const GROUPABLE = new Set(['select', 'tags', 'text', 'checkbox']); // can drive a breakdown
export const CHOICES = new Set(['select', 'tags']); // columns with a list of options
export const MAX_TAGS = 20;
export const REMIND_DAYS = [1, 3, 7, 14, 30];
export const HEADLINE_MODES = {
  period: 'Total over the last 30 days',
  sum: 'Total of all rows',
  average: 'Average of all rows',
  count: 'Number of rows',
  progress: 'Checked off',
};
