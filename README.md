# Accumulator AI

A browser-based Deriv market-condition analyzer focused on Accumulator contract research. It reads public market ticks and calculates technical indicators. It does **not** place trades or connect to a trading account.

## Features
- Public Deriv WebSocket tick feed (no API token required for public quotes)
- Volatility 10, 25, 50, 75 and 100 market selection
- Bollinger Bands (20, 2), RSI (14), ATR proxy (14), EMA 20/50
- Tick-direction strength proxy labelled ADX proxy
- Sudden-movement monitor and rule-based 0–100 stability score
- Recent analysis snapshots and responsive dashboard

## Run locally
Open `index.html` in a modern browser, or serve the folder with any static web server.

## Deploy with GitHub Pages
This repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml`.
1. Open **Settings → Pages** in this repository.
2. Set **Build and deployment → Source** to **GitHub Actions**.
3. The workflow deploys the site after pushes to `main`.

## Methodology and limitations
The score is a heuristic, **not a probability of winning**. Low historical volatility does not guarantee that an Accumulator contract will remain within its permitted boundary. ATR and directional-strength calculations are tick-based approximations, not substitutes for full OHLC candle indicators. The growth-rate selector is a display/planning input and does not alter market calculations. Always verify contract-specific growth, barrier, and termination rules in Deriv before trading.

The market feed is public and read-only. No account authentication, order placement, or automated trading is implemented.
