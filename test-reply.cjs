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

  // 1. Find comment containing "老公想要" and click its "回复"
  const pos = await cmd('Runtime.evaluate', {expression:
    '(function(){var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){var t=(all[i].textContent||"").trim();var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>300&&t==="回复"){var p=all[i].parentElement?.parentElement;var pt=p?p.textContent:"";if(pt.includes("老公想要")){return JSON.stringify({x:Math.round(br.left+br.width/2),y:Math.round(br.top+br.height/2)});}}}return"null";})()',
    returnByValue:true});
  console.log('Reply btn:', pos.result?.value);

  if(pos.result?.value && pos.result.value!=='null'){
    const {x,y}=JSON.parse(pos.result.value);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,150));
    await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,2500));

    // Check what's in the editor now
    const editor = await cmd('Runtime.evaluate', {expression:
      '(function(){var ce=document.querySelector("[contenteditable=true]");if(!ce)return"no ce";return"txt:"+(ce.textContent||"").slice(0,60)+" tag:"+ce.tagName;})()',
      returnByValue:true});
    console.log('Editor after reply click:', editor.result?.value);
  }

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),25000);
