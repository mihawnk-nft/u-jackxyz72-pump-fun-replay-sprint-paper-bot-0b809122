// Early-runner bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Thesis (measured on the kit's dev window, 430 sampled coins):
//   - 20% of coins peak at 2x or more, 7% at 5x or more, but the median coin peaks
//     only 1.23x and then fades back near its start price. The money is in the few
//     runners, and they peak fast: for 2x+ coins the median time from create to peak
//     is ~126 slots (~50s). Entering late (hundreds of slots after create) means
//     buying the top and holding the dump.
//   - The runners announce themselves early, but the announcement is cheap: coins
//     that later peak 2-5x already show a median 19 distinct buyers and +8.5 SOL
//     net inflow in their first 30 slots, while coins that never peak above 1.25x
//     (51% of all coins) show a median 1 buyer and +0.05 SOL. Entry therefore
//     needs at least 6 distinct buyers, 6 trades and +2 SOL of net inflow since
//     create, must fire within 30 slots of create, and only while the price is
//     still inside 0.9x-1.5x of its create price: buying a coin that already ran
//     2x+ in its first minute means buying the top. Sweeps on the full dev window
//     confirmed each tightening step (later entry, looser run-up, fewer buyers)
//     costs net PnL; the chosen point sits on the flat part of that curve with
//     ~170 round trips, rather than at the extreme end where the trip count
//     collapses and the result becomes one lottery ticket.
//   - Adds only pyramid into strength: the price must be 10% above the last buy
//     and the position already up 5%, so adds never chase a top. (Loose adds were
//     the biggest leak in testing: they turned 35 winning trips into 13.)
//   - Exits bank the move in stages: sell half at +50% (most 2x coins retrace to
//     their start, so the banked half is what survives), let the rest ride a
//     trailing stop, and cut the whole position at -12% before the cliff. A round
//     trip costs ~2.5% in curve fees plus two 105k-lamport tx fees, so entries
//     below 0.01 SOL are never sent.
//   - Guardrail pacing: the run must end with round trips on >= 20 coins. If the
//     bot's own fills/coins fall behind a prorated pace, it opens tiny probe round
//     trips on the most liquid coin that traded this batch.
//
// Pure function of the batches: no clock, no randomness, no I/O. Iteration is over
// insertion-ordered maps, so the two graded executions agree byte for byte.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** First-buy window: youngest/oldest age (slots since create) at entry. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve window at first buy (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Distinct non-creator buyers that must have traded since create. */
  minBuyers: number;
  /** Trades that must have been seen since create. */
  minTrades: number;
  /** Net SOL inflow since create that must have arrived (lamports). */
  minNetSol: bigint;
  /** Creator's own buy in the create slot must be at most this (lamports). */
  maxDevBuy: bigint;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Price now over create price at entry: window (bps, 10000 = 1x). */
  minRunupBps: number;
  maxRunupBps: number;
  /** Recent-flow window (slots) for adds. */
  flowWindow: number;
  /** Net SOL over the flow window an add needs (lamports). */
  addNetSol: bigint;
  /** Target SOL per coin in total; first buy and each add (lamports). */
  stakeLamports: bigint;
  firstBuyLamports: bigint;
  addLamports: bigint;
  /** Strong-signal first buy: when buyers and net inflow since create reach these, buy this much instead. */
  strongMinBuyers: number;
  strongMinNetSol: bigint;
  strongFirstBuyLamports: bigint;
  /** Most adds after the first buy. */
  maxAdds: number;
  /** An add needs the price at least this far above the last buy (bps). */
  addStepBps: number;
  /** An add needs the position's value at least this far over its cost (bps). */
  addIfUpBps: number;
  /** Slots to wait after a buy before the next add. */
  addDelay: number;
  /** Smallest buy worth the tx fee (lamports). */
  minBuyLamports: bigint;
  /** Slippage allowed on buys (bps). Sells go out wide open. */
  buySlippageBps: number;
  /** Exit when liquidation value falls to this share of cost (bps). */
  stopBps: number;
  /** First take-profit: sell this share of the position at this much over cost (bps). */
  tp1Bps: number;
  tp1PartBps: number;
  /** Hard take-profit: sell all at this much over cost (bps). */
  takeProfitBps: number;
  /** Trailing stop: arms once value is this far over cost; exits on a fall of trailBps from the peak value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the creator sells while we hold. */
  exitOnDevSell: boolean;
  /** Exit when a single recorded sell is at least this many lamports. */
  bigSellLamports: bigint;
  /** Exit when net flow over fadeWindow slots falls below minus this (lamports). 0 = off. */
  fadeWindow: number;
  fadeExitSol: bigint;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Most first-buys of one coin over the run. */
  maxEntries: number;
  /** Most new first-buys per batch. */
  maxEntriesPerBatch: number;
  /** Guardrail pacing targets over the window (block-time seconds). */
  paceCoins: number;
  paceFills: number;
  paceSecs: number;
  probeLamports: bigint;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 30,
  minRealSol: 200_000_000n,
  maxRealSol: 60_000_000_000n,
  minBuyers: 6,
  minTrades: 6,
  minNetSol: 2_000_000_000n,
  maxDevBuy: 2_500_000_000n,
  skipDevSold: true,
  minRunupBps: 9_000,
  maxRunupBps: 15_000,
  flowWindow: 30,
  addNetSol: 500_000_000n,
  stakeLamports: 200_000_000n,
  firstBuyLamports: 50_000_000n,
  addLamports: 50_000_000n,
  strongMinBuyers: 15,
  strongMinNetSol: 3_000_000_000n,
  strongFirstBuyLamports: 150_000_000n,
  maxAdds: 0,
  addStepBps: 1_000,
  addIfUpBps: 500,
  addDelay: 3,
  minBuyLamports: 10_000_000n,
  buySlippageBps: 5_000,
  stopBps: 1_200,
  tp1Bps: 3_000,
  tp1PartBps: 5_000,
  takeProfitBps: 40_000,
  trailArmBps: 2_500,
  trailBps: 3_000,
  maxHold: 1800,
  staleSlots: 400,
  exitOnDevSell: true,
  bigSellLamports: 2_000_000_000n,
  fadeWindow: 10,
  fadeExitSol: 500_000_000n,
  cooldownSlots: 300,
  maxEntries: 2,
  maxEntriesPerBatch: 3,
  paceCoins: 30,
  paceFills: 300,
  paceSecs: 86_400,
  probeLamports: 10_000_000n,
  maxProbes: 1,
};

