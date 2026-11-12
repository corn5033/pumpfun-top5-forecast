// pump.fun top-5 forecaster (Node 22, standard library only, no network, deterministic).
//
// The scored forecast is one file used at seven reads that come 7 to 13 hours after the history ends, so it must be the
// *horizon-averaged* law of the chart, not a copy of the last mark. Two parts, both fitted on the history it is given:
//   1. order: P(coin now at rank r holds place k later), counted over pairs of marks of the history that lie far apart
//      (the longest horizons it holds), bucketed by rank (and "graduated" for the top ranks), shrunk to a geometric prior
//      around the current rank, damped (the history cannot show the full 7-13 h) and capped. Whatever is left unnamed
//      is the share for coins born after the cut, which no forecast can name.
//   2. sizes: place k's log10 cap (in SOL) is a mixture of two normals around the k-th largest cap now, shifted by the
//      drift seen between far-apart marks, with a spread taken from the same pairs and floored.
//
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const HOUR = 3600_000;

/** Pseudo-count of the geometric prior in each rank bucket. */
const PRIOR_STRENGTH = 8;
const PRIOR_SCALE = 2.5;
const PRIOR_MASS = 0.35;
/** The history is shorter than the 7-13 h to come: damp the counted persistence. */
const DAMP_FAR = 0.7;
/** When the history does cover the horizon, the counted persistence needs little damping. */
const DAMP_COVERED = 0.95;
/** No place names more than this in all: newcomers can always take it. */
const MAX_SUM = 0.85;
const MAX_NAMED = 40;
/**
 * Size spread: floors and the heavy-tail component. The practice history is only 6 marks (50 minutes), too short to
 * tune these on; they are judgement values for a 7-13 hour horizon, where a cap moves far more than in 50 minutes.
 */
const SD_BASE = 0.15;
const SD_PER_ROOT_HOUR = 0.1;
const SD_SCALE = 1.0;
const TAIL_W = 0.12;
const TAIL_W_COVERED = 0.04;
const TAIL_K = 2.3;
const MICRO = 1_000_000;

interface Row { rank: number; mint: string; market_cap_lamports: string | number; complete?: boolean }
interface Mark { t: number; ranks: Map<number | string, number>; chart: Row[]; logs: number[] }

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number; output: string; size: { edges: number[] }; reads?: string[]; history_until?: string;
};
const PLACES = task.places;
const edges = task.size.edges;
const logCap = (v: string | number): number => Math.log10(Number(BigInt(v))) - 9;

const marks: Mark[] = [];
for (const line of readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n')) {
  if (line === '') continue;
  const m = JSON.parse(line) as { at: string; ok: boolean; rows: Row[] | null };
  if (m.ok !== true || !Array.isArray(m.rows) || m.rows.length === 0) continue;
  const chart = [...m.rows].sort((a, b) => a.rank - b.rank);
  const ranks = new Map<number | string, number>();
  chart.forEach((r, i) => ranks.set(r.mint, i + 1));
  marks.push({ t: Date.parse(m.at), ranks, chart, logs: chart.map((r) => logCap(r.market_cap_lamports)) });
}
if (marks.length === 0) throw new Error('the history holds no ok mark');
marks.sort((a, b) => a.t - b.t);
const last = marks[marks.length - 1]!;
const span = last.t - marks[0]!.t;
// How far past the last mark the answer reads lie (task.reads): the pairs counted below should be that far apart.
const readTimes = (task.reads ?? []).map((s) => Date.parse(s)).filter((x) => Number.isFinite(x));
const cutAt = Math.max(last.t, task.history_until ? Date.parse(task.history_until) : last.t);
const hzLo = readTimes.length ? Math.max(0, Math.min(...readTimes) - cutAt) : 6 * HOUR;
const hzHi = readTimes.length ? Math.max(hzLo, Math.max(...readTimes) - cutAt) : 13 * HOUR;
/** The history covers the horizon (the practice: reads within the hour after a 50-minute history). */
const covered = hzHi <= span;

// ---- order: rank-bucket transition counts over far-apart pairs -------------------------------------------------
function bucket(r: number): number {
  if (r <= 10) return r - 1;
  if (r <= 15) return 10;
  if (r <= 25) return 11;
  if (r <= 40) return 12;
  if (r <= 70) return 13;
  return 14;
}
const NB = 15;
const cnt: number[][] = Array.from({ length: NB }, () => new Array<number>(PLACES).fill(0));
const tot: number[] = new Array<number>(NB).fill(0);
// graduated split for the top 10 ranks
const cntG: number[][][] = Array.from({ length: 2 }, () => Array.from({ length: 10 }, () => new Array<number>(PLACES).fill(0)));
const totG: number[][] = Array.from({ length: 2 }, () => new Array<number>(10).fill(0));

const dLo = covered ? Math.max(10 * 60_000, hzLo * 0.8) : Math.max(10 * 60_000, Math.min(hzLo, span * 0.5));
const dHi = covered ? hzHi * 1.0001 : span * 1.0001;
for (let i = 0; i < marks.length; i++) {
  const o = marks[i]!;
  const bins = new Map<number, number[]>();
  for (let j = i + 1; j < marks.length; j++) {
    const dt = marks[j]!.t - o.t;
    if (dt < dLo || dt > dHi) continue;
    const b = Math.floor(dt / (HOUR / 2));
    const a = bins.get(b);
    if (a) a.push(j); else bins.set(b, [j]);
  }
  for (const js of bins.values()) {
    const w = 1 / js.length;
    for (const j of js) {
      const tg = marks[j]!;
      for (let q = 0; q < o.chart.length; q++) {
        const r = q + 1;
        const row = o.chart[q]!;
        const b = bucket(r);
        const k = tg.ranks.get(row.mint);
        tot[b]! += w;
        if (k !== undefined && k <= PLACES) cnt[b]![k - 1]! += w;
        if (r <= 10) {
          const g = row.complete ? 1 : 0;
          totG[g]![r - 1]! += w;
          if (k !== undefined && k <= PLACES) cntG[g]![r - 1]![k - 1]! += w;
        }
      }
    }
  }
}

