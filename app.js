(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = {
    ws:null, ticks:[], market:"R_10", connected:false, history:[],
    reconnectTimer:null, pingTimer:null, dataTimer:null, requestId:1, subscriptionIds:[],
    historyLoaded:false, availableSymbols:null
  };
  const names = {
    R_10:"Volatility 10 Index", R_25:"Volatility 25 Index",
    R_50:"Volatility 50 Index", R_75:"Volatility 75 Index",
    R_100:"Volatility 100 Index"
  };
  const fmt = n => Number.isFinite(n) ? n.toFixed(2) : "—";
  const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN;
  const std = a => { const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };

  function setConnection(status,label) {
    const dot=$("connectionDot");
    if(dot && dot.parentElement) dot.parentElement.className="connection "+status;
    if($("connectionText")) $("connectionText").textContent=label;
  }
  function send(payload) {
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify({...payload,req_id:state.requestId++}));
    return true;
  }
  function startPing() {
    clearInterval(state.pingTimer);
    state.pingTimer=setInterval(()=>send({ping:1}),25000);
  }
  function forgetSubscriptions() {
    for(const id of state.subscriptionIds) send({forget:id});
    state.subscriptionIds=[];
  }
  function requestMarketData() {
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
    clearTimeout(state.dataTimer);
    state.ticks=[];
    state.historyLoaded=false;
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
    if(state.ws) {
      try { state.ws.onclose=null; state.ws.close(); } catch(e) {}
    }
    state.connected=false;
    state.subscriptionIds=[];
    state.availableSymbols=null;
    state.historyLoaded=false;
    setConnection("","Connecting to Deriv market feed");
    let ws;
    try { ws=new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public"); }
    catch(e) {
      setConnection("error","Could not create WebSocket · retrying");
      state.reconnectTimer=setTimeout(connect,5000);
      return;
    }
    state.ws=ws;
    ws.onopen=()=>{
      if(state.ws!==ws)return;
      state.connected=true;
      setConnection("connected","Connected · loading "+state.market);
      startPing();
      state.ticks=[];
      $("marketName").textContent=names[state.market];
      $("quote").textContent="—";
      send({active_symbols:"brief"});
      setConnection("connected","Connected to Deriv · checking available markets");
      state.dataTimer=setTimeout(()=>{
        if(state.ws===ws && !state.historyLoaded && state.ticks.length===0){
          setConnection("error","Deriv connected, but market data has not arrived · retrying");
          requestMarketData();
        }
      },12000);
    };
    ws.onmessage=event=>{
      if(state.ws!==ws)return;
      let msg;
      try { msg=JSON.parse(event.data); } catch(e) { return; }
      if(msg.error) {
        const code=msg.error.code ? " ["+msg.error.code+"]" : "";
        setConnection("error","Deriv error"+code+": "+msg.error.message);
        return;
      }
      if(msg.active_symbols) {
        state.availableSymbols=msg.active_symbols.map(x=>x.symbol);
        if(!state.availableSymbols.includes(state.market)){
          setConnection("error",names[state.market]+" is not listed as an active symbol by Deriv");
          return;
        }
        requestMarketData();
        return;
      }
      if(msg.history && msg.history.prices) {
        const symbol=msg.echo_req && msg.echo_req.ticks_history;
        const times=msg.history.times||[];
        const values=msg.history.prices.map((p,i)=>({price:Number(p),time:Number(times[i]||Date.now()/1000)})).filter(t=>Number.isFinite(t.price));
        if(symbol && state.scanData[symbol]) {
          state.scanData[symbol].ticks=values;
          if(symbol===state.market)state.ticks=values.slice();
          renderScanner();
          if(symbol===state.market)render();
          if(Object.values(state.scanData).every(x=>x.ticks.length>=100)) {
            state.historyLoaded=true;
            setConnection("connected","Deriv live · scanning "+Object.keys(state.scanData).length+" markets");
          }
        } else {
          state.ticks=values;
          render();
        }
        if(msg.subscription && msg.subscription.id && !state.subscriptionIds.includes(msg.subscription.id))state.subscriptionIds.push(msg.subscription.id);
        return;
      }
      if(msg.tick) {
        clearTimeout(state.dataTimer);
        const t=msg.tick, symbol=t.symbol, price=Number(t.quote);
        if(!Number.isFinite(price))return;
        const point={price,time:Number(t.epoch||Date.now()/1000)};
        if(state.scanData[symbol]) {
          const arr=state.scanData[symbol].ticks;
          arr.push(point);
          if(arr.length>600)arr.shift();
          renderScanner();
        }
        if(symbol===state.market) {
          state.ticks.push(point);
          if(state.ticks.length>600)state.ticks.shift();
          setConnection("connected","Live · "+names[state.market]+" · "+state.ticks.length+" ticks");
          render();
        }
        if(msg.subscription && msg.subscription.id && !state.subscriptionIds.includes(msg.subscription.id))state.subscriptionIds.push(msg.subscription.id);
      }
    };
    ws.onerror=()=>{
      if(state.ws===ws)setConnection("error","Market feed connection error · retrying");
    };
    ws.onclose=event=>{
      if(state.ws!==ws)return;
      state.connected=false;
      clearInterval(state.pingTimer);
      const detail=event && event.code ? " ("+event.code+")" : "";
      setConnection("error","Disconnected"+detail+" · reconnecting");
      state.reconnectTimer=setTimeout(connect,5000);
    };
  }
  function subscribeMarket() {
    clearTimeout(state.dataTimer);
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
    forgetSubscriptions();
    state.market=$("market").value;
    state.ticks=[];
    state.historyLoaded=false;
    $("marketName").textContent=names[state.market];
    $("quote").textContent="—";
    $("quoteTime").textContent="Loading market history";
    setConnection("connected","Loading "+names[state.market]);
    if(state.availableSymbols && state.availableSymbols.includes(state.market)) {
      requestMarketData();
    } else {
      send({active_symbols:"brief"});
      setConnection("connected","Checking "+names[state.market]+" availability on Deriv");
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
  function evaluateMarket(prices) {
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
    const direction=p.slice(-15).slice(1).map((v,i)=>v-p[n-15+i]);
    const net=direction.reduce((a,b)=>a+b,0),path=direction.reduce((a,b)=>a+Math.abs(b),0);
    const adx=path?100*Math.abs(net)/path:0;
    const emaGap=last?Math.abs(e20-e50)/Math.abs(last):0;
    let trend="SIDEWAYS";
    if(adx>25&&e20>e50&&net>0)trend="BULLISH";
    else if(adx>25&&e20<e50&&net<0)trend="BEARISH";
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
    const qualified=!bandsExpanding&&!atrRising&&adx<=25&&!spike&&trend==="SIDEWAYS"&&score>=75;
    return {last,mid,upper,lower,atr,r,e20,e50,adx,width,priorWidth,bandsExpanding,atrRising,spike,trend,score,qualified,reasons};
  }
  function calculate() {
    const d=evaluateMarket(state.ticks);
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
  $("reconnectBtn").addEventListener("click",connect);
  $("scanBtn").addEventListener("click",()=>{render();addSnapshot();});
  $("clearHistory").addEventListener("click",()=>{
    state.history=[];
    $("historyRows").innerHTML='<tr><td colspan="7" class="empty">No readings yet.</td></tr>';
  });
  window.addEventListener("resize",drawChart);
  connect();
})();