const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('article'));
  if(!vt){console.log('no tab');return;}
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const p=new Map();let cid=0;
  function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  // 找所有可回复的评论（非作者，有"回复"按钮）
  const r = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('span');var f=[];for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y<2500&&(t==='回复'||t==='回复中')){var ci=all[i].closest('[class*=comment-item]');var p=ci;for(var d=0;d<5;d++){p=p&&p.parentElement;}var pt=(p&&p.textContent||'').slice(0,200);if(!pt.includes('缘作者')&&!pt.includes('留下你的精彩评论吧')){f.push({y:Math.round(br.y),x:Math.round(br.x),txt:pt.slice(0,80).replace(/\\\\n/g,' ')});}}}return JSON.stringify(f);})()",
    returnByValue:true});
  console.log('Non-author replies:', (r.result?.value||'').slice(0,2000));

  ws.close();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
