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

  // JS click on "回复" button for @？？？ comment
  const r = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>300&&br.y<2500&&(t==='回复'||t==='回复中')&&all[i].tagName==='SPAN'){var c=all[i].closest('[class*=comment-item]');var p=c;for(var d=0;d<5;d++){p=p&&p.parentElement;}var pt=(p&&p.textContent||'');if(pt.includes('@？？？')){console.log('FOUND REPLY at y='+Math.round(br.y)+' x='+Math.round(br.x)+' txt='+t);all[i].click();all[i].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));if(all[i].parentElement){all[i].parentElement.click();all[i].parentElement.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));}return 'clicked:'+t+':y='+Math.round(br.y)+':x='+Math.round(br.x);}}}return'not_found';})()",
    returnByValue:true});
  console.log('Result:', r.result?.value);

  // Wait and verify
  await new Promise(r=>setTimeout(r,3000));
  const verify = await cmd('Runtime.evaluate', {expression: "!!document.body?.innerText?.includes('回复中')", returnByValue:true});
  console.log('Has 回复中:', verify.result?.value);

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
