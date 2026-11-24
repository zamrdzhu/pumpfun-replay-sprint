# Pump.fun Replay Sprint Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zamrdzhu/pumpfun-replay-sprint/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/zamrdzhu/pumpfun-replay-sprint/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. One program, `main.ts` (Node 22, no dependencies), trading 10 SOL of paper money on a 24-hour replay of real pump.fun bonding-curve data. Paper trading only — no real funds, no network, no secrets.

## Strategy

Momentum scalper, tuned on the kit's 24h dev window (1,222 coins) across three sweeps (15 variants):

- **Enter** only on accelerating buy pressure: a mature curve (2,000+ slots old) whose price is up 20%+ over a 200-slot window, sitting near its window high, with 4+ buys from 3+ distinct wallets and 3+ SOL of net inflow — newer half of the window inflowing at least as fast as the older.
- **Size small, pyramid into strength**: first buy 0.1 SOL, adds of 0.12 SOL only while the price keeps stepping up and inflow stays positive, at most 0.5 SOL per coin.
- **Exit fast**: 15% stop loss, a trailing stop that arms once up 5% and banks the move on a 15% pullback from the peak, a fade exit when inflow turns, and a time limit. Capital recycles instead of sitting in dead curves.
- **Guardrails**: tiny probe round-trips keep the run above 20 coins if momentum entries ever fall behind pace.

Why this shape: on the dev window, short-window momentum scalping lands near breakeven gross while buy-early-and-hold loses 40–95% (most coins bleed out; the few runners give everything back unless the exit is fast). No variant goes positive on this dev window — it is a hard draw — so the parameters sit in the flattest region of the grid (fewest coins, lowest fees, lowest drawdown) rather than at a sharp peak. Holds run longer here than in the 6-hour sprint version, matching the 24-hour final window.

## Files

- `main.ts` — the whole strategy (entry signal, exits, probes, sizing).
- `vendor/makefun-bot.ts` — the kit's replay shim, vendored byte-identical.
- `.makefun/owner.json` — the payout wallet that claims this entry.

## Dev grade

`grade-local --driver process` on the kit dev window: **net PnL −0.858 SOL**, 878 fills, 52 coins, 434 round trips, max drawdown 0.086, win rate 0.09. Deterministic: the harness executes the bot twice and the action logs match byte for byte.

## Run it

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

The SDK shim is vendored byte-identical from the kit at `vendor/makefun-bot.ts`.

## License

MIT — see [LICENSE](LICENSE).
