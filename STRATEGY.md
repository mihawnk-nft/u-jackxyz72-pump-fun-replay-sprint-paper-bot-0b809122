# Strategy: Early-Runner

## The market, measured

On the kit's dev window (430 sampled coins, 24h of pump.fun bonding-curve
events, 2 Nov 2026):

- 20% of coins peak at 2x or more, 7% at 5x or more, 13 complete (14.7x).
- The median coin peaks at only 1.23x and then fades back near its start price.
- For 2x+ coins the median time from create to peak is ~126 slots (~50 s);
  the 90th percentile is ~2,267 slots.
- Coins that later peak 2–5x already show, in their first 30 slots, a median
  19 distinct buyers, 28 trades and +8.5 SOL net inflow, at +1.65x. Coins that
  never peak above 1.25x (51% of all coins) show a median 1 buyer, 2 trades
  and +0.05 SOL in the same window.

Conclusion: the money is in the few runners, they announce themselves with
crowd demand within seconds, and entering late means buying the top and
holding the dump.

## Entry (first buy)

A coin is bought once, within 30 slots of its `CreateEvent`, when all of
these hold:

- ≥ 6 distinct non-creator buyers and ≥ 6 trades since create;
- net SOL inflow since create ≥ 2 SOL;
- creator has not sold; creator's own buy in the create slot ≤ 2.5 SOL;
- real SOL reserve between 0.2 and 60 SOL;
- price now between 0.9x and 1.5x of the create price;
- no exit cooldown running on the coin; at most 2 entries per coin per run.

Size: 0.05 SOL (capped at 97% of the 1%-of-real-reserve per-reply cap).
A strong-signal tier (≥ 15 buyers and ≥ 3 SOL net inflow) may buy 0.15 SOL;
in practice the early entry fires first, so the tier rarely applies.
No adds are made by default (`maxAdds: 0`) — sweeps showed loose pyramiding
bought tops and turned winning trips into losers.

## Exits

Liquidation value is the curve value of the tokens still held, curve fees
(95 + 30 bps) deducted, minus one tx fee (105k lamports). The position is
sold whole on the first of:

- **Stop loss** — value ≤ 88% of cost.
- **Hard take-profit** — value ≥ 5x cost (4x over cost).
- **Trailing stop** — once value ≥ 125% of cost, exit on a fall of 30% from
  the best value seen.
- **Partial take-profit** — once, at value ≥ 130% of cost, sell half; the
  rest rides the trailing stop. Most 2x coins retrace to their start, so the
  banked half is what survives.
- **Fade** — net flow over the last 10 slots below −0.5 SOL, but only while
  the position is not yet up (past the trailing arm): a runner's normal
  1-SOL sells must not cut it.
- **Stale / time** — no trade for 400 slots, or held 1,800 slots.
- **Creator sells, or a single sell ≥ 2 SOL, while held.**

Sells go out at 10,000 bps slippage so the exit actually lands; buys use
5,000 bps.

## Costs

A round trip costs ~2.5% in curve fees plus two 105k-lamport tx fees, so
entries below 0.01 SOL are never sent (a 0.01 SOL round trip is ~4.6%
friction). With 0.05 SOL entries the friction is ~2.9% per round trip.

## Guardrail pacing

The run must end with round trips of ≥ 0.01 SOL on ≥ 20 coins. If the bot's
own fills/coins fall behind a prorated pace (30 coins / 300 fills over 24h
of block time), it opens tiny 0.01 SOL probe round trips on the most liquid
coin that traded this batch and sells as soon as the buy lands.

## Results (dev window, local engine port over all three dataset parts)

Final settings, mean over 4 failed-tx keys:

- net PnL ≈ −0.18 SOL, 173 round trips over 167 coins, 39 wins (23%),
  max drawdown ≈ 2%.
- The dev window is hard: every house pilot loses on it too (sniper −0.49,
  reversion −4.02, momentum far worse). The edge is the runner capture, not
  the win rate, so the final-window result depends on how many runners that
  window holds — see `grade-local --stress` for the spread across rebuilt
  copies of this window.

## What was tried and dropped

- Momentum entry at age ≥ 500 slots: buys the top, holds the dump (−9.4 SOL
  on the first third of the window).
- Dip-buying after a 30–45% drawdown: the dip keeps dipping (−4.0 SOL).
- Waiting for 8 buyers / +1 SOL before entering: the fastest runners run
  past the 2.2x run-up cap first.
- Pyramiding adds into strength: turned 35 winning trips into 13.
- Wide trailing stops (50–60%): give back more on moderate winners than
  they save on huge ones.
- Bigger first buys (0.15–0.20 SOL): losses scale faster than winner gains.
