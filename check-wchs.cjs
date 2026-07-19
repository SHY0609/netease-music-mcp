const WebSocket = require('ws');
const http = require('http');
function httpGet(url){return new Promise((r,j)=>{http.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d))}catch(e){j(e)}});}).on('error',j);});}
(async()=>{
  const tabs = await httpGet('http://127.0.0.1:9222/json');
  const vt = tabs.find(t=>t.url.includes('article'));
  if(!vt){console.log('no article tab');return;}
  const ws = new WebSocket(vt.webSocketDebuggerUrl);
  const p=new Map();let cid=0;
  function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
  ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
  await new Promise(r=>ws.on('open',r));
  await cmd('Runtime.enable');

  // Check if wchsYBpK exists
  const r1 = await cmd('Runtime.evaluate', {expression:
    "document.querySelectorAll('.wchsYBpK.jfGCpJo0').length",
    returnByValue:true});
  console.log('wchs count:', r1.result?.value);

  // Find ALL spans with SVG near the editor (y<200, 36x36)
  const r2 = await cmd('Runtime.evaluate', {expression:
    "(function(){var spans=document.querySelectorAll('span');var f=[];for(var i=0;i<spans.length;i++){var r=spans[i].getBoundingClientRect();if(spans[i].offsetParent&&Math.round(r.width)===36&&Math.round(r.height)===36&&r.y<200){f.push({x:Math.round(r.x),y:Math.round(r.y),cls:spans[i].className.slice(0,40),html:spans[i].innerHTML.slice(0,80)});}}return JSON.stringify(f);})()",
    returnByValue:true});
  console.log('36x36 spans y<200:', (r2.result?.value||'').slice(0,1000));

  // Also check: does clicking wchs actually send? Try JS click it
  const r3 = await cmd('Runtime.evaluate', {expression:
    "(function(){var btn=document.querySelector('.wchsYBpK.jfGCpJo0');if(!btn)return'no btn';btn.click();btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return'clicked:'+btn.className.slice(0,30);})()",
    returnByValue:true});
  console.log('Click wchs:', r3.result?.value);

  ws.close();process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
