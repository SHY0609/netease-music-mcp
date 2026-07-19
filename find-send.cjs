const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function send(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await send('Runtime.enable');

  // Find the comment placeholder and see surrounding structure
  const r = await send('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var all=document.querySelectorAll("*");',
      'for(var i=0;i<all.length;i++){',
      'var t=(all[i].textContent||"").trim();',
      'if(all[i].offsetParent && t==="留下你的精彩评论吧"){',
      'var p=all[i], html=[];',
      'for(var d=0;d<4;d++){ if(p){ html.push("L"+d+":"+p.tagName+"."+(p.className||"").toString().slice(0,40)); p=p.parentElement; } }',
      'var sib=all[i].parentElement?.parentElement?.querySelectorAll("svg,button,[role=button]");',
      'var btns=[];',
      'if(sib) for(var j=0;j<sib.length;j++){ var br=sib[j].getBoundingClientRect(); btns.push(sib[j].tagName+":w="+Math.round(br.width)+":h="+Math.round(br.height)+":y="+Math.round(br.y)); }',
      'return html.join(" > ")+" | BTNS:"+btns.join(",");',
      '}',
      '}',
      'return "ph not found";',
      '})()',
    ].join(''),
    returnByValue: true
  });
  console.log('Structure:', r.result?.value);

  // Also find ALL svg/button elements y>300
  const r2 = await send('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var res=[];',
      'var all=document.querySelectorAll("svg,button,[role=button]");',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && br.y>300 && br.width<60 && br.height<60){',
      'res.push(all[i].tagName+":w="+Math.round(br.width)+":h="+Math.round(br.height)+":y="+Math.round(br.y)+":x="+Math.round(br.x));',
      '}',
      '}',
      'return res.join(",");',
      '})()',
    ].join(''),
    returnByValue: true
  });
  console.log('Small svg/buttons y>300:', r2.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 20000);
