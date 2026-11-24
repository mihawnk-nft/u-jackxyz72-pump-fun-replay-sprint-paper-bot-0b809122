# Early-Runner — Pump.fun Replay Sprint Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mihawnk-nft/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mihawnk-nft/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/c/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Best net PnL wins; nothing is traded for real.

## Idea

Most pump.fun coins peak low and fade back to their start price — but about 20% peak at 2x or more, and they peak fast (median ~126 slots after create). The bot therefore:

- **Enters early** — within 30 slots of a coin's creation, only once the launch has proved real crowd demand: at least 6 distinct buyers, 6 trades, and +2 SOL of net inflow since create, with the price still inside 0.9x–1.5x of its create price (buying a coin that already ran 2x in its first minute means buying the top).
- **Banks the move in stages** — sells half at +30%, lets the rest ride a trailing stop, and cuts the whole position at −12% before the cliff. A fade exit fires when net flow turns sharply negative while the position is not yet up.
- **Keeps the guardrails green** — tiny probe round trips pace the run to 20+ coins with round trips ≥ 0.01 SOL, and max drawdown stays far under the 50% cap.

See [STRATEGY.md](STRATEGY.md) for the full design, the measurements behind it, and the dev-window results.

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`).
- `strategy.ts` — the strategy; pure function of the batches, no clock, no randomness, no I/O.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4). Grade locally with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## License

MIT — see [LICENSE](LICENSE).
