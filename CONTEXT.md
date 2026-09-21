# CONTEXT — glossary

Shared words for this repo (ADAMANT tradebot running JITOSOL/USDT on Coinstore). One line each; deeper docs linked.

## Bot modules and settings

- **MM (market-making)** — the bot's volume engine (`trade/mm_trader.js`). Its **MM policy** decides how volume is made.
- **`optimal` policy** — with liq on, 80% of MM trades go into the real order book (mm-book), 20% self-trade in the
  spread. Pays the spread on most trades. Cause of the Jun–Sep 2026 loss.
- **`spread` policy** — every MM trade is a self-trade inside the spread (maker + taker at the same price). Pays no
  spread; makes no volume when the book has no gap. Risk: another bot fills the maker order first
  ("third-party bot intervention").
- **executeInOrderBook / mm-book / mm-taker** — an MM trade that crosses into other people's orders (buys the ask,
  sells the bid).
- **executeInSpread / self-trade / mm-self** — an MM trade the bot matches with itself inside the spread.
- **liq (liquidity provider)** — resting bid/ask orders around the price (`trade/mm_liquidity_provider.js`).
- **PW (Price watcher)** — the fair-price band the bot trades within (`trade/mm_price_watcher.js`); primary source
  `JITOSOL/USDT@OKX`.
- **Fair price** — midpoint of the PW range (before deviation), the reference every fill is measured against.
- **Coefficient** — JitoSOL/SOL ratio, used only when the PW source is a SOL pair.

## Forensics terms (docs/FORENSICS.md)

- **Fill** — part or all of an order actually traded.
- **Edge vs fair** — sell: (price − fair) × amount; buy: (fair − price) × amount, at the moment of the fill.
  Negative = traded worse than fair.
- **Markout** — the same, measured against the fair price N minutes *after* the fill. Much worse than edge = picked
  off (someone knew the price was about to move).
- **Result vs holding** — value now compared with never trading. Splits into edge + **inventory** (holding more or less
  coin than at the start while its price moved).
- **Reconciliation / trust check** — does the rebuilt wallet match the real one? Value gap small = the diagnosis can
  be trusted.
- **One-sided** — one balance (USDT or coin) is empty, so liq can only quote the other side (`0 bids` / `0 asks`).
- **Wash trading** — trading with yourself to show volume. What `spread` does; check exchange rules.
