const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('article'));
  if(!vt) { console.log('no article tab'); return; }
  console.log('Tab:', vt.url.slice(0,80));
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const p=new Map();let cid=0;
  function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  const r = await cmd('Runtime.evaluate', {expression:
    "JSON.stringify({ces:document.querySelectorAll('[contenteditable]').length,tas:document.querySelectorAll('textarea').length,hasDraft:!!document.querySelector('[class*=DraftEditor]'),hasPH:!!document.body?.innerText?.includes('留下你的精彩评论吧'),tail:(document.body?.innerText||'').slice(-500)})",
    returnByValue:true});
  console.log('State:', (r.result?.value||'').slice(0,1000));

  ws.close();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
