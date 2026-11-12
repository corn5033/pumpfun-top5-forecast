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

interface Row { rank: number; mint: string; market_cap_lamports: string | number; complete?: boolean; created_at?: string }
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

// ---- Monte Carlo of the cap race ---------------------------------------------------------------------------------
// Incumbents (the largest coins at the cut) follow a log-cap walk with drift, volatility and a crash hazard fitted on
// the history by (graduated, age) group; coins born after the cut are drawn from the history's own coins (their cap
// curves by age), at the launch rate the history shows. The seven reads are read off every simulated path.
const PATHS = 4000;
const STEP_MS = 10 * 60_000;
const SIM_W = 0.65;
const SIZE_SIM_W = 0.6;
const NI = Math.min(80, last.chart.length);
const MKT_SD = 0.15;

interface Coin { created: number; ages: number[]; caps: number[]; peakRank: number }
const coins = new Map<string, Coin>();
for (const m of marks) {
  m.chart.forEach((r, idx) => {
    const cr = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(cr)) return;
    let c = coins.get(r.mint);
    if (!c) { c = { created: cr, ages: [], caps: [], peakRank: 1e9 }; coins.set(r.mint, c); }
    c.ages.push((m.t - cr) / HOUR);
    c.caps.push(m.logs[idx]!);
    if (idx + 1 < c.peakRank) c.peakRank = idx + 1;
  });
}

const ageBucket = (a: number): number => (a < 2 ? 0 : a < 6 ? 1 : 2);
const groupOf = (grad: boolean, ageH: number): number => (grad ? 3 : 0) + ageBucket(ageH);
interface GStat { n: number; sMu: number; s2: number; sL: number; crash: number; expo: number }
const gs: GStat[] = Array.from({ length: 7 }, () => ({ n: 0, sMu: 0, s2: 0, sL: 0, crash: 0, expo: 0 }));
for (let i = 0; i < marks.length; i++) {
  const o = marks[i]!;
  for (let j = i + 1; j < marks.length; j++) {
    const L = (marks[j]!.t - o.t) / HOUR;
    if (L < 10 / 60 - 1e-9 || L > 4) continue;
    const tg = marks[j]!;
    for (let q = 0; q < Math.min(100, o.chart.length); q++) {
      const row = o.chart[q]!;
      const cr = row.created_at ? Date.parse(row.created_at) : NaN;
      const age = Number.isFinite(cr) ? (o.t - cr) / HOUR : 3;
      const keys = [groupOf(row.complete === true, age), 6];
      const k2 = tg.ranks.get(row.mint);
      for (const key of keys) {
        const g = gs[key]!;
        if (k2 === undefined) { g.crash += 1; g.expo += L; continue; }
        const d = tg.logs[k2 - 1]! - o.logs[q]!;
        g.n += 1; g.sMu += d / L; g.s2 += (d * d) / L; g.sL += L; g.expo += L;
      }
    }
  }
}
/** Shrink a group's fitted (drift/h, sd/sqrt(h), crash/h) toward the pooled fit, and that toward judgement priors. */
function fit(key: number, grad: boolean): { mu: number; sd: number; lam: number } {
  const pr = grad ? { mu: 0, sd: 0.12, lam: 0.02 } : { mu: -0.04, sd: 0.18, lam: 0.06 };
  const est = (g: GStat, base: { mu: number; sd: number; lam: number }, k: number): { mu: number; sd: number; lam: number } => {
    const n = g.n;
    const mu = n > 0 ? g.sMu / n : base.mu;
    const var1 = n > 0 ? Math.max(g.s2 / n - mu * mu * (g.sL / n), 0.25 * g.s2 / n) : base.sd * base.sd;
    const sdv = Math.sqrt(var1);
    const lam = g.expo > 0 ? g.crash / g.expo : base.lam;
    const w = n / (n + k);
    const we = g.expo / (g.expo + k / 6);
    return { mu: w * mu + (1 - w) * base.mu, sd: w * sdv + (1 - w) * base.sd, lam: we * lam + (1 - we) * base.lam };
  };
  const pooled = est(gs[6]!, pr, 40);
  return est(gs[key]!, pooled, 40);
}
const fits: Array<{ mu: number; sd: number; lam: number }> = [];
for (let key = 0; key < 6; key++) fits.push(fit(key, key >= 3));

// templates for newcomers: coins that once ranked in the top 60 of a mark
const templates: Coin[] = [];
for (const c of coins.values()) if (c.peakRank <= 60) templates.push(c);
const t0ms = marks[0]!.t;
const launchRate = templates.length / Math.max(1, (last.t - t0ms) / HOUR); // per hour

function capAt(c: Coin, ageH: number, z: number): number {
  const a = c.ages, v = c.caps, n = a.length;
  if (ageH <= a[0]!) return v[0]!;
  if (ageH >= a[n - 1]!) {
    const f = fits[2]!;
    const extra = ageH - a[n - 1]!;
    return v[n - 1]! + f.mu * extra + f.sd * Math.sqrt(extra) * z;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid]! <= ageH) lo = mid; else hi = mid; }
  const w = (ageH - a[lo]!) / (a[hi]! - a[lo]!);
  return v[lo]! + w * (v[hi]! - v[lo]!);
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20261112);
const norm = (): number => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

const readOffsets = (readTimes.length ? readTimes : [7, 8, 9, 10, 11, 12, 13].map((h) => last.t + h * HOUR))
  .map((t) => Math.max(1, Math.round((t - last.t) / STEP_MS))).sort((a, b) => a - b);
