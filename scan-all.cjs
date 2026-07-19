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

  // 滚动到底部确保评论区加载
  await cmd('Runtime.evaluate', {expression:'window.scrollTo(0, document.body.scrollHeight)', returnByValue:true});
  await new Promise(r=>setTimeout(r,2000));

  // 简单：拿 body 全文，找评论相关部分
  const body = await cmd('Runtime.evaluate', {expression:'(document.body?.innerText||"")', returnByValue:true});
  const text = body.result?.value || '';
  // 找"评论"开始的区域
  const idx = text.indexOf('评论(');
  if(idx>=0) {
    console.log('=== Comment area ===');
    console.log(text.slice(idx, idx+800));
    console.log('=== End ===');
  } else {
    console.log('No comment area found, showing last 800 chars:');
    console.log(text.slice(-800));
  }

  // 也找所有 comment-item 的完整文本（包括兄弟节点）
  const items = await cmd('Runtime.evaluate', {expression:
    '(function(){var items=document.querySelectorAll("[class*=comment-item]");var r=[];for(var i=0;i<items.length;i++){if(!items[i].offsetParent)continue;var p=items[i].parentElement;var t=p?(p.textContent||"").slice(0,150):"";r.push("["+i+"] y="+Math.round(items[i].getBoundingClientRect().y)+": "+t.slice(0,100));}return r.join("\\n");})()',
    returnByValue:true});
  console.log('Comment items:', items.result?.value);

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),20000);
