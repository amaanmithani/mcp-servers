/**
 * Generate data/sample.db: a small, fully synthetic orders database.
 * All data is produced here from a seeded PRNG (no real people or companies),
 * so the output is deterministic and free of licensing concerns.
 *
 *   npx tsx scripts/make-sample-db.ts [outPath]
 */
import Database from 'better-sqlite3';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'data/sample.db');

// mulberry32: tiny deterministic PRNG.
let seed = 0x5eed1234;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = [
  'Ada',
  'Bram',
  'Cleo',
  'Dev',
  'Eun',
  'Faro',
  'Gita',
  'Hugo',
  'Ines',
  'Jun',
  'Kai',
  'Lena',
  'Milo',
  'Nia',
  'Omar',
  'Pia',
  'Ravi',
  'Sana',
  'Teo',
  'Uma',
];
const LAST = [
  'Stone',
  'Vale',
  'Reed',
  'Marsh',
  'Frost',
  'Hale',
  'Brook',
  'Wren',
  'Pike',
  'Lark',
  'Moss',
  'Quill',
];
const CITIES = [
  'Northport',
  'Easton',
  'Southfield',
  'Westbury',
  'Lakeside',
  'Hillcrest',
  'Riverton',
  'Oakdale',
];
const CATEGORIES = ['books', 'garden', 'kitchen', 'outdoor', 'stationery', 'toys'];
const ADJ = ['Compact', 'Deluxe', 'Everyday', 'Classic', 'Travel', 'Pro', 'Mini', 'Heavy-duty'];
const NOUN = [
  'Notebook',
  'Trowel',
  'Kettle',
  'Lantern',
  'Puzzle',
  'Planter',
  'Mug',
  'Backpack',
  'Pen set',
  'Tent',
];
const STATUS = [
  'placed',
  'shipped',
  'delivered',
  'delivered',
  'delivered',
  'returned',
  'cancelled',
];

mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
const db = new Database(out);
db.pragma('journal_mode = DELETE');
db.exec(`
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0)
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  ordered_at TEXT NOT NULL
);
CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_items_product ON order_items(product_id);
CREATE VIEW order_totals AS
  SELECT o.id AS order_id, o.customer_id, o.status, o.ordered_at,
         SUM(i.quantity * i.unit_price_cents) AS total_cents
  FROM orders o JOIN order_items i ON i.order_id = o.id
  GROUP BY o.id;
`);

const day = (offset: number): string =>
  new Date(Date.UTC(2025, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

const N_CUSTOMERS = 200;
const N_PRODUCTS = 60;
const N_ORDERS = 1500;

db.transaction(() => {
  const insC = db.prepare('INSERT INTO customers VALUES (?,?,?,?,?)');
  for (let i = 1; i <= N_CUSTOMERS; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    insC.run(
      i,
      `${first} ${last}`,
      `${first}.${last}.${i}@example.test`.toLowerCase(),
      pick(CITIES),
      day(int(0, 180)),
    );
  }
  const insP = db.prepare('INSERT INTO products VALUES (?,?,?,?)');
  const prices: number[] = [0];
  for (let i = 1; i <= N_PRODUCTS; i++) {
    const price = int(3, 150) * 100 - 1;
    prices.push(price);
    insP.run(i, `${pick(ADJ)} ${pick(NOUN)}`, pick(CATEGORIES), price);
  }
  const insO = db.prepare('INSERT INTO orders VALUES (?,?,?,?)');
  const insI = db.prepare('INSERT INTO order_items VALUES (?,?,?,?)');
  for (let i = 1; i <= N_ORDERS; i++) {
    insO.run(i, int(1, N_CUSTOMERS), pick(STATUS), day(int(10, 364)));
    const used = new Set<number>();
    const lines = int(1, 4);
    for (let l = 0; l < lines; l++) {
      const pid = int(1, N_PRODUCTS);
      if (used.has(pid)) continue;
      used.add(pid);
      insI.run(i, pid, int(1, 5), prices[pid]);
    }
  }
})();
db.exec('VACUUM');
db.close();
console.log(`wrote ${out} (${statSync(out).size} bytes)`);