const BPS = 10_000n;
const FEE_BPS = 125n; // protocol 95 + creator 30

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  sold: bigint;
  lastTradeSlot: number;
  recent: Tick[];
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  complete: boolean;
  /** First buys decided on this coin over the run. */
  entries: number;
}

interface Held {
  openedSlot: number;
  /** Best liquidation value seen (lamports). */
  best: bigint;
  /** SOL sent in buys so far (lamports). */
  spent: bigint;
  adds: number;
  lastBuySlot: number;
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  exiting: boolean;
  tookPartial: boolean;
  /** Liquidation value at the latest batch (lamports). */
  lastValue: bigint;
}

/** What selling `tokens` against (vq, vt) pays after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight: mint -> true once its sell is out. */
  const probes = new Map<Pubkey, boolean>();
  const selling = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let myFills = 0;
  const myCoins = new Set<Pubkey>();

  function coinOf(mint: Pubkey): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint, createSlot: -1, creator: '', vq0: 0n, vt0: 1n, devBuy: 0n, devSold: false,
        trades: 0, buyers: new Set(), bought: 0n, sold: 0n, lastTradeSlot: -1,
        recent: [], coolUntil: -1, complete: false, entries: 0,
      };
      coins.set(mint, c);
    }
    return c;
  }

  /** Net flow over the last `w` slots; prunes ticks older than any window. */
  function flow(c: Coin, slot: number, w: number = p.flowWindow): bigint {
    const keep = Math.max(p.flowWindow, p.fadeWindow);
    const pruneFrom = slot - keep;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= pruneFrom) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    const from = slot - w;
    let net = 0n;
    for (const t of c.recent) {
      if (t.slot <= from) continue;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const touched: Pubkey[] = [];
      let bigSellMint: Pubkey | null = null;

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > nowTime) nowTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = BigInt(e.sol_amount);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          if (e.is_buy) {
            c.bought += sol;
            if (e.user === c.creator && e.slot === c.createSlot) c.devBuy += sol;
            else if (e.user !== c.creator) c.buyers.add(e.user);
          } else {
            c.sold += sol;
            if (e.user === c.creator) c.devSold = true;
            if (sol >= p.bigSellLamports) bigSellMint = e.mint;
          }
          if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
        } else {
          const c = coinOf(e.mint);
          c.complete = true;
        }
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills += 1;
          myCoins.add(f.mint);
        }
        if (f.side === 'sell' && f.status === 'filled' && !state.positions.has(f.mint)) {
          const c = coins.get(f.mint);
          if (c !== undefined) c.coolUntil = slot + p.cooldownSlots;
          held.delete(f.mint);
          selling.delete(f.mint);
        }
        if (f.side === 'sell') selling.delete(f.mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) probes.delete(mint);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // ---- 1. Exits on held positions (value checked against cost). ----
      for (const [mint, pos] of [...state.positions.entries()].sort()) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || probes.has(mint)) continue;
        const c = coins.get(mint);
        const h = held.get(mint) ?? {
          openedSlot: slot, best: 0n, spent: pos.cost_lamports, adds: 0,
          lastBuySlot: slot, lastBuyVq: 0n, lastBuyVt: 1n, exiting: false, tookPartial: false, lastValue: 0n,
        };
        if (!held.has(mint)) held.set(mint, h);
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = sellValue(pos.token_amount, r.vq, r.vt) - tx;
        const basis = pos.cost_lamports;
        if (value > h.best) h.best = value;
        h.lastValue = value;
        // Bank half at +50%: most 2x coins retrace to their start, so the banked
        // half is what survives; the rest rides the trailing stop.
        if (!h.tookPartial && basis > 0n && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
          const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
          if (part > 0n && part < pos.token_amount && !hasPending(state, mint, 'sell')) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            selling.add(mint);
            h.tookPartial = true;
            h.best = 0n;
            continue;
          }
        }
        let exit = false;
        if (basis > 0n) {
          if (value * BPS <= basis * (BPS - BigInt(p.stopBps))) exit = true; // stop loss
          if (value * BPS >= basis * (BPS + BigInt(p.takeProfitBps))) exit = true; // bank 4x
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true; // trailing
        }
        if (slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined) {
          if (slot - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (bigSellMint === mint) exit = true;
          if (p.fadeExitSol > 0n && flow(c, slot, p.fadeWindow) < -p.fadeExitSol && value * BPS < basis * (BPS + BigInt(p.trailArmBps))) exit = true;
        }
        if (!exit) continue;
        if (hasPending(state, mint, 'sell')) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        h.exiting = true;
      }

      // ---- 2. Probe exits: sell the probe as soon as its buy landed. ----
      for (const [mint, isSelling] of [...probes.entries()]) {
        if (orders.length >= cap) break;
        if (isSelling) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined || hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell')) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        probes.set(mint, true);
      }

      // ---- 3. Adds: pyramid only into strength (price +10%, position +5%, inflow positive). ----
      let free = state.freeCashLamports();
      for (const [mint, h] of [...held.entries()]) {
        if (orders.length >= cap) break;
        if (h.exiting || h.adds >= p.maxAdds) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (hasPending(state, mint, 'buy') || hasPending(state, mint, 'sell') || selling.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined || c.complete) continue;
        if (slot - h.lastBuySlot < p.addDelay) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (h.lastBuyVq > 0n && vq * h.lastBuyVt * BPS < h.lastBuyVq * vt * (BPS + BigInt(p.addStepBps))) continue;
        if (pos.cost_lamports > 0n && h.lastValue * BPS < pos.cost_lamports * (BPS + BigInt(p.addIfUpBps))) continue;
        if (flow(c, slot) < p.addNetSol) continue;
        const room = p.stakeLamports - h.spent;
        if (room < p.minBuyLamports) continue;
        let amount = p.addLamports < room ? p.addLamports : room;
        const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        h.spent += amount;
        h.adds += 1;
        h.lastBuySlot = slot;
        h.lastBuyVq = vq;
        h.lastBuyVt = vt;
      }

      // ---- 4. New first buys: early, on a young coin with real crowd demand. ----
      let entries = 0;
      let open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || hasPending(state, mint, 'buy') || probes.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined || c.complete) continue;
        if (c.createSlot < 0 || slot - c.createSlot < p.minAge || slot - c.createSlot > p.maxAge) continue;
        if (slot < c.coolUntil || c.entries >= p.maxEntries) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < p.minRealSol || rq > p.maxRealSol) continue;
        if (c.devSold && p.skipDevSold) continue;
        if (c.devBuy > p.maxDevBuy) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) continue;
        if (c.bought - c.sold < p.minNetSol) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup < BigInt(p.minRunupBps) || runup > BigInt(p.maxRunupBps)) continue;
        let amount = c.buyers.size >= p.strongMinBuyers && c.bought - c.sold >= p.strongMinNetSol
          ? p.strongFirstBuyLamports
          : p.firstBuyLamports;
        const sizeCap = (state.maxBuyLamports(mint) * 97n) / 100n;
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        c.entries += 1;
        held.set(mint, {
          openedSlot: slot, best: 0n, spent: amount, adds: 0,
          lastBuySlot: slot, lastBuyVq: curve.virtual_quote_reserves, lastBuyVt: curve.virtual_token_reserves,
          exiting: false, tookPartial: false, lastValue: 0n,
        });
        entries++;
        open++;
      }

      // ---- 5. Guardrail pacing: tiny probe round trips when fills/coins lag. ----
      if (probes.size < p.maxProbes && firstTime !== null && nowTime > firstTime) {
        const pace = Math.min(1, (nowTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.paceCoins * pace);
        const needFills = myFills < Math.ceil(p.paceFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeLamports * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < (minRq * 3n) / 2n) continue;
            if (free < p.probeLamports + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: p.probeLamports, max_slippage_bps: p.buySlippageBps });
            probes.set(mint, false);
            free -= p.probeLamports + tx;
          }
        }
      }

      return orders;
    },
  };
}
