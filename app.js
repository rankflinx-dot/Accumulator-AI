(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = {
    ws:null, ticks:[], market:"R_10", connected:false, history:[],
    reconnectTimer:null, pingTimer:null, dataTimer:null, activeSymbolsTimer:null, connectTimer:null, marketFeedTimer:null, marketFeedQueue:[], requestId:1, subscriptionIds:[], lastMessageAt:0, lastTickAt:0, reconnectAttempts:0, contractRequests:{}, pendingContracts:0, contractQueue:[], activeSymbolDetails:{},
    historyLoaded:false, availableSymbols:null, scanData:{}, scanReady:false, scannerRequested:false, scannerRunning:false, historyRequests:{}, liveSymbols:new Set(), lastServerMessage:"No server message received", lastRequest:""
  };
  let names = {};
  const fmt = n => Number.isFinite(n) ? n.toFixed(2) : "—";
  function isVolatilityIndex(item) {
    if(!item || typeof item!=="object") return false;
    const symbol=String(item.underlying_symbol || item.symbol || "").toUpperCase();
    const name=String(item.underlying_symbol_name || item.display_name || "").toLowerCase();
    const type=String(item.underlying_symbol_type || item.symbol_type || "").toLowerCase();
    return /^R_\d+$/.test(symbol) || /^1HZ\d+V$/.test(symbol) || (type==="stockindex" && /volatility/.test(name));
  }
  function marketDisplayName(detail,symbol) {
    const supplied=detail && (detail.underlying_symbol_name || detail.display_name);
    if(/^1HZ/i.test(symbol)) {
      if(supplied && /\b1s\b|\(1s\)/i.test(supplied)) return supplied;
      const match=String(symbol).match(/^1HZ(\d+)V$/i);
      return "Volatility "+(match ? match[1] : symbol)+" (1s) Index";
    }
    if(supplied) return supplied;
    const match=String(symbol).match(/^R_(\d+)$/i);
    return "Volatility "+(match ? match[1] : symbol)+" Index";
  }
  const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN;
  const std = a => { const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };

  function setConnection(status,label) {
    const dot=$("connectionDot");
    if(dot && dot.parentElement) dot.parentElement.className="connection "+status;
    if($("connectionText")) $("connectionText").textContent=label;
  }
  function send(payload) {
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN) return false;
    const req_id=state.requestId++;
    if(payload.ticks_history)state.historyRequests[req_id]=payload.ticks_history;
    try { state.lastRequest=Object.keys(payload)[0]||"unknown"; state.ws.send(JSON.stringify({...payload,req_id})); return true; }
    catch(error) { delete state.historyRequests[req_id]; return false; }
  }
  function startPing() {
    clearInterval(state.pingTimer);
    state.pingTimer=setInterval(()=>{
      if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
      if(state.lastMessageAt && Date.now()-state.lastMessageAt>45000){
        // Do not close a socket merely because the public feed has gone quiet.
        // A local close here produced browser code 1005 and hid the original
        // missing-history/tick problem behind an endless reconnect loop.
        setConnection("error","Deriv socket is still open · no new server message for 45 seconds · waiting for market data");
      }
      send({ping:1});
    },15000);
  }
  function forgetSubscriptions() {
    for(const id of state.subscriptionIds) send({forget:id});
    state.subscriptionIds=[];
  }

  function requestNextContractCheck() {
    if(!state.contractQueue.length)return;
    const symbol=state.contractQueue.shift();
    const req_id=state.requestId++;
    state.contractRequests[req_id]=symbol;
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
    state.ws.send(JSON.stringify({contracts_for:symbol,req_id}));
  }
  function finishContractDiscovery() {
    const eligible=Object.keys(names).sort((a,b)=>(names[a]||a).localeCompare(names[b]||b));
    if(!eligible.length) {
      $("market").disabled=true;
      $("market").innerHTML='<option value="">No volatility indices support ACCU</option>';
      setConnection("connected","Deriv connected · no active ACCU markets found");
      $("scannerStatus").textContent="Checked "+state.availableSymbols.length+" active volatility indices (plain and 1s). None currently offer contract_type ACCU.";
      $("bestMarket").textContent="NO ACCUMULATOR MARKETS";
      $("bestMarketDetail").textContent="Deriv returned no eligible plain or 1-second volatility indices.";
      $("marketCards").innerHTML="<div class=\"scan-card\"><b>Contract availability checked</b><strong>NO ACCU MARKETS</strong><small>No plain or 1s volatility index currently offers Accumulator contracts</small></div>";
      return;
    }
    const first=eligible[0];
    state.market=eligible.includes(state.market)?state.market:first;
    $("market").innerHTML=eligible.map(symbol=>'<option value="'+symbol+'">'+names[symbol]+' ('+symbol+')</option>').join("");
    $("market").disabled=false;
    $("market").value=state.market;
    $("marketName").textContent=names[state.market];
    $("scannerStatus").textContent="Verified "+eligible.length+" ACCU-enabled volatility indices (plain + 1s). Press Start AI Scanner to begin.";
    $("bestMarket").textContent="READY TO SCAN";
    $("bestMarketDetail").textContent="Deriv connection is ready. Start the scanner to evaluate every eligible index.";
    $("startScanner").disabled=false;
    $("startScanner").textContent=state.scannerRequested?"Resume AI Scanner":"Start AI Scanner";
    setConnection("connected","Deriv connected · "+eligible.length+" Accumulator indices verified");
    if(state.scannerRequested) startAllMarketScans();
  }

  function startAllMarketScans() {
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN || !Object.keys(names).length)return;
    state.scannerRequested=true;
    state.scannerRunning=true;
    $("startScanner").disabled=false;
    $("startScanner").textContent="Stop AI Scanner";
    forgetSubscriptions();
    state.scanReady=false;
    state.scanData={};
    state.liveSymbols.clear();
    state.ticks=[];
    $("useRecommended").disabled=true;
    state.historyLoaded=false;
    const symbols=Object.keys(names);
    $("scannerStatus").textContent="Scanning all "+symbols.length+" Deriv indices that offer Accumulator (ACCU) contracts · collecting history and live ticks";
    $("bestMarket").textContent="Scanning markets…";
    $("bestMarketDetail").textContent="Waiting for enough live observations";
    $("marketCards").innerHTML=symbols.map(symbol=>'<div class="scan-card" id="scan-'+symbol+'"><b>'+names[symbol]+'</b><strong>Loading…</strong><small>Fetching current data</small></div>').join("");
    if(!symbols.length) {
      $("scannerStatus").textContent="Deriv did not report any currently active markets offering ACCU contracts. No market will be recommended.";
      $("bestMarket").textContent="NO ACCUMULATOR MARKETS";
      $("bestMarketDetail").textContent="No active symbol currently reports contract type ACCU.";
      $("marketCards").innerHTML="<div class=\"scan-card\"><b>No eligible markets</b><strong>NO ACCU CONTRACTS</strong><small>Waiting for Deriv contract availability</small></div>";
      return;
    }
    const select=$("market");
    const previous=select.value;
    select.innerHTML=symbols.map(symbol=>'<option value="'+symbol+'">'+names[symbol]+' ('+symbol+')</option>').join("");
    state.market=symbols.includes(previous)?previous:symbols[0];
    select.value=state.market;
    $("marketName").textContent=names[state.market];
    // Stagger requests instead of flooding the public socket with every
    // history request and tick subscription at once.
    clearTimeout(state.marketFeedTimer);
    state.marketFeedQueue=symbols.slice();
    state.scanReady=true;
    const sendNextMarketFeed=()=>{
      if(!state.ws || state.ws.readyState!==WebSocket.OPEN || !state.marketFeedQueue.length)return;
      const symbol=state.marketFeedQueue.shift();
      state.scanData[symbol]={ticks:[],metrics:null,status:"Requesting history and live feed"};
      const historySent=send({ticks_history:symbol,adjust_start_time:1,count:300,end:"latest",style:"ticks"});
      const streamSent=send({ticks:symbol,subscribe:1});
      if(!historySent || !streamSent) state.scanData[symbol].status="Request could not be sent";
      if(state.marketFeedQueue.length) {
        state.marketFeedTimer=setTimeout(sendNextMarketFeed,350);
      } else {
        state.marketFeedTimer=null;
      }
    };
    sendNextMarketFeed();
  }
  function stopAllMarketScans() {
    state.scannerRequested=false;
    state.scannerRunning=false;
    clearTimeout(state.marketFeedTimer);
    state.marketFeedQueue=[];
    forgetSubscriptions();
    $("startScanner").disabled=!state.connected || !Object.keys(names).length;
    $("startScanner").textContent="Start AI Scanner";
    $("scannerStatus").textContent="AI scanner stopped. Deriv remains connected; press Start AI Scanner to scan again.";
    $("bestMarket").textContent="SCANNER STOPPED";
    $("bestMarketDetail").textContent="No market recommendation is active.";
    $("useRecommended").disabled=true;
  }
  function renderScanner() {
    if(!state.scannerRunning)return;
    const horizon=Number($("timeframe").value)||5;
    const rows=Object.entries(state.scanData).map(([symbol,data])=>({symbol,data,metrics:evaluateMarket(data.ticks,horizon)}));
    rows.forEach(row=>{
      row.data.metrics=row.metrics;
      const card=$("scan-"+row.symbol);
      if(!card)return;
      if(!row.metrics) {
        card.innerHTML='<b>'+names[row.symbol]+'</b><strong>Collecting data</strong><small>'+row.data.ticks.length+' ticks · need 100</small>';
        return;
      }
      const m=row.metrics;
      card.innerHTML='<b>'+names[row.symbol]+'</b><strong class="'+(m.qualified?'positive':'negative')+'">'+m.score+'/100 · '+(m.qualified?'QUALIFIED':'NO TRADE')+'</strong><small>'+m.trend+' · ADX '+fmt(m.adx)+' · ATR '+fmt(m.atr)+(m.spike?' · SPIKE':'')+'</small>';
    });
    const qualified=rows.filter(x=>x.metrics && x.metrics.qualified).sort((a,b)=>b.metrics.score-a.metrics.score);
    if(qualified.length) {
      const best=qualified[0];
      $("bestMarket").textContent=names[best.symbol];
      $("bestMarketDetail").textContent="Qualified · stability "+best.metrics.score+"/100 · "+best.metrics.trend+" · ADX "+fmt(best.metrics.adx)+" · ATR "+fmt(best.metrics.atr);
      $("scannerStatus").textContent=qualified.length+" of "+rows.length+" markets meet every entry filter. Best qualified market selected by score.";
      $("recommendedMarket").value=best.symbol;
      $("useRecommended").disabled=false;
    } else {
      $("bestMarket").textContent="NO SUITABLE MARKET";
      $("bestMarketDetail").textContent="No market currently passes every required filter. Do not enter.";
      $("scannerStatus").textContent="No trade · "+rows.filter(x=>x.metrics).length+" of "+rows.length+" markets evaluated. Waiting for a fully qualified market.";
      $("useRecommended").disabled=true;
    }
  }
  function requestMarketData() {
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
    clearTimeout(state.dataTimer);
    state.ticks=[];
    state.historyLoaded=false;
    state.historyRequests={};
    $("marketName").textContent=names[state.market];
    $("quote").textContent="—";
    $("quoteTime").textContent="Requesting current market data";
    setConnection("connected","Loading "+names[state.market]+" · history + live ticks");
    send({ticks_history:state.market,adjust_start_time:1,count:300,end:"latest",style:"ticks"});
    send({ticks:state.market,subscribe:1});
    state.dataTimer=setTimeout(()=>{
      if(state.ws && state.ws.readyState===WebSocket.OPEN && state.ticks.length===0){
        setConnection("error","No current ticks received for "+names[state.market]+" · verify symbol availability");
      }
    },12000);
  }
  function connect() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.pingTimer);
    clearTimeout(state.dataTimer);
    clearTimeout(state.activeSymbolsTimer);
    clearTimeout(state.connectTimer);
    clearTimeout(state.marketFeedTimer);
    state.marketFeedQueue=[];
    if(state.ws) {
      try { state.ws.onclose=null; state.ws.close(); } catch(e) {}
    }
    state.connected=false;
    state.subscriptionIds=[];
    state.historyRequests={};
    state.availableSymbols=null;
    state.historyLoaded=false;
    state.lastMessageAt=0;
    state.lastTickAt=0;
    setConnection("","Connecting to Deriv automatically · waiting for market data");
    let ws;
    try { ws=new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public"); }
    catch(e) {
      setConnection("error","Could not create WebSocket · retrying");
      state.reconnectTimer=setTimeout(connect,5000);
      return;
    }
    state.ws=ws;
    state.connectTimer=setTimeout(()=>{
      if(state.ws===ws && ws.readyState!==WebSocket.OPEN){
        setConnection("error","Deriv connection timed out · retrying automatically");
        try { ws.close(); } catch(e) {}
      }
    },12000);
    ws.onopen=()=>{
      if(state.ws!==ws)return;
      state.connected=true;
      clearTimeout(state.connectTimer);
      state.reconnectAttempts=0;
      state.lastMessageAt=Date.now();
      setConnection("","WebSocket open · waiting for Deriv response");
      startPing();
      state.ticks=[];
      $("marketName").textContent=names[state.market];
      $("quote").textContent="—";
      send({active_symbols:"full"});
      setConnection("","Request sent · waiting for Deriv market-list response");
      state.activeSymbolsTimer=setTimeout(()=>{
        if(state.ws===ws && !state.availableSymbols){
          setConnection("error","No active-markets response after 10 seconds · socket remains open; last server message: "+state.lastServerMessage);
          $("scannerStatus").textContent="Connection is open, but Deriv has not returned active_symbols. Last request: "+state.lastRequest+". Last server message: "+state.lastServerMessage+". The socket is being kept open for diagnosis.";
        }
      },10000);
    };
    ws.onmessage=event=>{
      if(state.ws!==ws)return;
      state.lastMessageAt=Date.now();
      let msg;
      try { msg=JSON.parse(event.data); } catch(e) { state.lastServerMessage="Non-JSON message received"; setConnection("error","Deriv sent an unreadable response"); return; }
      state.lastServerMessage=String(msg.msg_type || (msg.error && msg.error.code) || Object.keys(msg).slice(0,4).join(", ") || "empty response");
      if(msg.error) {
        const code=msg.error.code ? " ["+msg.error.code+"]" : "";
        const failedContract=state.contractRequests[msg.req_id] || (msg.echo_req && msg.echo_req.contracts_for);
        if(failedContract) {
          delete state.contractRequests[msg.req_id];
          delete names[failedContract];
          const failedOption=$("market").querySelector('option[value="'+failedContract+'"]');
          if(failedOption) failedOption.remove();
          state.pendingContracts=Math.max(0,state.pendingContracts-1);
          $("scannerStatus").textContent="Deriv could not verify ACCU support for "+failedContract+code+": "+msg.error.message+". Continuing with remaining indices.";
          if(state.pendingContracts===0) finishContractDiscovery(); else requestNextContractCheck();
          return;
        }
        const rejectedSymbol=(msg.echo_req && (msg.echo_req.ticks_history || msg.echo_req.ticks)) || "";
        if(rejectedSymbol && state.scanData[rejectedSymbol]) {
          state.scanData[rejectedSymbol].status="Deriv error"+code;
          const card=$("scan-"+rejectedSymbol);
          if(card)card.innerHTML='<b>'+names[rejectedSymbol]+'</b><strong class="negative">REQUEST REJECTED</strong><small>'+String(msg.error.message||"Market request rejected")+'</small>';
          $("scannerStatus").textContent=rejectedSymbol+" request rejected"+code+": "+msg.error.message;
        } else {
          setConnection("error","Deriv API error"+code+": "+msg.error.message);
          if($("scannerStatus")) $("scannerStatus").textContent="Deriv rejected a market-data request: "+msg.error.message;
          if($("bestMarket")) $("bestMarket").textContent="CONNECTION ERROR";
        }
        return;
      }
      if(msg.active_symbols) {
        clearTimeout(state.activeSymbolsTimer);
        setConnection("connected","Deriv API responded · active market list received");
        if(!Array.isArray(msg.active_symbols)) {
          setConnection("error","Deriv returned an invalid active-markets response");
          $("scannerStatus").textContent="Could not read the active markets list from Deriv. Reconnecting…";
          return;
        }
        // Deriv identifies markets using underlying_symbol and supplies a display name.
        state.activeSymbolDetails={};
        // Only index instruments are candidates; then each is checked for ACCU.
        // Include classic R_* and 1-second 1HZ*V volatility indices.
        // Do not rely solely on the stockindex metadata label.
        state.availableSymbols=[...new Set(msg.active_symbols.filter(isVolatilityIndex).map(x=>{
          const symbol=x.underlying_symbol || x.symbol;
          state.activeSymbolDetails[symbol]=x;
          return symbol;
        }).filter(Boolean))];
        if(!state.availableSymbols.length){
          setConnection("error","Active-symbol response received, but no symbol names were readable");
          $("scannerStatus").textContent="Deriv returned "+msg.active_symbols.length+" active-symbol rows but no readable symbols.";
          $("bestMarket").textContent="SYMBOL RESPONSE UNREADABLE";
          return;
        }
        names={};
        // Populate the market tab immediately with the discovered volatility
        // indices. Keep selection disabled until Deriv confirms ACCU support.
        for(const symbol of state.availableSymbols) {
          const detail=state.activeSymbolDetails[symbol]||{};
          names[symbol]=marketDisplayName(detail,symbol);
        }
        const marketSelect=$("market");
        marketSelect.disabled=true;
        marketSelect.innerHTML=state.availableSymbols.map(symbol=>'<option value="'+symbol+'" disabled>'+names[symbol]+' ('+symbol+') · checking ACCU support…</option>').join("");
        $("marketName").textContent=names[state.availableSymbols[0]] || "Volatility index";
        state.contractRequests={};
        state.contractQueue=state.availableSymbols.slice();
        state.pendingContracts=state.availableSymbols.length;
        $("scannerStatus").textContent="Found "+state.availableSymbols.length+" active volatility indices. Checking which ones support Accumulator (ACCU) contracts…";
        $("bestMarket").textContent="Checking Accumulator availability…";
        requestNextContractCheck();
        return;
      }
      if(msg.contracts_for) {
        const symbol=state.contractRequests[msg.req_id] || (msg.echo_req && msg.echo_req.contracts_for);
        if(symbol) delete state.contractRequests[msg.req_id];
        const available=Array.isArray(msg.contracts_for.available)?msg.contracts_for.available:[];
        const hasAccumulator=available.some(contract=>String(contract.contract_type||"").toUpperCase()==="ACCU");
        if(symbol && hasAccumulator) {
          const detail=state.activeSymbolDetails[symbol]||{};
          names[symbol]=marketDisplayName(detail,symbol);
          const option=$("market").querySelector('option[value="'+symbol+'"]');
          if(option) { option.textContent=names[symbol]+" ("+symbol+")"; option.disabled=false; }
        } else if(symbol) {
          delete names[symbol];
          const option=$("market").querySelector('option[value="'+symbol+'"]');
          if(option) option.remove();
        }
        state.pendingContracts=Math.max(0,state.pendingContracts-1);
        if(state.pendingContracts===0) finishContractDiscovery();
        else requestNextContractCheck();
        return;
      }
      if(msg.history && msg.history.prices) {
        const symbol=state.historyRequests[msg.req_id] || (msg.echo_req && msg.echo_req.ticks_history);
        delete state.historyRequests[msg.req_id];
        const times=msg.history.times||[];
        const values=msg.history.prices.map((p,i)=>({price:Number(p),time:Number(times[i]||Date.now()/1000)})).filter(t=>Number.isFinite(t.price));
        if(symbol && state.scanData[symbol]) {
          state.scanData[symbol].status="History received";
          state.scanData[symbol].ticks=values;
          if(symbol===state.market)state.ticks=values.slice();
          renderScanner();
          if(symbol===state.market)render();
          if(Object.values(state.scanData).every(x=>x.ticks.length>=100)) {
            state.historyLoaded=true;
            setConnection("connected","Market history received · waiting for live tick streams");
          }
        } else {
          state.ticks=values;
          render();
        }
        if(msg.subscription && msg.subscription.id && !state.subscriptionIds.includes(msg.subscription.id))state.subscriptionIds.push(msg.subscription.id);
        return;
      }
      if(msg.tick) {
        state.lastTickAt=Date.now();
        clearTimeout(state.dataTimer);
        if($("scannerStatus")) $("scannerStatus").textContent="Deriv live tick received · "+state.liveSymbols.size+"/"+Object.keys(names).length+" ACCU markets streaming";
        const t=msg.tick, symbol=t.symbol, price=Number(t.quote);
        if(!Number.isFinite(price))return;
        const point={price,time:Number(t.epoch||Date.now()/1000)};
        if(state.scanData[symbol]) {
          state.liveSymbols.add(symbol);
          state.scanData[symbol].status="Receiving live ticks";
          const arr=state.scanData[symbol].ticks;
          arr.push(point);
          if(arr.length>600)arr.shift();
          renderScanner();
        }
        if(symbol===state.market) {
          state.ticks.push(point);
          if(state.ticks.length>600)state.ticks.shift();
          setConnection("connected","Live tick stream confirmed · "+state.liveSymbols.size+"/"+Object.keys(names).length+" ACCU markets");
          render();
        }
        if(msg.subscription && msg.subscription.id && !state.subscriptionIds.includes(msg.subscription.id))state.subscriptionIds.push(msg.subscription.id);
      }
    };
    ws.onerror=()=>{
      if(state.ws===ws){ setConnection("error","Browser WebSocket error · last server message: "+state.lastServerMessage); if($("scannerStatus"))$("scannerStatus").textContent="WebSocket error. Last request: "+state.lastRequest+". Last server message: "+state.lastServerMessage+". Browser does not expose the detailed handshake error."; }
    };
    ws.onclose=event=>{
      if(state.ws!==ws)return;
      state.connected=false;
      clearTimeout(state.activeSymbolsTimer);
      clearTimeout(state.connectTimer);
      clearTimeout(state.dataTimer);
      clearInterval(state.pingTimer);
      const code=event && Number.isFinite(event.code) ? event.code : "unknown";
      const reason=event && event.reason ? " · reason: "+event.reason : " · no close reason supplied";
      const clean=event && typeof event.wasClean==="boolean" ? " · clean: "+event.wasClean : "";
      setConnection("error","Disconnected ("+code+")"+reason+clean+" · reconnecting");
      if($("scannerStatus"))$("scannerStatus").textContent="Socket closed by browser/network/server. Last request: "+state.lastRequest+". Last server message: "+state.lastServerMessage+". Active symbols received: "+(state.availableSymbols?state.availableSymbols.length:"not parsed")+". Close code "+code+reason+clean+". Reconnecting automatically.";
      state.reconnectTimer=setTimeout(connect,5000);
    };
  }
  function subscribeMarket() {
    const selected=$("market").value;
    if(!selected || !Object.prototype.hasOwnProperty.call(names,selected))return;
    state.market=selected;
    $("marketName").textContent=names[selected];
    $("chartCaption").innerHTML="Live tick history · <span id=\"marketName\">"+names[selected]+"</span>";
    const marketData=state.scanData[selected];
    if(marketData && marketData.ticks.length) {
      state.ticks=marketData.ticks.slice();
      render();
      setConnection("connected","Live all-market scan · viewing "+names[selected]);
      $("scannerStatus").textContent="Viewing "+names[selected]+" · "+state.liveSymbols.size+"/"+Object.keys(names).length+" eligible indices streaming";
    } else {
      state.ticks=[];
      $("quote").textContent="—";
      $("quoteTime").textContent="Waiting for "+names[selected]+" market history";
      $("tickCount").textContent="0 ticks loaded";
      $("condition").textContent="Collecting data";
      $("conditionHint").textContent="Waiting for selected volatility index data";
      $("score").innerHTML="—<em>/100</em>";
      $("atr").textContent="—";$("atr14").textContent="—";
      $("bb").textContent="—";$("bbDetail").textContent="Band width";
      $("rsi").textContent="—";$("rsiDetail").textContent="Momentum";
      $("adx").textContent="—";$("adxDetail").textContent="Directional strength estimate";
      $("ema").textContent="—";$("emaDetail").textContent="Trend alignment";
      $("spike").textContent="—";$("spikeDetail").textContent="Unusual tick movement";
      $("signalExplanation").textContent="Waiting for "+names[selected]+" price history and live ticks.";
      drawChart();
      setConnection("connected","Live all-market scan · loading "+names[selected]);
    }
  }
  function ema(values,period) {
    if(values.length<period)return NaN;
    const k=2/(period+1);
    let v=mean(values.slice(0,period));
    for(let i=period;i<values.length;i++)v=values[i]*k+v*(1-k);
    return v;
  }
  function rsi(values,period=14) {
    if(values.length<period+1)return NaN;
    let gains=0,losses=0;
    for(let i=values.length-period;i<values.length;i++) {
      const d=values[i]-values[i-1];
      if(d>0)gains+=d;else losses-=d;
    }
    if(losses===0)return gains===0?50:100;
    const rs=(gains/period)/(losses/period);
    return 100-100/(1+rs);
  }
  function evaluateMarket(prices, horizon=5) {
    const p=prices.map(t=>typeof t==="number"?t:t.price),n=p.length;
    if(n<100)return null;
    const last=p[n-1],prev=p[n-2],recent=p.slice(-20),prior=p.slice(-40,-20);
    const mid=mean(recent),sd=std(recent),upper=mid+2*sd,lower=mid-2*sd;
    const priorMid=mean(prior),priorWidth=priorMid?((4*std(prior))/Math.abs(priorMid))*100:0;
    const width=mid?((upper-lower)/Math.abs(mid))*100:0;
    const changes=p.slice(1).map((v,i)=>Math.abs(v-p[i]));
    const atr=mean(changes.slice(-14)),baseAtr=mean(changes.slice(-42,-14));
    const atrRising=baseAtr>0&&atr>baseAtr*1.25;
    const bandsExpanding=priorWidth>0&&width>priorWidth*1.15;
    const r=rsi(p,14),e20=ema(p,20),e50=ema(p,50);
    const adxChanges=p.slice(-15).slice(1).map((v,i)=>v-p[n-15+i]);
    const adxNet=adxChanges.reduce((a,b)=>a+b,0),adxPath=adxChanges.reduce((a,b)=>a+Math.abs(b),0);
    const adx=adxPath?100*Math.abs(adxNet)/adxPath:0;
    const signalWindow=Math.max(1,Math.min(20,Math.floor(Number(horizon)||5)));
    const direction=p.slice(-(signalWindow+1)).slice(1).map((v,i)=>v-p[n-signalWindow-1+i]);
    const net=direction.reduce((a,b)=>a+b,0),path=direction.reduce((a,b)=>a+Math.abs(b),0);
    const momentum=path?100*Math.abs(net)/path:0;
    const emaGap=last?Math.abs(e20-e50)/Math.abs(last):0;
    let trend="SIDEWAYS";
    const trendEvidence=adx>25||emaGap>0.0005||(net!==0&&momentum>25);
    if(trendEvidence&&e20>e50&&net>0)trend="BULLISH";
    else if(trendEvidence&&e20<e50&&net<0)trend="BEARISH";
    const baseline=mean(changes.slice(-50,-14))||atr;
    const spike=baseline>0&&Math.abs(last-prev)>baseline*3;
    const directional=adx>25||emaGap>0.0005||trend!=="SIDEWAYS";
    let score=100,reasons=[];
    if(bandsExpanding){score-=22;reasons.push("Bollinger Bands suddenly expanding");}
    if(atrRising){score-=22;reasons.push("ATR rising sharply");}
    if(adx>25){score-=22;reasons.push("ADX above 25: strong directional momentum");}
    if(directional){score-=12;reasons.push("Directional trend detected");}
    if(spike){score-=35;reasons.push("Unusually large tick spike");}
    if(!bandsExpanding)reasons.push("Bollinger width stable");
    if(!atrRising)reasons.push("ATR stable");
    if(adx<=25)reasons.push("ADX at or below 25");
    if(!spike)reasons.push("No sudden spike");
    score=Math.max(0,Math.min(100,Math.round(score)));
    const qualified=!bandsExpanding&&!atrRising&&adx<=25&&!spike&&!directional&&trend==="SIDEWAYS"&&score>=75;
    return {last,mid,upper,lower,atr,r,e20,e50,adx,momentum,signalWindow,width,priorWidth,bandsExpanding,atrRising,spike,trend,score,qualified,reasons};
  }
  // Expose pure calculations for repeatable regression tests; no trading actions are exposed.
  window.AccumulatorAI = Object.freeze({evaluateMarket, rsi, ema});

  function calculate() {
    const d=evaluateMarket(state.ticks,Number($("timeframe").value)||5);
    if(!d)return null;
    return {...d,label:d.qualified?"FAVOURABLE":d.score>=55?"CAUTION":"AVOID"};
  }
  function render() {
    if(!state.ticks.length)return;
    const latest=state.ticks[state.ticks.length-1];
    $("quote").textContent=latest.price.toFixed(2);
    $("quoteTime").textContent="Updated "+new Date(latest.time*1000).toLocaleTimeString();
    $("tickCount").textContent=state.ticks.length+" ticks loaded";
    drawChart();
    const d=calculate();
    if(!d) {
      $("condition").textContent="Collecting data";
      $("score").innerHTML="—<em>/100</em>";
      return;
    }
    $("condition").textContent=d.label;
    $("condition").className=d.label==="FAVOURABLE"?"positive":d.label==="AVOID"?"negative":"warning";
    $("conditionHint").textContent=d.label==="FAVOURABLE"?"Relatively calm conditions detected":d.label==="AVOID"?"Elevated risk conditions detected":"Mixed conditions · wait for clarity";
    $("score").innerHTML=d.score+'<em>/100</em>';
    $("atr").textContent=fmt(d.atr);$("atr14").textContent=fmt(d.atr);
    $("bb").textContent=fmt(d.lower)+" – "+fmt(d.upper);
    $("bbDetail").textContent="Width "+d.width.toFixed(3)+"% · mid "+fmt(d.mid);
    $("rsi").textContent=fmt(d.r);
    $("rsiDetail").textContent=d.r>70?"Overbought momentum":d.r<30?"Oversold momentum":d.r>=40&&d.r<=60?"Neutral momentum":"Moderate momentum";
    $("adx").textContent=fmt(d.adx);
    $("adxDetail").textContent=d.adx<=25?"At/below 25 · weaker trend":"Above 25 · strong momentum";
    $("ema").textContent=fmt(d.e20)+" / "+fmt(d.e50);
    $("emaDetail").textContent=Math.abs(d.e20-d.e50)/Math.abs(d.last)<.001?"Averages close together":d.e20>d.e50?"EMA 20 above EMA 50":"EMA 20 below EMA 50";
    $("spike").textContent=d.spike?"SPIKE DETECTED":"No spike";
    $("spike").className=d.spike?"negative":"positive";
    $("spikeDetail").textContent=d.spike?"Latest move exceeds 3× baseline":"No unusually large latest tick";
    $("atrHint").textContent=d.atr>0?"Average absolute tick movement":"Waiting for movement";
    $("scoreBar").style.width=d.score+"%";
    const sig=$("signal");
    sig.className="signal "+(d.label==="FAVOURABLE"?"good":d.label==="AVOID"?"bad":"");
    sig.querySelector(".signal-icon").textContent=d.label==="FAVOURABLE"?"✓":d.label==="AVOID"?"!":"…";
    sig.querySelector("strong").textContent=d.label==="FAVOURABLE"?"FAVOURABLE":d.label==="AVOID"?"AVOID":"WAIT";
    sig.querySelector("small").textContent=d.label==="FAVOURABLE"?"Calmer conditions only · verify contract settings":d.label==="AVOID"?"High-risk market conditions":"Mixed readings · wait for confirmation";
    $("signalExplanation").textContent=d.reasons.join(" · ")+". Suitability index only, not a win probability. "+(d.qualified?"This market passes the current filters.":"NO TRADE: at least one required filter is not satisfied.");
    $("updated").textContent="Updated "+new Date().toLocaleTimeString();
  }
  function drawChart() {
    const canvas=$("priceChart"),ctx=canvas.getContext("2d");
    const rect=canvas.getBoundingClientRect(),ratio=window.devicePixelRatio||1;
    canvas.width=Math.max(1,rect.width*ratio);canvas.height=250*ratio;
    ctx.setTransform(ratio,0,0,ratio,0,0);
    const w=rect.width,h=250,p=state.ticks.slice(-100).map(t=>t.price);
    ctx.clearRect(0,0,w,h);
    if(p.length<2)return;
    const min=Math.min(...p),max=Math.max(...p),pad=(max-min)*.12||1,lo=min-pad,hi=max+pad;
    ctx.font="10px DM Mono";ctx.strokeStyle="#203047";ctx.fillStyle="#73859c";ctx.lineWidth=1;
    for(let i=0;i<5;i++){const y=12+i*(h-30)/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();ctx.fillText((hi-(hi-lo)*i/4).toFixed(2),5,y-4);}
    const x=i=>i/(p.length-1)*w,y=v=>h-18-(v-lo)/(hi-lo)*(h-38);
    ctx.beginPath();p.forEach((v,i)=>i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)));
    ctx.strokeStyle="#35d6a0";ctx.lineWidth=2;ctx.stroke();
    const e=ema(p,20);
    if(Number.isFinite(e)){ctx.setLineDash([5,4]);ctx.strokeStyle="#69a9ff";ctx.beginPath();ctx.moveTo(0,y(e));ctx.lineTo(w,y(e));ctx.stroke();ctx.setLineDash([]);}
  }
  function addSnapshot() {
    const d=calculate();if(!d)return;
    const row={time:new Date().toLocaleTimeString(),market:state.market,quote:d.last,rsi:d.r,adx:d.adx,score:d.score,label:d.label};
    state.history.unshift(row);state.history=state.history.slice(0,12);
    $("historyRows").innerHTML=state.history.map(x=>'<tr><td>'+x.time+'</td><td>'+x.market+'</td><td>'+fmt(x.quote)+'</td><td>'+fmt(x.rsi)+'</td><td>'+fmt(x.adx)+'</td><td>'+x.score+'</td><td class="'+(x.label==="FAVOURABLE"?"positive":x.label==="AVOID"?"negative":"warning")+'">'+x.label+'</td></tr>').join("");
  }
  $("market").addEventListener("change",subscribeMarket);
  $("timeframe").addEventListener("change",()=>{renderScanner();render();});
  $("startScanner").addEventListener("click",()=>{
    if(state.scannerRunning){stopAllMarketScans();return;}
    if(!state.connected || !state.ws || state.ws.readyState!==WebSocket.OPEN){
      $("scannerStatus").textContent="Waiting for Deriv connection and Accumulator market verification.";
      return;
    }
    if(!Object.keys(names).length){
      $("scannerStatus").textContent="No verified ACCU-enabled volatility indices are available.";
      return;
    }
    startAllMarketScans();
  });
  $("useRecommended").addEventListener("click",()=>{const symbol=$("recommendedMarket").value;if(!symbol||!state.scanData[symbol]||!state.scanData[symbol].metrics||!state.scanData[symbol].metrics.qualified)return;$("market").value=symbol;state.market=symbol;state.ticks=state.scanData[symbol].ticks.slice();$("marketName").textContent=names[symbol];render();window.scrollTo({top:0,behavior:"smooth"});});
  $("reconnectBtn").addEventListener("click",connect);
  $("scanBtn").addEventListener("click",()=>{render();addSnapshot();});
  $("clearHistory").addEventListener("click",()=>{
    state.history=[];
    $("historyRows").innerHTML='<tr><td colspan="7" class="empty">No readings yet.</td></tr>';
  });
  window.addEventListener("resize",drawChart);
  window.addEventListener("online",()=>{setConnection("","Internet restored · reconnecting to Deriv");connect();});
  window.addEventListener("offline",()=>setConnection("error","Internet unavailable · waiting to reconnect"));
  document.addEventListener("visibilitychange",()=>{if(!document.hidden && (!state.ws || state.ws.readyState!==WebSocket.OPEN)){setConnection("","Reconnecting to Deriv market feed");connect();}});
  connect();
})();