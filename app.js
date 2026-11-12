(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const state = {
    ws:null, ticks:[], market:"R_10", connected:false, history:[],
    reconnectTimer:null, pingTimer:null, requestId:1, subscriptionId:null,
    historyLoaded:false
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
  function connect() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.pingTimer);
    if(state.ws) {
      try { state.ws.onclose=null; state.ws.close(); } catch(e) {}
    }
    state.connected=false;
    state.subscriptionId=null;
    state.historyLoaded=false;
    setConnection("","Connecting to Deriv market feed");
    let ws;
    try { ws=new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089"); }
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
      send({ticks_history:state.market,adjust_start_time:1,count:300,end:"latest",style:"ticks",subscribe:1});
    };
    ws.onmessage=event=>{
      if(state.ws!==ws)return;
      let msg;
      try { msg=JSON.parse(event.data); } catch(e) { return; }
      if(msg.error) {
        setConnection("error","Deriv: "+msg.error.message);
        return;
      }
      if(msg.history && msg.history.prices) {
        const times=msg.history.times||[];
        state.ticks=msg.history.prices.map((p,i)=>({
          price:Number(p),time:Number(times[i]||Date.now()/1000)
        })).filter(t=>Number.isFinite(t.price));
        render();
        if(msg.subscription)state.subscriptionId=msg.subscription.id;
        if(!state.historyLoaded) {
          state.historyLoaded=true;
          setConnection("connected","History loaded · live feed active");
        }
        return;
      }
      if(msg.tick) {
        const t=msg.tick;
        if(t.symbol!==state.market)return;
        const price=Number(t.quote);
        if(!Number.isFinite(price))return;
        state.ticks.push({price,time:Number(t.epoch||Date.now()/1000)});
        if(state.ticks.length>600)state.ticks.shift();
        if(msg.subscription)state.subscriptionId=msg.subscription.id;
        setConnection("connected","Live · "+names[state.market]);
        render();
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
    if(!state.ws || state.ws.readyState!==WebSocket.OPEN)return;
    if(state.subscriptionId)send({forget:state.subscriptionId});
    state.subscriptionId=null;
    state.market=$("market").value;
    state.ticks=[];
    state.historyLoaded=false;
    $("marketName").textContent=names[state.market];
    $("quote").textContent="—";
    $("quoteTime").textContent="Loading market history";
    setConnection("connected","Loading "+names[state.market]);
    send({ticks_history:state.market,adjust_start_time:1,count:300,end:"latest",style:"ticks"});
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
  function calculate() {
    const p=state.ticks.map(t=>t.price),n=p.length;
    if(n<50)return null;
    const last=p[n-1],prev=p[n-2],recent=p.slice(-20);
    const mid=mean(recent),sd=std(recent),upper=mid+2*sd,lower=mid-2*sd;
    const changes=p.slice(1).map((v,i)=>Math.abs(v-p[i]));
    const atr=mean(changes.slice(-14)),r=rsi(p,14),e20=ema(p,20),e50=ema(p,50);
    const direction=p.slice(-15).slice(1).map((v,i)=>v-p[n-15+i]);
    const net=Math.abs(direction.reduce((a,b)=>a+b,0));
    const path=direction.reduce((a,b)=>a+Math.abs(b),0);
    const adx=path?100*net/path:0;
    const width=mid?((upper-lower)/Math.abs(mid))*100:0;
    const baseline=mean(changes.slice(-50,-14))||atr;
    const spike=baseline>0&&Math.abs(last-prev)>baseline*3;
    const risingAtr=baseline>0&&atr>baseline*1.5;
    let score=50,reasons=[];
    if(width<0.18){score+=15;reasons.push("Bollinger width is relatively compressed");}
    else if(width<0.35){score+=8;reasons.push("Bollinger width is moderate");}
    else{score-=12;reasons.push("Bollinger Bands are wide");}
    if(adx<20){score+=15;reasons.push("Directional movement is weak");}
    else if(adx<25){score+=5;reasons.push("Trend strength is moderate");}
    else{score-=18;reasons.push("Directional movement is strong");}
    if(r>=42&&r<=58){score+=12;reasons.push("RSI is neutral");}
    else if(r>68||r<32){score-=12;reasons.push("RSI shows strong momentum");}
    else{score+=3;reasons.push("RSI is outside neutral zone");}
    if(!risingAtr){score+=8;reasons.push("ATR is not expanding sharply");}
    else{score-=15;reasons.push("ATR is expanding");}
    if(spike){score-=30;reasons.push("A sudden tick spike was detected");}
    if(Math.abs(e20-e50)/Math.abs(last)>0.001){score-=8;reasons.push("EMA separation suggests directional movement");}
    score=Math.max(0,Math.min(100,Math.round(score)));
    const label=score>=75&&!spike?"FAVOURABLE":score>=55&&!spike?"CAUTION":"AVOID";
    return {last,mid,upper,lower,atr,r,e20,e50,adx,width,spike,score,label,reasons};
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
    $("adxDetail").textContent=d.adx<20?"Weak directional movement":d.adx<25?"Moderate directional movement":"Strong directional movement";
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
    $("signalExplanation").textContent=d.reasons.join(" · ")+". This score describes indicator conditions only; it is not a probability of profit or contract survival.";
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