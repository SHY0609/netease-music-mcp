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

  // Scan all comment-item containers for text and data attributes
  const r = await cmd('Runtime.evaluate', {expression:
    '(function(){var items=document.querySelectorAll("[class*=comment-item]");var result=[];for(var i=0;i<items.length;i++){if(!items[i].offsetParent) continue;var txt=(items[i].textContent||"").slice(0,100);var y=Math.round(items[i].getBoundingClientRect().y);var attrs=[];for(var j=0;j<items[i].attributes.length;j++){attrs.push(items[i].attributes[j].name+"="+items[i].attributes[j].value.slice(0,30));}var replyBtn=items[i].querySelector("*");var btns=[];var all=items[i].querySelectorAll("*");for(var k=0;k<all.length;k++){var t=(all[k].textContent||"").trim();if(t==="回复"||t==="举报"||t==="删除"){var br=all[k].getBoundingClientRect();btns.push(t+":"+Math.round(br.x)+","+Math.round(br.y));}}result.push({y:y,txt:txt.slice(0,80),attrs:attrs.join("|"),btns:btns.join(",")});}return JSON.stringify(result.slice(0,10));})()',
    returnByValue:true});
  console.log('Comments:', (r.result?.value||'').slice(0, 2000));

  // Also show full body text for comment area
  const body = await cmd('Runtime.evaluate', {expression:'(document.body?.innerText||"").slice(-1500)',returnByValue:true});
  console.log('Body tail:', (body.result?.value||'').slice(0, 800));

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
