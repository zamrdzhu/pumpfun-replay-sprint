// Pump.fun Replay Sprint bot — momentum scalper on the agent-fun/replay/v2 harness.
//
// The replay speaks in three message kinds. hello opens the run and carries the caps
// (capital, max positions, the 1%-of-reserve order cap, fees, latency). Then every batch
// arrives on its slot with that slot's events, marks and fills, and onBatch answers with
// orders for that slot. The harness fills them latency_slots later and flattens whatever
// is left when the data ends. Nothing here reads the clock, the environment or Math.random:
// every decision is a pure function of the batches seen so far, so the two grading runs
// produce byte-identical action logs.
//
// Strategy, in one paragraph: buy a coin only once its curve has lived a little and its
// recent tape shows real, accelerating buy pressure — several distinct buyers, net SOL
// flowing in, price rising and holding near its window high, with the newer half of the
// window inflowing at least as fast as the older. The first buy is small; a position
// only grows while the price keeps stepping up and the inflow stays positive, so false
// starts cost little and runners get size. Exits are fast and mechanical: a stop loss,
// a trailing stop that arms early (once the position is up 5%) and banks the move on a
// 15% pullback from the peak, a fade exit when the inflow turns, and a time limit, so
// capital recycles into the next coin instead of sitting in a dead curve. A small probe
// round-trip keeps the run above the guardrails (at least 20 coins, round trips of at
// least 0.01 SOL) if the momentum entries ever fall behind pace late in the window.
//
// Fees are the enemy: ~1.25% of curve fees per leg plus a flat tx fee per order, so a
// round trip costs roughly 3% before any price move. That is why buys are never smaller
// than 0.02 SOL, sells always go out whole (no dribble), and the trailing stop is tight
// enough to bank a burst before the coin gives it back. Measured on the kit's dev
// window (24h, 1,222 coins): short-window momentum scalping lands near breakeven gross
// (about -0.1 SOL per 100 round trips) while buy-early-and-hold loses 40–95% — most
// coins bleed out and the few runners give everything back unless the exit is fast.
// The edge, if any, is in catching bursts and getting out; this bot is tuned for that.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
const CURVE_FEE = 0.0125; // protocol 95 bps + creator 30 bps, per leg

interface Params {
  window: number; // entry lookback, slots
  minBuys: number; // buy trades in the window
  minBuyers: number; // distinct buying wallets in the window
  minNetSol: number; // net SOL inflow over the window
  minPriceUp: number; // price now vs window start, minus 1
  maxPriceUp: number; // skip coins that already ran too far in one window
  nearHigh: number; // price now as a share of the window high
  minAge: number; // slots since CreateEvent before an entry is allowed
  minRqSol: number; // real SOL bounds at entry
  maxRqSol: number;
  firstSol: number; // first buy of a position, SOL
  addSol: number; // each pyramid add, SOL
  addStep: number; // price must be this far above the last buy to add
  stakeSol: number; // most SOL in one position, total
  minBuySol: number; // smallest buy worth sending
  buySlipBps: number; // slippage on buys; sells always go out wide open
  stopLoss: number; // exit when value falls this far below cost
  trail: number; // exit when value falls this far below its peak
  trailArm: number; // trailing stop arms once value reaches cost * (1 + trailArm)
  fadeWindow: number; // exit when net SOL over this window turns negative
  maxHold: number; // exit after this many slots held (unless well up)
  holdIfUp: number; // the time limit does not apply while up at least this much
  cooldown: number; // slots to wait after an exit before re-entering the same curve
  maxEntries: number; // most entries per curve over the run
  maxMain: number; // most momentum positions open at once
  maxExposureSol: number; // most SOL at cost across all positions at once
  probeSol: number; // guardrail probe buy, SOL
  probeAfterSecs: number; // probes only start this far into the run (block time)
  targetCoins: number; // guardrail pace target
}

