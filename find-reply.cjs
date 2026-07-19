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

  // body 文本中搜"回复"
  const body = await cmd('Runtime.evaluate', {expression:'(document.body?.innerText||"")',returnByValue:true});
  const txt = body.result?.value||'';
  var count=0;
  for(var i=0;i<txt.length;i++){if(txt.slice(i,i+2)==='回复'){console.log('body idx',i,'near:',txt.slice(Math.max(0,i-15),i+30).replace(/\n/g,' '));count++;}}
  console.log('Total:',count);

  // DOM 中搜
  const r = await cmd('Runtime.evaluate', {expression:
    '(function(){var all=document.querySelectorAll("*");var f=[];for(var i=0;i<all.length;i++){var t=(all[i].textContent||"");if(t==="回复"&&all[i].children.length===0){f.push(all[i].tagName+":"+(all[i].offsetParent?"v":"h"));}}return f.join(",");})()',
    returnByValue:true});
  console.log('DOM:', r.result?.value);

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
