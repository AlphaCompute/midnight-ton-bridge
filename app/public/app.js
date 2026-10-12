const $=s=>document.querySelector(s);
const api=async(path,body)=>{
 const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 const data=await r.json().catch(()=>({error:`HTTP ${r.status}`}));if(!r.ok)throw new Error(data.error??`HTTP ${r.status}`);return data;
};
const el=(tag,attrs={},...kids)=>{const n=document.createElement(tag);for(const[k,v]of Object.entries(attrs))k==='class'?n.className=v:n.setAttribute(k,v);n.append(...kids);return n;};
const rows=(dl,items)=>dl.replaceChildren(...items.flatMap(([k,v,mono])=>[el('dt',{},k),el('dd',mono?{class:'mono'}:{},v)]));
const plain=(units,dec)=>{const s=String(units).padStart(dec+1,'0');if(!dec)return s;const f=s.slice(-dec).replace(/0+$/,'');return s.slice(0,-dec)+(f?'.'+f:'');};
const fmt=(units,dec)=>plain(units,dec).replace(/^\d+/,w=>w.replace(/\B(?=(\d{3})+(?!\d))/g,','));
const short=a=>a.length>20?`${a.slice(0,6)}…${a.slice(-4)}`:a;
const toast=msg=>{const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('show'),1800);};
// Keys were un-namespaced before; read them as a fallback so saved addresses survive.
const store={get:k=>{try{return localStorage.getItem('bridge.'+k)??localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem('bridge.'+k,v)}catch{}}};

// Tabs
const tabs=[...document.querySelectorAll('[role=tab]')];
const select=tab=>{for(const t of tabs){const on=t===tab;t.setAttribute('aria-selected',on);$('#'+t.getAttribute('aria-controls')).hidden=!on;}
 history.replaceState(null,'','#'+tab.id.slice(2));if(tab.id==='t-pool')refreshQuote();};
tabs.forEach(t=>t.addEventListener('click',()=>select(t)));

let config,status;
const asset=i=>config.assets[Number(i)];

// Bridge
const balance=async()=>{
 const owner=$('#ton').value.trim(),out=$('#bal');out.replaceChildren();
 if(!owner)return;
 try{const b=await api('/api/balances?owner='+encodeURIComponent(owner)),a=asset($('#asset').value),row=b.assets[a.asset];
  if(row.balance===null){out.textContent=`0 ${a.symbol}`;return;}
  const max=el('button',{type:'button'},'Max');max.onclick=()=>{$('#amount').value=plain(row.balance,a.decimals);};
  out.append(`${fmt(row.balance,a.decimals)} ${a.symbol} · `,max);
 }catch{}// the balance hint is advisory; the deposit request re-checks it
};
let prepared;
$('#deposit').addEventListener('submit',async e=>{
 e.preventDefault();const btn=$('#prepare'),err=$('#deposit-error');err.textContent='';btn.disabled=true;btn.textContent='…';
 try{
  const d=await api('/api/deposit',{asset:Number($('#asset').value),amount:$('#amount').value,tonAddress:$('#ton').value,midnightRecipient:$('#recipient').value});
  prepared=d;store.set('ton',$('#ton').value.trim());store.set('recipient',$('#recipient').value.trim());
  rows($('#review-list'),[
   ['Amount',`${d.amount} ${d.symbol}`],
   ['To',short(d.midnightRecipient),true],
   ['Gas',`${d.attachedTon} TON`],
  ]);
  $('#review-warn').replaceChildren(...d.warnings.map(w=>el('li',{},w)));
  $('#open-wallet').href=d.deepLink;
  $('#deposit').hidden=true;$('#review').hidden=false;$('#open-wallet').focus();
 }catch(x){err.textContent=x.message;}
 finally{btn.disabled=false;btn.textContent='Continue';}
});
$('#edit').onclick=()=>{$('#review').hidden=true;$('#deposit').hidden=false;$('#amount').focus();};
$('#copy-request').onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(prepared.tonConnect,null,2));toast('Copied');}catch{toast('Copy failed');}};
$('#ton').addEventListener('change',balance);$('#asset').addEventListener('change',balance);