function prob(r: number, k: number, grad: number): number {
  const b = bucket(r);
  let z = 0;
  for (let q = 1; q <= PLACES; q++) z += Math.exp(-Math.abs(q - r) / PRIOR_SCALE);
  const mass = PRIOR_MASS * Math.exp(-Math.max(0, r - PLACES) / 8);
  const prior = (mass * Math.exp(-Math.abs(k - r) / PRIOR_SCALE)) / (z || 1);
  const base = (cnt[b]![k - 1]! + PRIOR_STRENGTH * prior) / (tot[b]! + PRIOR_STRENGTH);
  if (r > 10) return base;
  return (cntG[grad]![r - 1]![k - 1]! + 6 * base) / (totG[grad]![r - 1]! + 6);
}

const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let k = 1; k <= PLACES; k++) {
  const rows: Array<{ mint: string; p: number }> = [];
  for (let idx = 0; idx < last.chart.length && idx < MAX_NAMED; idx++) {
    const row = last.chart[idx]!;
    rows.push({ mint: row.mint, p: prob(idx + 1, k, row.complete ? 1 : 0) * (covered ? DAMP_COVERED : DAMP_FAR) });
  }
  const sum = rows.reduce((s, x) => s + x.p, 0);
  const scale = sum > MAX_SUM ? MAX_SUM / sum : 1;
  const share = (1 - Math.min(sum, MAX_SUM)) / 100;
  for (const x of rows) {
    const p = Math.floor(x.p * scale * MICRO) / MICRO;
    if (p > share * 1.1 && p >= 0.001) probabilities.push({ mint: x.mint, place: k, p });
  }
}

// top5: best coin per place by the probabilities, greedy
const top5: string[] = [];
const used = new Set<string>();
for (let k = 1; k <= PLACES; k++) {
  let bm = '', bp = -1;
  for (const r of probabilities) {
    if (r.place !== k || used.has(r.mint)) continue;
    if (r.p > bp || (r.p === bp && r.mint < bm)) { bp = r.p; bm = r.mint; }
  }
  if (bm === '') { for (const r of last.chart) if (!used.has(r.mint)) { bm = r.mint; break; } }
  used.add(bm);
  top5.push(bm);
}

// ---- sizes -------------------------------------------------------------------------------------------------------
/** k-th largest log10 cap per mark (null when the mark ranks fewer than k). */
const series: Array<Array<number | null>> = marks.map((m) => Array.from({ length: PLACES }, (_, k) => (m.logs[k] ?? null)));
const deltas: number[] = [];
{
  const lo = covered ? dLo : Math.max(10 * 60_000, span * 0.3);
  const hi = covered ? dHi : Math.max(lo, span * 0.75);
  for (let i = 0; i < marks.length; i++) {
    for (let j = i + 1; j < marks.length; j++) {
      const dt = marks[j]!.t - marks[i]!.t;
      if (dt < lo || dt > hi) continue;
      for (let k = 0; k < PLACES; k++) {
        const a = series[i]![k], b = series[j]![k];
        if (a !== null && b !== null && a !== undefined && b !== undefined) deltas.push(b - a);
      }
    }
  }
}
// Spread of a place's log10 cap grows with the horizon (roughly with its square root): about 0.22 for reads within
// the hour, about 0.47 for reads 10 hours out. A judgement curve, used as the floor and as the default.
const hMid = (hzLo + hzHi) / 2 / HOUR;
const sdHorizon = SD_BASE + SD_PER_ROOT_HOUR * Math.sqrt(hMid);
let mu = 0, sd = sdHorizon;
if (deltas.length >= 10) {
  const m = deltas.reduce((s, x) => s + x, 0) / deltas.length;
  const v = deltas.reduce((s, x) => s + (x - m) * (x - m), 0) / deltas.length;
  mu = Math.min(0.25, Math.max(0, m));
  sd = Math.max(sdHorizon * 0.8, Math.sqrt(v) * SD_SCALE);
}
const tailW = covered ? TAIL_W_COVERED : TAIL_W;

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const above = (x: number, mean: number, s: number): number => (x === -Infinity ? 1 : x === Infinity ? 0 : 0.5 * erfc((x - mean) / (s * Math.SQRT2)));
const mix = (x: number, mean: number): number => (1 - tailW) * above(x, mean, sd) + tailW * above(x, mean, sd * TAIL_K);

const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let place = 1; place <= PLACES; place++) {
  const cur = last.logs[place - 1] ?? last.logs[last.logs.length - 1]!;
  const mean = cur + mu;
  let acc = 0;
  for (let bin = 0; bin <= edges.length; bin++) {
    const lo = bin === 0 ? -Infinity : edges[bin - 1]!;
    const hi = bin === edges.length ? Infinity : edges[bin]!;
    const u = Math.floor((mix(lo, mean) - mix(hi, mean)) * MICRO);
    if (u > 0 && acc + u <= MICRO) { sizes.push({ place, bin, p: u / MICRO }); acc += u; }
  }
}

writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
