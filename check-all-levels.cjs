const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const p=new Map();let cid=0;
function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open',async()=>{
  await cmd('Runtime.enable');
  // For the reply at y=-821 (1分享回复 = @？？？'s), check all parent levels
  const r = await cmd('Runtime.evaluate',{expression:
    "(function(){var all=document.querySelectorAll('span');for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y===-821&&(t==='回复'||t==='回复中')){var ci=all[i].closest('[class*=comment-item]');var pp=ci;var levels=[];for(var d=0;d<8;d++){pp=pp&&pp.parentElement;if(pp){levels.push('L'+d+':'+(pp.textContent||'').slice(0,80).replace(/\\\\n/g,' '));}}return JSON.stringify(levels);}}return'not_found';})()",
    returnByValue:true});
  console.log('y=-821 levels:', r.result?.value);

  ws.close();process.exit(0);
});
setTimeout(()=>process.exit(1),20000);
