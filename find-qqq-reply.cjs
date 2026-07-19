const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const p=new Map();let cid=0;
function cmd(m,pr){return new Promise((r,j)=>{const id=++cid;p.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:pr}));setTimeout(()=>{if(p.has(id)){p.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&p.has(m.id)){const x=p.get(m.id);p.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open',async()=>{
  await cmd('Runtime.enable');
  // Scroll to top of comments
  await cmd('Runtime.evaluate',{expression:'window.scrollTo(0,0)'});
  await new Promise(r=>setTimeout(r,1000));

  // Search: find ALL elements with "回复" text, show tag + y + visibility
  const r = await cmd('Runtime.evaluate',{expression:
    "(function(){var all=document.querySelectorAll('*');var f=[];for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();var br=all[i].getBoundingClientRect();if(t==='回复'||t==='回复中'){var isQQQ=false;var pp=all[i];for(var d=0;d<8;d++){pp=pp&&pp.parentElement;if(pp&&(pp.textContent||'').includes('互相关注'))isQQQ=true;}f.push({tag:all[i].tagName,y:Math.round(br.y),vis:!!all[i].offsetParent,isQQQ:isQQQ});}}return JSON.stringify(f);})()",
    returnByValue:true});
  console.log('ALL 回复 elements:', (r.result?.value||'').slice(0, 3000));

  // Also try: find element containing "互相关注" and look nearby for clickable elements
  const r2 = await cmd('Runtime.evaluate',{expression:
    "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'');if(t.includes('互相关注')&&all[i].children.length===0&&all[i].tagName==='SPAN'){var br=all[i].getBoundingClientRect();var p=all[i];var sibs=[];if(p.parentElement){var kids=p.parentElement.children;for(var j=0;j<kids.length;j++){var kt=(kids[j].textContent||'').trim();sibs.push(kids[j].tagName+':'+kt.slice(0,20));}}return JSON.stringify({y:Math.round(br.y),tag:all[i].tagName,siblings:sibs.join(','),parentHTML:p.parentElement?.outerHTML?.slice(0,300)});}}return'not_found';})()",
    returnByValue:true});
  console.log('互相关注 element:', r2.result?.value);

  ws.close();process.exit(0);
});
setTimeout(()=>process.exit(1),20000);