// Track
$('#track').addEventListener('submit',async e=>{
 e.preventDefault();const err=$('#track-error');err.textContent='';$('#receipt').hidden=true;
 try{
  const r=await api(`/api/receipt?asset=${$('#track-asset').value}&sequence=${encodeURIComponent($('#track-seq').value.trim())}`);
  const claim=r.claimed===true?el('span',{class:'badge good'},'Claimed'):r.claimed===false?el('span',{class:'badge wait'},'Pending'):el('span',{class:'badge na',title:r.midnightNote??''},'Locked');
  rows($('#receipt-list'),[
   ['Status',claim],['Amount',`${r.display} ${r.symbol}`],['To',short(r.recipient),true],['Receipt',short(r.id),true],
  ]);
  $('#receipt').hidden=false;
 }catch(x){err.textContent=x.message;}
});

// Pool
const poolStats=()=>{
 const box=$('#pool-stats'),m=status?.midnight;
 box.replaceChildren(...config.assets.map(a=>el('div',{class:'stat'},el('b',{},m?.available?fmt(m.reserve[a.asset],a.decimals):'—'),el('span',{},a.symbol))));
};
let qTimer;
const refreshQuote=()=>{if(!config)return;clearTimeout(qTimer);qTimer=setTimeout(async()=>{
 const a=asset($('#q-asset').value),o=config.assets[1-a.asset],amount=$('#q-amount').value.trim(),err=$('#quote-error');
 $('#q-out-sym').textContent=o.symbol;err.textContent='';
 if(!amount){$('#q-out').textContent='—';$('#q-detail').replaceChildren();return;}
 try{const q=await api('/api/quote',{assetIn:a.asset,amount,slippageBps:Number($('#q-slip').value)});
  $('#q-out').textContent=q.out;
  rows($('#q-detail'),[['Minimum',`${q.minOut} ${q.symbolOut}`],['Impact',`${(q.priceImpact*100).toFixed(2)}%`]]);
 }catch(x){$('#q-out').textContent='—';$('#q-detail').replaceChildren();err.textContent=x.message;}
},250);};
['#q-amount','#q-asset','#q-slip'].forEach(s=>$(s).addEventListener('input',refreshQuote));
// Quotes update live; Enter must not attempt a form submission (CSP form-action 'none').
$('#quote').onsubmit=e=>e.preventDefault();

// Route
const route=()=>{
 const t=status?.ton;
 $('#route').replaceChildren(
  ...config.assets.map(a=>{const live=t?.available?t.assets[a.asset]:null,d=el('dl');
   rows(d,[['Locked',live?fmt(live.locked,a.decimals):'—'],['Cap',fmt(a.cap,a.decimals)],['Escrow',short(a.escrow),true]]);
   return el('div',{class:'route-asset'},el('h2',{},a.symbol),d);}),
  (()=>{const d=el('dl');rows(d,[['Midnight contract',short(config.midnight),true]]);return el('div',{class:'route-asset'},d);})());
};

const chip=(id,s)=>{const c=$(id);c.classList.toggle('ok',!!s?.available);c.classList.toggle('down',!!s&&!s.available);c.title=s?.available?'Live':s?.error??'';};
const refresh=async()=>{try{status=await api('/api/status');}catch(x){status={ton:{available:false,error:x.message},midnight:{available:false,error:x.message}};}
 chip('#ton-live',status.ton);chip('#mn-live',status.midnight);poolStats();route();};

(async()=>{
 config=await api('/api/config');
 const opts=()=>config.assets.map(a=>el('option',{value:a.asset},a.symbol));
 for(const s of ['#asset','#track-asset','#q-asset'])$(s).replaceChildren(...opts());
 $('#ton').value=store.get('ton')??'';$('#recipient').value=store.get('recipient')??'';
 const initial=tabs.find(t=>t.id==='t-'+location.hash.slice(1));if(initial)select(initial);
 route();poolStats();await refresh();balance();setInterval(refresh,30000);
})().catch(x=>{$('#deposit-error').textContent=`${x.message}`;});
