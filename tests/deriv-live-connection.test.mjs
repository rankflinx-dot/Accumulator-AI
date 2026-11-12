import assert from "node:assert/strict";

const endpoint = "wss://api.derivws.com/trading/v1/options/ws/public";
const WebSocketImpl = globalThis.WebSocket;
assert.equal(typeof WebSocketImpl, "function", "Node 22 WebSocket support is required");

const configuredSymbols = ["R_10", "R_25", "R_50", "R_75", "R_100"];
const historyReqs = new Map();
const expectedTicks = new Set(configuredSymbols);
const seenHistory = new Set();
const seenTicks = new Set();
const ws = new WebSocketImpl(endpoint);
let activeCount = 0;
let settled = false;

const finish = error => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { ws.close(); } catch {}
  if (error) {
    console.error("LIVE DERIV CONNECTION TEST FAILED:", error.message);
    process.exitCode = 1;
  } else {
    console.log("LIVE DERIV CONNECTION TEST PASSED:", {
      endpoint,
      activeSymbols: activeCount,
      configuredSymbols,
      historyResponses: [...seenHistory],
      liveTickResponses: [...seenTicks]
    });
  }
};

const timer = setTimeout(() => {
  finish(new Error("Timed out. History received: " + [...seenHistory].join(", ") +
    "; live ticks received: " + [...seenTicks].join(", ")));
}, 35000);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ active_symbols: "brief", req_id: 71001 }));
});

ws.addEventListener("message", event => {
  let msg;
  try { msg = JSON.parse(String(event.data)); }
  catch { return finish(new Error("Deriv returned a non-JSON WebSocket message")); }

  if (msg.error) {
    return finish(new Error("Deriv API error " + (msg.error.code || "") + ": " + (msg.error.message || "unknown")));
  }

  if (msg.msg_type === "active_symbols" || Array.isArray(msg.active_symbols)) {
    const list = Array.isArray(msg.active_symbols) ? msg.active_symbols : [];
    activeCount = list.length;
    const symbols = list.map(item => typeof item === "string" ? item : (item?.underlying_symbol || item?.symbol)).filter(Boolean);
    console.log("Deriv active_symbols response sample:", JSON.stringify(list.slice(0, 3)));
    const missing = configuredSymbols.filter(symbol => !symbols.includes(symbol));
    if (missing.length) {
      return finish(new Error("Deriv returned " + activeCount + " markets but is missing configured symbols: " + missing.join(", ")));
    }
    if (historyReqs.size) return;
    configuredSymbols.forEach((symbol, index) => {
      const reqId = 71100 + index;
      historyReqs.set(reqId, symbol);
      ws.send(JSON.stringify({ ticks_history: symbol, count: 20, end: "latest", style: "ticks", req_id: reqId }));
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 71200 + index }));
    });
    return;
  }

  if (msg.history?.prices || msg.msg_type === "history") {
    const symbol = historyReqs.get(msg.req_id) || msg.echo_req?.ticks_history;
    if (symbol && configuredSymbols.includes(symbol)) {
      if (!Array.isArray(msg.history?.prices) || msg.history.prices.length === 0) {
        return finish(new Error("History response had no prices for " + symbol));
      }
      seenHistory.add(symbol);
    }
  }

  if (msg.tick) {
    const symbol = msg.tick.symbol;
    if (expectedTicks.has(symbol) && Number.isFinite(Number(msg.tick.quote))) seenTicks.add(symbol);
  }

  if (seenHistory.size === configuredSymbols.length && seenTicks.size === configuredSymbols.length) finish();
});

ws.addEventListener("error", () => finish(new Error("WebSocket error before all five market feeds were verified")));
ws.addEventListener("close", event => {
  if (!settled) finish(new Error("Socket closed before test completed (code " + event.code + ", reason " + event.reason + ")"));
});
