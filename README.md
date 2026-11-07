# OGLY

Fund gains in, token supply out.

[![Live site](https://img.shields.io/badge/live-ogly.pro-03b96e?style=for-the-badge)](https://ogly.pro)
[![Chain](https://img.shields.io/badge/chain-Solana-024fa2?style=for-the-badge)](https://solana.com)
[![License](https://img.shields.io/badge/license-MIT-808992?style=for-the-badge)](LICENSE)

| | |
| --- | --- |
| Chain | Solana |
| CA | TBA (pending) |
| Site | https://ogly.pro |

## Overview

OGLY links a trading fund to a token. Half of the realized gains the fund has available is earmarked for buying OGLY on public markets, and every token bought through that share is burned for good.

The site shows live Solana market data at all times, pins OGLY to the first row of its board, and fills each fact slot only from a published record. A slot without a record reads `pending`.

## Features

- Live board of Solana tokens ranked by 24h volume, refreshed every minute and paused while the tab is hidden
- Pinned OGLY row that switches from a brand placeholder to live data once the CA is published
- Full-width CA strip at the top of the page with click-to-copy
- Register-driven facts: each external fact is one record with the state `stated`, `absent` or `unconfirmed`
- Motion with a reduced-motion fallback for every animation

## Links

- Site: https://ogly.pro
- X: pending
- GitHub: pending
- Whitepaper: [docs/whitepaper.md](docs/whitepaper.md)

## Develop

```bash
npm run build   # src/ -> dist/
npm run gates   # build, then run every check
npm run serve   # serve dist/ on port 4173
```

`dist/` is the deploy folder.

## License

MIT. See [LICENSE](LICENSE).