const maxStep = readOffsets[readOffsets.length - 1]!;
const nR = readOffsets.length;
const dtH = STEP_MS / HOUR;
const incCreated = last.chart.slice(0, NI).map((r) => (r.created_at ? Date.parse(r.created_at) : last.t - 3 * HOUR));
const incGrad = last.chart.slice(0, NI).map((r) => r.complete === true);
const incCap0 = last.logs.slice(0, NI);
const simCnt: number[][] = Array.from({ length: NI }, () => new Array<number>(PLACES).fill(0));
const nBins = edges.length + 1;
const simHist: number[][] = Array.from({ length: PLACES }, () => new Array<number>(nBins).fill(0));
function binOf(x: number): number {
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x >= edges[mid]!) lo = mid + 1; else hi = mid; }
  return lo;
}
{
  const tmaxH = maxStep * dtH;
  const readIdx = new Map<number, number>();
  readOffsets.forEach((s, n) => readIdx.set(s, n));
  const snap = new Float64Array(nR * NI);
  for (let p = 0; p < PATHS; p++) {
    const caps = Float64Array.from(incCap0);
    const crashed = new Uint8Array(NI);
    const z0 = norm() * MKT_SD;
    for (let s = 1; s <= maxStep; s++) {
      const h = s * dtH;
      for (let i = 0; i < NI; i++) {
        if (crashed[i]) { caps[i]! += -0.03 * dtH + 0.1 * Math.sqrt(dtH) * norm(); continue; }
        const age = (last.t - incCreated[i]!) / HOUR + h;
        const f = fits[groupOf(incGrad[i]!, age)]!;
        if (rng() < 1 - Math.exp(-f.lam * dtH)) { crashed[i] = 1; caps[i]! -= 0.8 + 1.4 * rng(); }
        else caps[i]! += f.mu * dtH + f.sd * Math.sqrt(dtH) * norm();
      }
      const n = readIdx.get(s);
      if (n !== undefined) for (let i = 0; i < NI; i++) snap[n * NI + i] = caps[i]!;
    }
    // newcomers
    const lam = launchRate * tmaxH;
    let nNew = lam > 50 ? Math.round(lam + Math.sqrt(lam) * norm()) : 0;
    if (lam <= 50) { let L = Math.exp(-lam), k = 0, pr = 1; do { k++; pr *= rng(); } while (pr > L && k < 1000); nNew = k - 1; }
    nNew = Math.max(0, Math.min(nNew, 4000, templates.length ? 4000 : 0));
    const launch = new Float64Array(nNew), off = new Float64Array(nNew), zz = new Float64Array(nNew), tix = new Int32Array(nNew);
    for (let q = 0; q < nNew; q++) {
      launch[q] = rng() * tmaxH; off[q] = norm() * 0.2; zz[q] = norm(); tix[q] = Math.floor(rng() * templates.length);
    }
    for (let n = 0; n < nR; n++) {
      const hN = readOffsets[n]! * dtH;
      const shock = z0 * Math.sqrt(hN / 12);
      const top = new Array<number>(PLACES).fill(-Infinity);
      const who = new Array<number>(PLACES).fill(-1);
      const put = (val: number, id: number): void => {
        if (val <= top[PLACES - 1]!) return;
        let k = PLACES - 1;
        while (k > 0 && top[k - 1]! < val) { top[k] = top[k - 1]!; who[k] = who[k - 1]!; k--; }
        top[k] = val; who[k] = id;
      };
      for (let i = 0; i < NI; i++) put(snap[n * NI + i]! + shock, i);
      for (let q = 0; q < nNew; q++) {
        if (launch[q]! >= hN) continue;
        put(capAt(templates[tix[q]!]!, hN - launch[q]!, zz[q]!) + off[q]! + shock, -1);
      }
      for (let k = 0; k < PLACES; k++) {
        if (who[k]! >= 0) simCnt[who[k]!]![k]! += 1;
        if (top[k]! > -Infinity) simHist[k]![binOf(top[k]!)]! += 1;
      }
    }
  }
}
const simDen = PATHS * nR;

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
    const tr = prob(idx + 1, k, row.complete ? 1 : 0) * (covered ? DAMP_COVERED : DAMP_FAR);
    const sm = idx < NI ? simCnt[idx]![k - 1]! / simDen : 0;
    rows.push({ mint: row.mint, p: idx < NI ? SIM_W * sm + (1 - SIM_W) * tr : tr });
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
  // simulated histogram of this place's cap, smoothed with a small kernel over neighbouring bins
  const h = simHist[place - 1]!;
  const hs = new Array<number>(nBins).fill(0);
  const KW = [0.1, 0.2, 0.4, 0.2, 0.1];
  for (let b = 0; b < nBins; b++) {
    for (let d = -2; d <= 2; d++) {
      const bb = Math.min(nBins - 1, Math.max(0, b + d));
      hs[bb]! += (h[b]! / simDen) * KW[d + 2]!;
    }
  }
  let acc = 0;
  for (let bin = 0; bin <= edges.length; bin++) {
    const lo = bin === 0 ? -Infinity : edges[bin - 1]!;
    const hi = bin === edges.length ? Infinity : edges[bin]!;
    const pn = mix(lo, mean) - mix(hi, mean);
    const p = SIZE_SIM_W * hs[bin]! + (1 - SIZE_SIM_W) * pn;
    const u = Math.floor(p * MICRO);
    if (u > 0 && acc + u <= MICRO) { sizes.push({ place, bin, p: u / MICRO }); acc += u; }
  }
}

writeFileSync(join(OUTPUT_DIR, task.output), `${JSON.stringify({ probabilities, top5, sizes })}\n`);
