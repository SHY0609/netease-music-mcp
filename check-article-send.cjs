const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('article'));
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const p=new Map();let cid=0;
  function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  // Find the comment editor and its surrounding buttons
  const r = await cmd('Runtime.evaluate', {expression:
    "(function(){var result={};var ce=document.querySelector('[contenteditable=true]');if(ce){var r=ce.getBoundingClientRect();result.editor={x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)};var container=ce.closest('[class*=comment]')||ce.parentElement;if(container){var btns=container.querySelectorAll('span,svg,button');var near=[];for(var i=0;i<btns.length;i++){var br=btns[i].getBoundingClientRect();if(btns[i].offsetParent&&br.width>10){near.push({tag:btns[i].tagName,y:Math.round(br.y),x:Math.round(br.x),w:Math.round(br.width),html:btns[i].outerHTML.slice(0,150)});}}result.nearbyBtns=near.slice(0,15);}}else{result.editor='no ce';}return JSON.stringify(result);})()",
    returnByValue:true});
  console.log('Result:', (r.result?.value||'').slice(0,2000));

  ws.close();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
