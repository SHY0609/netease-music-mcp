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

  // 找所有正文中含\"互相关注\"的元素
  const r = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('*');var f=[];for(var i=0;i<all.length;i++){var t=all[i].textContent||'';if(t.includes('互相关注')&&all[i].children.length<3){var br=all[i].getBoundingClientRect();f.push({tag:all[i].tagName,y:Math.round(br.y),x:Math.round(br.x),vis:!!all[i].offsetParent,txt:t.slice(0,60)});}}return JSON.stringify(f.slice(0,10));})()",
    returnByValue:true});
  console.log('互相关注 elements:', (r.result?.value||'').slice(0, 1000));

  // 找@？？？附近的回复按钮——搜任意tag
  const r2 = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('*');var f=[];for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>200&&t==='回复'&&all[i].children.length<2){var tag=all[i].tagName;var pp=all[i];for(var d=0;d<6;d++){pp=pp&&pp.parentElement;}var pt=(pp&&pp.textContent||'').slice(0,200);f.push({tag:tag,y:Math.round(br.y),x:Math.round(br.x),hasQ:pt.includes('@？？？'),has互:pt.includes('互相关注'),pt:pt.slice(0,60).replace(/\\n/g,' ')});}}return JSON.stringify(f);})()",
    returnByValue:true});
  console.log('All reply btns (any tag):', (r2.result?.value||'').slice(0, 2000));

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