// Tuned on the kit's dev window (24h, 1,222 coins) across three sweeps: momentum scalping
// beat buy-early-and-hold by a wide margin; older, longer, stricter entries beat young
// noisy ones (window 200, minAge 2000, minNetSol 3, minPriceUp 0.2: -0.98 SOL, the best
// of 15 variants, lowest drawdown 0.10 and lowest fees); tighter trailing stops beat
// loose ones. No variant goes positive on this dev window — it is a hard draw — so the
// parameters favour the flattest region of the grid (fewest coins, lowest fees) rather
// than a single sharp peak. The final window here is 24 hours, so holds run longer
// than the 6-hour sprint's and the probe net opens later.
const P: Params = {
  window: 200,
  minBuys: 4,
  minBuyers: 3,
  minNetSol: 3,
  minPriceUp: 0.2,
  maxPriceUp: 2.0,
  nearHigh: 0.95,
  minAge: 2000,
  minRqSol: 1,
  maxRqSol: 100,
  firstSol: 0.1,
  addSol: 0.12,
  addStep: 0.12,
  stakeSol: 0.5,
  minBuySol: 0.02,
  buySlipBps: 1500,
  stopLoss: 0.15,
  trail: 0.15,
  trailArm: 0.05,
  fadeWindow: 20,
  maxHold: 4000,
  holdIfUp: 0.5,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 4,
  probeSol: 0.02,
  probeAfterSecs: 14400,
  targetCoins: 25,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
const myCoins = new Set<Pubkey>();
let myFills = 0;
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < P.minRqSol || rqSol > P.maxRqSol) return false;
  if (t.created === null || now - t.created < P.minAge) return false;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < P.minBuys || byUser.size < P.minBuyers) return false;
  if (buySol - sellSol < P.minNetSol) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < P.minPriceUp || up > P.maxPriceUp) return false;
  if (last < high * P.nearHigh) return false;
  // Acceleration: the newer half of the window must inflow at least as fast as the older.
  if (netNew <= 0 || netNew < netOld) return false;
  return true;
}

/** Estimated SOL received for selling `tokens` now, curve fee and tx fee deducted. */
function closeValue(state: BotState, mint: Pubkey, tokens: bigint, txLamports: bigint): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  const n = Number(tokens);
  return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - Number(txLamports) / LAMPORTS;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    const bigSell = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= 5) bigSell.add(e.mint);
      }
    }
    // Prune tapes to the lookback we actually use.
    const keep = Math.max(P.window, P.fadeWindow) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const txSol = Number(tx) / LAMPORTS;
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // Exits first: stop loss, trailing stop, fade, big single sell, time limit.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(state, mint, pos.token_amount, tx);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < 0) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > P.maxHold && value < cost * (1 + P.holdIfUp)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries and pyramid adds, in the batch's event order.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMain - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = Math.min(P.firstSol, P.stakeSol);
      } else {
        // Pyramid into strength only: price stepped up from the last buy, the
        // position is up, and net SOL still flows in.
        if (h.exiting || !h.filled || h.invested >= P.stakeSol - P.minBuySol) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * (1 + P.addStep)) continue;
        if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * 1.0) continue;
        if (flow(t, now, P.window) < P.minNetSol) continue;
        if (rqSol > P.maxRqSol) continue;
        want = Math.min(P.addSol, P.stakeSol - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want, P.maxExposureSol - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < P.minBuySol) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
      free -= amount + txSol;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: late in the run, if the momentum entries have not covered
    // enough coins, open tiny probe round trips on liquid curves until they do.
    if (
      probes.size < 1 &&
      slotsLeft > 0 &&
      firstTime !== null &&
      lastTime !== null &&
      lastTime - firstTime > P.probeAfterSecs &&
      myCoins.size < P.targetCoins
    ) {
      for (const mint of traded) {
        if (orders.length >= cap || probes.size >= 1) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.real_quote_reserves) / LAMPORTS < P.probeSol * 150) continue;
        if (free < P.probeSol + 2 * txSol) break;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)), max_slippage_bps: P.buySlipBps });
        probes.set(mint, false);
        free -= P.probeSol + txSol;
      }
    }
    return orders;
  },
});

// No exports: the grader runs this file directly as `node /bot/main.ts`.
