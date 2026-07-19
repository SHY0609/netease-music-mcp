const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const p=new Map();let cid=0;
function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open',async()=>{
  await cmd('Runtime.enable');
  // Find "回复" SPAN whose ancestors contain "互相关注" — check ALL levels 1-8
  const r = await cmd('Runtime.evaluate',{expression:
    "(function(){var all=document.querySelectorAll('span');for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y<2500&&(t==='回复'||t==='回复中')){var p=all[i];var matchLevel=-1;for(var d=0;d<8;d++){p=p&&p.parentElement;if(p&&(p.textContent||'').includes('互相关注')){matchLevel=d;break;}}if(matchLevel>=0)return JSON.stringify({y:Math.round(br.y),matchLevel:matchLevel});}}return'not_found';})()",
    returnByValue:true});
  console.log('Found:', r.result?.value);

  // Also: try from the OTHER direction — find element with "互相关注", then find nearby 回复
  const r2 = await cmd('Runtime.evaluate',{expression:
    "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'');if(all[i].offsetParent&&t.includes('互相关注')&&all[i].children.length===0&&all[i].tagName==='SPAN'){var br=all[i].getBoundingClientRect();var parent=all[i];for(var d=0;d<8;d++){parent=parent&&parent.parentElement;}var replyBtns=parent?parent.querySelectorAll('[class*=comment-item] span'):[];var btns=[];for(var j=0;j<replyBtns.length;j++){var rt=(replyBtns[j].textContent||'').trim();if(rt==='回复'||rt==='回复中'){var rb=replyBtns[j].getBoundingClientRect();btns.push({x:Math.round(rb.x),y:Math.round(rb.y),txt:rt});}}return JSON.stringify({y:Math.round(br.y),btns:btns});}}return'not_found';})()",
    returnByValue:true});
  console.log('From 互相关注:', r2.result?.value);

  ws.close();process.exit(0);
});
setTimeout(()=>process.exit(1),20000);
