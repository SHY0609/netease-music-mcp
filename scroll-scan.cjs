const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const p=new Map();let cid=0;
function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open',async()=>{
  await cmd('Runtime.enable');
  for(let i=0;i<3;i++){await cmd('Runtime.evaluate',{expression:'window.scrollTo(0,3000)'});await new Promise(r=>setTimeout(r,2000));}
  const r = await cmd('Runtime.evaluate',{expression: "(function(){var all=document.querySelectorAll('span');var f=[];for(var i=0;i<all.length;i++){var t=all[i].textContent||'';var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>200&&br.y<2500&&(t==='回复'||t==='回复中')){var pp=all[i];for(var d=0;d<6;d++){pp=pp&&pp.parentElement;}var pt=(pp&&pp.textContent||'');f.push({y:Math.round(br.y),hasQ:pt.includes('@？？？'),has互:pt.includes('互相关注'),pt:pt.slice(0,50)});}}return JSON.stringify(f);})()", returnByValue:true});
  console.log((r.result?.value||'').slice(0,2000));
  ws.close();process.exit(0);
});
setTimeout(()=>process.exit(1),25000);
