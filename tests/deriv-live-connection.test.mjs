import assert from "node:assert/strict";

const endpoint = "wss://api.derivws.com/trading/v1/options/ws/public";
const WebSocketImpl = globalThis.WebSocket;
assert.equal(typeof WebSocketImpl, "function", "Node 22 WebSocket support is required");

const timeoutMs = 35000;
const ws = new WebSocketImpl(endpoint);
const seen = new Set();
let chosenSymbol = null;
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
      endpoint, activeSymbols: activeCount, testedSymbol: chosenSymbol, responses: [...seen]
    });
  }
};

const timer = setTimeout(() => {
  finish(new Error("Timed out waiting for Deriv responses. Received: " + [...seen].join(", ")));
}, timeoutMs);

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
    console.log("Deriv active_symbols response sample:", JSON.stringify(list.slice(0, 3)));
    const symbols = list.map(item => typeof item === "string" ? item : (item?.underlying_symbol || item?.symbol)).filter(Boolean);
    chosenSymbol = symbols.find(s => s === "R_10") || symbols.find(s => s === "1HZ100V") || symbols[0];
    if (!chosenSymbol) return finish(new Error("active_symbols returned " + activeCount + " rows but no readable symbol"));
    if (seen.has("active_symbols")) return;
    seen.add("active_symbols");
    ws.send(JSON.stringify({ ticks_history: chosenSymbol, count: 20, end: "latest", style: "ticks", req_id: 71002 }));
    ws.send(JSON.stringify({ ticks: chosenSymbol, subscribe: 1, req_id: 71003 }));
    return;
  }

  if ((msg.msg_type === "history" || msg.history?.prices) &&
      (msg.req_id === 71002 || msg.echo_req?.ticks_history === chosenSymbol)) {
    if (!Array.isArray(msg.history?.prices) || msg.history.prices.length === 0) {
      return finish(new Error("History response had no prices for " + chosenSymbol));
    }
    seen.add("history");
  }

  if (msg.msg_type === "tick" || msg.tick) {
    if (msg.tick?.symbol === chosenSymbol && Number.isFinite(Number(msg.tick.quote))) seen.add("tick");
  }

  if (seen.has("active_symbols") && seen.has("history") && seen.has("tick")) finish();
});

ws.addEventListener("error", () => finish(new Error("WebSocket error before all responses arrived")));
ws.addEventListener("close", event => {
  if (!settled) finish(new Error("Socket closed before test completed (code " + event.code + ", reason " + event.reason + ")"));
});
