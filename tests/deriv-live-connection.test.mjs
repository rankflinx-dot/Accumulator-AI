import assert from "node:assert/strict";

const endpoint = "wss://api.derivws.com/trading/v1/options/ws/public";
const WebSocketImpl = globalThis.WebSocket;
assert.equal(typeof WebSocketImpl, "function", "Node 22 WebSocket support is required");

const ws = new WebSocketImpl(endpoint);
const contractRequests = new Map();
const historyRequests = new Map();
const eligibleMarkets = new Set();
const seenHistory = new Set();
const seenTicks = new Set();
let activeCount = 0;
let settled = false;
let discoveryStarted = false;
let marketFeedsStarted = false;
let contractQueue = [];

function sendNextContractCheck() {
  if (!contractQueue.length) return;
  const symbol = contractQueue.shift();
  const reqId = 72000 + (activeCount - contractQueue.length - 1);
  contractRequests.set(reqId, symbol);
  ws.send(JSON.stringify({ contracts_for: symbol, req_id: reqId }));
}

const finish = error => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { ws.close(); } catch {}
  if (error) {
    console.error("LIVE DERIV ACCUMULATOR MARKET TEST FAILED:", error.message);
    process.exitCode = 1;
  } else {
    console.log("LIVE DERIV ACCUMULATOR MARKET TEST PASSED:", {
      endpoint,
      activeSymbols: activeCount,\n      indexSymbolsChecked: contractRequests.size + eligibleMarkets.size,
      accumulatorMarkets: [...eligibleMarkets],
      historyResponses: [...seenHistory],
      liveTickResponses: [...seenTicks]
    });
  }
};

const timer = setTimeout(() => {
  finish(new Error("Timed out. Active symbols: " + activeCount +
    "; ACCU markets: " + [...eligibleMarkets].join(", ") +
    "; history: " + [...seenHistory].join(", ") +
    "; live ticks: " + [...seenTicks].join(", ")));
}, 60000);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ active_symbols: "full", req_id: 71001 }));
});

ws.addEventListener("message", event => {
  let msg;
  try { msg = JSON.parse(String(event.data)); }
  catch { return finish(new Error("Deriv returned a non-JSON WebSocket message")); }

  if (msg.error) {
    const failedSymbol = contractRequests.get(msg.req_id) || historyRequests.get(msg.req_id);
    return finish(new Error("Deriv API error for " + (failedSymbol || "request") + " [" +
      (msg.error.code || "unknown") + "]: " + (msg.error.message || "unknown")));
  }

  if ((msg.msg_type === "active_symbols" || Array.isArray(msg.active_symbols)) && !discoveryStarted) {
    discoveryStarted = true;
    const list = Array.isArray(msg.active_symbols) ? msg.active_symbols : [];
    activeCount = list.length;
    const symbols = list.filter(item => item && typeof item === "object" &&
      String(item.underlying_symbol_type || item.symbol_type || "").toLowerCase() === "stockindex")
      .map(item => item.underlying_symbol || item.symbol).filter(Boolean);
    assert.ok(symbols.length > 0, "Deriv must return readable active market symbols");
    console.log("Checking ACCU availability across " + symbols.length + " active Deriv markets");
    contractQueue = symbols.slice();
    sendNextContractCheck();
    return;
  }

  if (msg.msg_type === "contracts_for" || msg.contracts_for) {
    const symbol = contractRequests.get(msg.req_id) || msg.echo_req?.contracts_for;
    if (!symbol) return;
    contractRequests.delete(msg.req_id);
    const contracts = Array.isArray(msg.contracts_for?.available) ? msg.contracts_for.available : [];
    if (contracts.some(item => String(item.contract_type || "").toUpperCase() === "ACCU")) {
      eligibleMarkets.add(symbol);
    }
    if (contractQueue.length) {
      sendNextContractCheck();
    } else if (!marketFeedsStarted && contractRequests.size === 0) {
      marketFeedsStarted = true;
      console.log("Deriv ACCU-enabled symbols:", [...eligibleMarkets]);
      assert.ok(eligibleMarkets.size > 0, "Deriv should report at least one active ACCU market");
      [...eligibleMarkets].forEach((symbol, index) => {
        const reqId = 73000 + index;
        historyRequests.set(reqId, symbol);
        ws.send(JSON.stringify({ ticks_history: symbol, count: 100, end: "latest", style: "ticks", req_id: reqId }));
        ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 74000 + index }));
      });
    }
    return;
  }

  if (msg.history?.prices || msg.msg_type === "history") {
    const symbol = historyRequests.get(msg.req_id) || msg.echo_req?.ticks_history;
    if (symbol && eligibleMarkets.has(symbol)) {
      assert.ok(Array.isArray(msg.history?.prices) && msg.history.prices.length > 0,
        "History response must contain prices for " + symbol);
      seenHistory.add(symbol);
    }
  }

  if (msg.tick) {
    const symbol = msg.tick.symbol;
    if (eligibleMarkets.has(symbol) && Number.isFinite(Number(msg.tick.quote))) seenTicks.add(symbol);
  }

  if (marketFeedsStarted && seenHistory.size === eligibleMarkets.size && seenTicks.size === eligibleMarkets.size) {
    finish();
  }
});

ws.addEventListener("error", () => finish(new Error("WebSocket error before all ACCU market feeds were verified")));
ws.addEventListener("close", event => {
  if (!settled) finish(new Error("Socket closed before test completed (code " + event.code + ", reason " + event.reason + ")"));
});
