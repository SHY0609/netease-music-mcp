const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('modal_id'));
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const pending = new Map(); let cid=0;
  function cmd(m,p){return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  // 编辑器
  const ed = await cmd('Runtime.evaluate', {expression: "(function(){var ce=document.querySelector('[contenteditable=true]');if(!ce)return 'no ce';return JSON.stringify({txt:ce.textContent.slice(0,100),y:Math.round(ce.getBoundingClientRect().y)});})()", returnByValue:true});
  console.log('Editor:', ed.result?.value);

  // 所有输入框
  const all = await cmd('Runtime.evaluate', {expression: "JSON.stringify(Array.from(document.querySelectorAll('[contenteditable=true],textarea')).map(function(e){var r=e.getBoundingClientRect();return{tag:e.tagName,y:Math.round(r.y),w:Math.round(r.width),vis:!!e.offsetParent,txt:(e.textContent||e.value||'').slice(0,60)};}))", returnByValue:true});
  console.log('All inputs:', all.result?.value);

  // body 尾部
  const body = await cmd('Runtime.evaluate', {expression: "(document.body?.innerText||'').slice(-500)", returnByValue:true});
  console.log('Body tail:', (body.result?.value||'').slice(0, 500));

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
