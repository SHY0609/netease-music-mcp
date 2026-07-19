const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Search RIGHT side (x>300) for ANY small elements near editor y
  const r = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'var er=ed?ed.getBoundingClientRect():null;',
      'var ey=er?Math.round(er.y):465;',
      'var all=document.querySelectorAll("*");',
      'var found=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'var tag=all[i].tagName;',
      'if(all[i].offsetParent && br.x>300 && br.y>ey-30 && br.y<ey+100 && br.width>10 && br.width<80 && br.height>10 && br.height<80){',
      'found.push({tag:tag,y:Math.round(br.y),x:Math.round(br.x),w:Math.round(br.width),h:Math.round(br.height),cls:(all[i].className||"").toString().slice(0,50),html:(all[i].outerHTML||"").slice(0,100)});',
      '}',
      '}',
      'return JSON.stringify({ey:ey,edTxt:(ed?.textContent||"").slice(0,30),right:found.slice(0,15)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Right side x>300:', (r.result?.value||'').slice(0, 1500));

  // Also: search the ENTIRE page for any arrow/send-like elements
  const all = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var all=document.querySelectorAll("*");',
      'var got=[];',
      'for(var i=0;i<all.length;i++){',
      'var tag=all[i].tagName;',
      'var br=all[i].getBoundingClientRect();',
      'var cls=(all[i].className||"").toString();',
      'if(all[i].offsetParent && br.y>300 && br.width>10 && br.width<60 && br.height>10 && br.height<60 &&',
      '(cls.includes("send")||cls.includes("Send")||cls.includes("submit")||',
      'cls.includes("publish")||cls.includes("arrow")||cls.includes("Arrow")||',
      'tag==="svg"||tag==="path"||tag==="use"||',
      'cls.includes("icon")||cls.includes("Icon"))){',
      'got.push({tag:tag,y:Math.round(br.y),x:Math.round(br.x),w:Math.round(br.width),cls:cls.slice(0,40)});',
      '}',
      '}',
      'return JSON.stringify(got.slice(0,20));',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('All arrow/send-like:', all.result?.value?.slice(0, 1000));

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 20000);
