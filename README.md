# cbbtc-bounce-bot

A cbBTC trading bot for the make.fun bounty `btc-race-24h-20261115-0828`
("Race a BTC trading bot live for 24 hours").

## Idea

The bot trades Coinbase Wrapped BTC (cbBTC) against USDC with $1,000 of paper
money, long only, one position at a time. It does nothing most of the time:
it waits for a capitulation — a sharp, deep drop — and then buys the turn,
riding the snapback with a wide stop and a profit-armed trailing stop.

Two entry modes, one exit policy:

- **dip** — the price sits at least 0.6% below its 30-bar EMA *and* the
  plunge has paused (the last 5 minutes are flat or up, and the latest bar
  closed up). This buys the bottom of a sell-off, not the middle of it.
- **bounce** — the last hour fell more than 2% *and* the last two hours fell
  more than 2%, and the close crosses back above its 15-bar EMA. This is the
  backup entry for a longer capitulation where the dip-pause never prints.

Exits (both modes): take profit +4%, stop loss -2%, a 0.8% trailing stop
that arms only once the trade is +1% in profit, and a 180-bar time exit.

## Running

Node 22, standard library only:

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (newline-delimited JSON on
stdin/stdout) through the vendored `vendor/makefun-bars.ts` shim. It is fully
deterministic: no clock, no network, no randomness.

## Dev-window result

Graded locally with the kit (`grade-local --driver process`) on the frozen
24-hour dev window: **net PnL +$38.49** (1 trade, max drawdown 0.5%),
against buy-and-hold at -$44.01 on the same window.

## License

MIT. See [LICENSE](LICENSE).
