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

  // 监控：每2秒抓一次编辑器状态和DOM变化
  console.log('Monitoring... go click the reply button in VNC now!');
  for(var round=0; round<10; round++){
    const state = await cmd('Runtime.evaluate', {expression:
      "(function(){var ce=document.querySelector('[contenteditable=true]');var txt=ce?ce.textContent.slice(0,80):'no ce';var ph=!!document.body?.innerText?.includes('留下你的精彩评论吧');return JSON.stringify({edTxt:txt,hasPH:ph,activeTag:document.activeElement?.tagName});})()",
      returnByValue:true});
    console.log('Round',round,':', state.result?.value);
    await new Promise(r=>setTimeout(r,2000));
  }

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),25000);
