// Rolling-origin sanity backtest on a history.ndjson (the practice history is only 6 marks, so this is a check that
// the whole path runs and beats persistence on what little there is, not a tuning set).
//   node eval.mjs <input dir> [main.ts]
// For each origin mark i (>= MIN_TRAIN marks before it) the history is cut after i and every later mark is an "answer
// read" whose chart is that mark's top 100. Order score + size score per the rules (log, floor 1e-4, unnamed share).
// Rows naming mints the cut history never names are impossible here (the forecast only names the cut chart).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const inDir = resolve(process.argv[2] ?? 'input');
const mainPath = resolve(process.argv[3] ?? 'main.ts');
const MIN_TRAIN = Number(process.env.MIN_TRAIN ?? 3);
const lines = readFileSync(join(inDir, 'history.ndjson'), 'utf8').split('\n').filter(Boolean);
const recs = lines.map((l) => JSON.parse(l));
const task0 = JSON.parse(readFileSync(join(inDir, 'task.json'), 'utf8'));
const edges = task0.size.edges;
const lg = (v) => Math.log10(Number(BigInt(v))) - 9;
const binOf = (x) => { let b = 0; while (b < edges.length && x >= edges[b]) b++; return b; };
const f = (p) => Math.log(Math.max(p, 1e-4));

function score(fc, read) {
  const chart = [...read.rows].sort((a, b) => a.rank - b.rank).slice(0, 100);
  let order = 0, size = 0;
  for (let k = 1; k <= 5; k++) {
    const rows = fc.probabilities.filter((x) => x.place === k);
    const named = new Map(rows.map((x) => [x.mint, x.p]));
    const sum = rows.reduce((a, x) => a + x.p, 0);
    const un = chart.filter((c) => !named.has(c.mint)).length;
    const c = chart[k - 1];
    if (!c) continue;
    order += f(named.has(c.mint) ? named.get(c.mint) : (1 - sum) / Math.max(1, un));
    const srows = fc.sizes.filter((x) => x.place === k);
    const sm = new Map(srows.map((x) => [x.bin, x.p]));
    const ssum = srows.reduce((a, x) => a + x.p, 0);
    const b = binOf(lg(c.market_cap_lamports));
    size += f(sm.has(b) ? sm.get(b) : (1 - ssum) / (edges.length + 1 - srows.length));
  }
  return { order, size };
}

const res = [];
for (let i = MIN_TRAIN; i < recs.length - 1; i++) {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-'));
  mkdirSync(join(tmp, 'in')); mkdirSync(join(tmp, 'out'));
  writeFileSync(join(tmp, 'in', 'history.ndjson'), lines.slice(0, i + 1).join('\n') + '\n');
  const later = recs.slice(i + 1).map((r) => r.at);
  writeFileSync(join(tmp, 'in', 'task.json'), JSON.stringify({ ...task0, marks: i + 1, history_until: recs[i].at, reads: later }));
  execFileSync('node', [mainPath], { env: { ...process.env, MAKEFUN_INPUT_DIR: join(tmp, 'in'), MAKEFUN_OUTPUT_DIR: join(tmp, 'out') } });
  const fc = JSON.parse(readFileSync(join(tmp, 'out', task0.output), 'utf8'));
  const sc = recs.slice(i + 1).filter((r) => r.rows.length).map((r) => score(fc, r));
  const m = (k) => sc.reduce((a, x) => a + x[k], 0) / sc.length;
  res.push({ i, n: sc.length, order: m('order'), size: m('size') });
}
for (const r of res) console.log(`origin ${r.i} reads ${r.n} order ${r.order.toFixed(2)} size ${r.size.toFixed(2)} total ${(r.order + r.size).toFixed(2)}`);
const mean = (k) => res.reduce((a, x) => a + x[k], 0) / res.length;
console.log(`mean order ${mean('order').toFixed(3)} size ${mean('size').toFixed(3)} total ${(mean('order') + mean('size')).toFixed(3)}`);
