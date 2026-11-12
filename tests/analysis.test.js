"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const elements = new Map();
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, value: id === "market" ? "R_10" : id === "timeframe" ? "5" : id === "growth" ? "2" : "",
      textContent: "", innerHTML: "", className: "", disabled: false,
      style: {}, parentElement: { className: "" },
      addEventListener() {}, querySelector() { return element(id + "-child"); },
      getContext() { return {}; }
    });
  }
  return elements.get(id);
}
class FakeWebSocket {
  constructor() { this.readyState = 0; }
  send() {}
  close() { this.readyState = 3; }
}
FakeWebSocket.OPEN = 1;
const windowObject = { addEventListener() {}, scrollTo() {} };
const context = {
  window: windowObject,
  document: { getElementById: element },
  WebSocket: FakeWebSocket,
  console,
  setTimeout: () => 1, clearTimeout() {},
  setInterval: () => 1, clearInterval() {},
  Date, Math, Number, Object, Array, String, JSON
};
vm.runInNewContext(fs.readFileSync("app.js", "utf8"), context, { filename: "app.js" });
const api = windowObject.AccumulatorAI;
assert.ok(api, "analysis API should be exposed for tests");

const ticks = values => values.map((price, i) => ({ price, time: i }));
const flat = Array(300).fill(1000);
const stable = api.evaluateMarket(ticks(flat));
assert.ok(stable, "300 observations should be enough to evaluate");
assert.equal(stable.trend, "SIDEWAYS");
assert.equal(stable.spike, false);
assert.equal(stable.qualified, true);
assert.equal(stable.score, 100);
assert.equal(api.evaluateMarket(ticks(flat), 1).signalWindow, 1);
assert.equal(api.evaluateMarket(ticks(flat), 20).signalWindow, 20);

const rising = api.evaluateMarket(ticks(Array.from({ length: 300 }, (_, i) => 1000 + i * 0.5)));
assert.equal(rising.trend, "BULLISH");
assert.ok(rising.adx > 25);
assert.equal(rising.qualified, false);

const falling = api.evaluateMarket(ticks(Array.from({ length: 300 }, (_, i) => 1000 - i * 0.5)));
assert.equal(falling.trend, "BEARISH");
assert.equal(falling.qualified, false);

const spikePrices = flat.slice();
spikePrices[299] = 1010;
const spike = api.evaluateMarket(ticks(spikePrices));
assert.equal(spike.spike, true);
assert.equal(spike.qualified, false);

const expandingPrices = Array.from({ length: 300 }, (_, i) =>
  1000 + (i < 280 ? (i % 2 ? 0.1 : -0.1) : (i % 2 ? 5 : -5))
);
const expanding = api.evaluateMarket(ticks(expandingPrices));
assert.equal(expanding.bandsExpanding, true);
assert.equal(expanding.atrRising, true);
assert.equal(expanding.qualified, false);

assert.equal(api.evaluateMarket(ticks(flat.slice(0, 99))), null, "insufficient history must not generate a signal");
assert.equal(api.rsi(Array.from({ length: 20 }, (_, i) => i + 1)), 100);
assert.equal(api.rsi(Array.from({ length: 20 }, (_, i) => 20 - i)), 0);
assert.equal(api.rsi(Array(20).fill(5)), 50);
assert.ok(Number.isNaN(api.ema(Array(10).fill(1), 20)));
assert.equal(api.ema(Array(20).fill(7), 20), 7);

for (const result of [stable, rising, falling, spike, expanding]) {
  assert.ok(result.score >= 0 && result.score <= 100, "score must remain within 0–100");
  assert.ok(["SIDEWAYS", "BULLISH", "BEARISH"].includes(result.trend));
}

console.log("Accumulator AI analysis regression tests passed (stable, bullish, bearish, spike, band expansion, ATR rise, RSI, EMA, history threshold, score bounds).");
