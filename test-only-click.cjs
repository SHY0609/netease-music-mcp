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

  // 1. 检查是否有旧"回复中"
  let old = await cmd('Runtime.evaluate', {expression:"!!document.body?.innerText?.includes('回复中')",returnByValue:true});
  console.log('Has 回复中 before:', old.result?.value);

  // 2. 如果有，先取消——点一下"回复中"变回"回复"
  if (old.result?.value) {
    const cancel = await cmd('Runtime.evaluate', {expression:
      "(function(){var all=document.querySelectorAll('span');for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&t==='回复中'){var p=all[i].parentElement;if(p){p.click();p.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));}return 'canceled';}}return 'not_found';})()",
      returnByValue:true});
    console.log('Cancel:', cancel.result?.value);
    await new Promise(r=>setTimeout(r,2000));
    old = await cmd('Runtime.evaluate', {expression:"!!document.body?.innerText?.includes('回复中')",returnByValue:true});
    console.log('Has 回复中 after cancel:', old.result?.value);
  }

  // 3. 点 @？？？的回复
  const click = await cmd('Runtime.evaluate', {expression:
    "(function(){var all=document.querySelectorAll('span');for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>200&&br.y<2500&&(t==='回复'||t==='回复中')){var c=all[i].closest('[class*=comment-item]');var p=c;for(var d=0;d<5;d++){p=p&&p.parentElement;}var pt=(p&&p.textContent||'');if(pt.includes('互相关注')){var parent=all[i].parentElement;parent.click();parent.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return JSON.stringify({x:Math.round(br.x),y:Math.round(br.y),txt:t});}}}return'not_found';})()",
    returnByValue:true});
  console.log('Click:', click.result?.value);

  await new Promise(r=>setTimeout(r,3000));

  // 4. 验证
  const check = await cmd('Runtime.evaluate', {expression:"!!document.body?.innerText?.includes('回复中')",returnByValue:true});
  console.log('Has 回复中 after click:', check.result?.value);

  // 5. 看编辑器有没有@？？？前缀
  const editor = await cmd('Runtime.evaluate', {expression:
    "(function(){var ce=document.querySelector('[contenteditable=true]');return ce?ce.textContent.slice(0,80):'no ce';})()",
    returnByValue:true});
  console.log('Editor:', editor.result?.value);

  ws.close(); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
setTimeout(()=>process.exit(1),25000);
