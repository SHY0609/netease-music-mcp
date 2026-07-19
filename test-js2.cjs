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

  // 宽松搜索：任何包含"回复"的 SPAN，在 @？？？ 评论附近
  const r = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('span');var f=[];for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>300&&br.y<2500&&t.includes('回复')&&t.length<10){var p=all[i].closest('[class*=comment-item]');var pp=p;for(var d=0;d<5;d++){pp=pp&&pp.parentElement;}var pt=(pp&&pp.textContent||'').slice(0,400);f.push({y:Math.round(br.y),x:Math.round(br.x),txt:t,hasQ:pt.includes('@？？？'),has互:pt.includes('互相关注'),pt:pt.slice(0,80).replace(/\\n/g,' ')});}}return JSON.stringify(f);})()",
    returnByValue:true});
  console.log('All reply spans:', (r.result?.value||'').slice(0, 3000));

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
