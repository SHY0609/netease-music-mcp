const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('modal_id'));
  if(!vt) { console.log('no tab'); return; }
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const pending = new Map(); let cid=0;
  function cmd(m,p){return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  // 找所有"回复"按钮，打印其所在评论的文本+位置
  const r = await cmd('Runtime.evaluate', {expression:
    '(function(){var all=document.querySelectorAll("*");var found=[];for(var i=0;i<all.length;i++){var t=(all[i].textContent||"").trim();var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>300&&t==="回复"&&all[i].tagName==="SPAN"){var p=all[i].parentElement;for(var d=0;d<5;d++){if(p&&(p.textContent||"").length>30){var txt=(p.textContent||"").slice(0,100);found.push({y:Math.round(br.y),x:Math.round(br.x),txt:txt.replace(/\\n/g," ")});break;}p=p.parentElement;}}}return JSON.stringify(found);})()',
    returnByValue:true});
  console.log('All reply btns:', (r.result?.value||'').slice(0, 1500));

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
