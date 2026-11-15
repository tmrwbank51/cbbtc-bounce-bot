// cbbtc-bounce-bot: a capitulation-bounce bot for cbBTC/USDC.
//
// The bot speaks agent-fun/bars-replay/v1 through the vendored shim: the
// harness sends one hello, then one batch per minute (one bar, the fills of
// the orders decided on the previous batch, and the account), and the bot
// answers every batch with exactly one reply carrying its orders. Orders
// decided on a batch fill at the next bar's open, so every decision is made
// on closes the bot has already seen.
//
// Strategy: do nothing most of the time. The dev window is a slow grind
// down with one sharp capitulation and snapback, and every trend-following
// baseline loses on it. This bot waits for the capitulation and buys the
// turn, in one of two ways:
//
//   dip    — the close sits at least 0.6% below its 30-bar EMA *and* the
//            plunge has paused (the last 5 minutes are flat or up, and the
//            latest bar closed up). Buys the bottom of a sell-off, not the
//            middle of it.
//   bounce — the last hour fell more than 2% *and* the last two hours fell
//            more than 2%, and the close crosses back above its 15-bar EMA.
//            The backup entry for a longer capitulation where the dip-pause
//            never prints.
//
// Both modes take a full-size position (all cash) and share one exit policy:
// take profit +4%, stop loss -2%, a 0.8% trailing stop that arms only once
// the trade is +1% in profit, and a 180-bar time exit. One open position,
// long only, no leverage.
//
// The bot is fully deterministic: its only inputs are the bars the harness
// sends, it never reads the clock, the environment, or any randomness, so
// two executions on the same data produce the same orders byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 150;

// Entry thresholds.
const DIP_BPS = 0.006; // close this far below the 30-bar EMA
const PAUSE_R5 = -0.002; // 5-minute return must be at least this (not plunging)
const CAP_60 = -0.02; // 60-minute return for the bounce entry
const CAP_120 = -0.02; // 120-minute return for the bounce entry

// Exit policy, shared by both entry modes.
const TAKE_PROFIT = 0.04;
const STOP_LOSS = -0.02;
const TRAIL_BPS = 0.008;
const TRAIL_ARM = 0.01; // trailing stop arms once the trade is this far up
const MAX_HOLD_BARS = 180;

const EMA_FAST = 15;
const EMA_SLOW = 30;
// Bars to wait after an exit decision before a new entry may fire, so a
// stop-loss is not re-bought on the very next bar while its signal is
// still true.
const REENTRY_COOLDOWN_BARS = 5;

class BounceBot {
  // Every CBBTC close seen so far, in dollars per cbBTC, with the EMA
  // values that went with each bar (kept so a cross can be tested against
  // the previous bar's close and the previous bar's EMA, not the current one).
  private closes: number[] = [];
  private opens: number[] = [];
  private emaFastHist: number[] = [];
  private emaFast = 0;
  private emaSlow = 0;
  private haveEma = false;

  // Open-trade bookkeeping, filled in from the harness's fill reports.
  private entryPrice = 0;
  private entrySeq = -1;
  private trailPeak = 0;
  private lastExitSeq = -100;

  private retOver(barsBack: number): number {
    const n = this.closes.length;
    if (n < 2) return 0;
    const now = this.closes[n - 1];
    const then = this.closes[Math.max(0, n - 1 - barsBack)];
    return now / then - 1;
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1. Fold in this batch's bar, if CBBTC traded this minute.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const open = Number(bar.o) / 1e6;
      const close = Number(bar.c) / 1e6;
      this.opens.push(open);
      this.closes.push(close);
      if (!this.haveEma) {
        this.emaFast = close;
        this.emaSlow = close;
        this.haveEma = true;
      } else {
        const kFast = 2 / (EMA_FAST + 1);
        const kSlow = 2 / (EMA_SLOW + 1);
        this.emaFast = close * kFast + this.emaFast * (1 - kFast);
        this.emaSlow = close * kSlow + this.emaSlow * (1 - kSlow);
      }
      this.emaFastHist.push(this.emaFast);
    }
    if (this.closes.length === 0) return [];

    // 2. Fold in this batch's fills: a filled buy opens the trade.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        this.entryPrice = Number(fill.price) / 1e6;
        this.entrySeq = state.seq;
        this.trailPeak = this.entryPrice;
      }
    }

    const close = this.closes[this.closes.length - 1];
    const position = state.positions.get(SYMBOL);
    const qty = position === undefined ? 0n : position.qty;

    // 3. In a position: manage the exit.
    if (qty > 0n && this.entryPrice > 0) {
      if (close > this.trailPeak) this.trailPeak = close;
      const ret = close / this.entryPrice - 1;
      let why = '';
      if (ret >= TAKE_PROFIT) why = 'take-profit';
      else if (ret <= STOP_LOSS) why = 'stop-loss';
      else if (ret > TRAIL_ARM && close < this.trailPeak * (1 - TRAIL_BPS)) why = 'trailing-stop';
      else if (state.seq - this.entrySeq >= MAX_HOLD_BARS) why = 'time-exit';
      if (why !== '') {
        this.entryPrice = 0;
        this.lastExitSeq = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // 4. Flat and not warming up: look for an entry.
    if (state.warmingUp) return [];
    if (state.seq - this.lastExitSeq < REENTRY_COOLDOWN_BARS) return [];
    if (state.cash < 1_000_000n) return []; // below the $1 minimum notional

    const n = this.closes.length;
    const open = this.opens[n - 1];
    const dipSignal =
      close / this.emaSlow - 1 < -DIP_BPS &&
      this.retOver(5) >= PAUSE_R5 &&
      close >= open;
    // Cross above the fast EMA: previous close at or below the previous
    // fast EMA, current close above the current fast EMA.
    const prevEmaFast = n >= 2 ? this.emaFastHist[n - 2] : this.emaFast;
    const prevClose = n >= 2 ? this.closes[n - 2] : close;
    const crossedUp = prevClose <= prevEmaFast && close > this.emaFast;
    const bounceSignal =
      this.retOver(60) < CAP_60 &&
      this.retOver(120) < CAP_120 &&
      crossedUp;

    if (dipSignal || bounceSignal) {
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional < 1_000_000n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }
}

const bot = new BounceBot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
