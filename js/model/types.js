// Type definitions for HQ's data, for editors and reviewers (JSDoc; nothing
// here runs, and the app never loads this file). Other modules refer to
// these as `import('./model/types.js').Section` and so on.
//
// Everything below lives inside the encrypted vault and passes through
// normalize() on every load, which enforces these shapes.

/** @typedef {'text'|'longtext'|'number'|'currency'|'date'|'select'|'tags'|'checkbox'|'url'|'formula'} ColumnType */

/**
 * @typedef {object} Column
 * @property {string} id        stable id ([\w-]{1,64}); formulas refer to columns as {#id}
 * @property {string} name      unique within the table (case-insensitive)
 * @property {ColumnType} type
 * @property {string[]} options choices for select/tags columns
 * @property {string} [formula] formula columns only, e.g. "{#a1b2} * 12"
 */

/**
 * A table row. Cell values by column id: number for number/currency, ISO
 * date string, boolean, string[] for tags, string otherwise. Formula cells
 * are computed (cellValue) and never stored.
 * @typedef {object} Row
 * @property {string} id
 * @property {Record<string, string|number|boolean|string[]|null>} v
 * @property {{kind:'connector', ext:string}|null} [source] set when a connection filled it
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} [rev]
 */

/**
 * A tracker item: one current value plus its dated history.
 * @typedef {object} Item
 * @property {string} id
 * @property {string} name
 * @property {string} note
 * @property {number} value
 * @property {boolean} liability  money owed (subtracted from net worth)
 * @property {number|null} target goal, shows a progress bar
 * @property {Array<[string, number]>} history  [ISO date, value], oldest first, one per day
 * @property {{kind:'connector', ext:string}|null} source
 * @property {number|null} updatedAt
 * @property {number} rev
 */

/**
 * @typedef {object} SectionBase
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {string} template   which built-in template it came from, or 'custom'
 * @property {number} color      palette index
 * @property {boolean} home      shown on Home
 * @property {boolean} sample    holds sample data
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} rev
 */

/**
 * @typedef {SectionBase & {type:'tracker', tracker:{unit:'currency'|'number'|'percent', netWorth:boolean, good:'up'|'down'|'none'}, items:Item[]}} TrackerSection
 */

/**
 * @typedef {object} TableSetup
 * @property {Column[]} columns
 * @property {{mode:'period'|'sum'|'average'|'count'|'progress', column:string|null, dateColumn:string|null}} headline
 * @property {{column:string|null}} breakdown
 * @property {{column:string|null, days:number, repeat:'none'|'monthly'|'yearly'}} remind
 */

/** @typedef {SectionBase & {type:'table', table:TableSetup, rows:Row[]}} TableSection */

/** @typedef {TrackerSection|TableSection} Section */

/**
 * A live connection (see connectors.js). `secrets` never leave the vault
 * except to their own service or your relay.
 * @typedef {object} Connection
 * @property {string} id
 * @property {'youtube'|'instagram'|'tiktok'|'shopify'|'banks'|'custom'|'customrows'} kind
 * @property {string} name
 * @property {Record<string, string>} secrets
 * @property {number|null} secretsAt   when the keys were entered (some expire)
 * @property {string|null} target      section id it fills
 * @property {string|null} cursor      ISO date to resume from
 * @property {{lastTry:number|null, lastOk:number|null, error:string|null, summary:{added:number, updated:number, warning:string|null}|null}} status
 */

/**
 * Everything in the vault.
 * @typedef {object} Data
 * @property {2} version
 * @property {{name:string}} profile
 * @property {{currency:string, autoLockMin:number, staleDays:number, privacy:boolean, theme:'system'|'light'|'dark', syncHours:number}} settings
 * @property {Section[]} sections
 * @property {Connection[]} connections
 * @property {{url:string, token:string, snapKey:{pub:string, priv:{kty:'EC', crv:'P-256', x:string, y:string, d:string}}|null}} relay
 * @property {Array<{kind:string, id:string, sec:string|null, at:number}>} deleted  tombstones
 * @property {number|null} deletedBefore  tombstones older than this were pruned
 * @property {Array<{id:string, title:string, problem:string, at:number, hash:string|null, missing:boolean}>} quarantine
 * @property {number} createdAt
 */

export {};
