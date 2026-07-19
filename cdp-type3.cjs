const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const TEXT = "test123";
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Type each char via CDP
  for (const ch of TEXT) {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: ch.charCodeAt(0) });
    await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: ch.charCodeAt(0) });
    await new Promise(r=>setTimeout(r,30));
  }
  await new Promise(r=>setTimeout(r,2000));

  // Simple check: does body contain our text?
  const body = await cmd('Runtime.evaluate', {
    expression: '(document.body?.innerText||"")',
    returnByValue: true
  });
  console.log('Body contains test123:', (body.result?.value||'').includes('test123'));
  console.log('Body tail:', (body.result?.value||'').slice(-200));

  // Find ALL buttons/SVGs below y=400
  const btns = await cmd('Runtime.evaluate', {
    expression: '(function(){var r=[];var all=document.querySelectorAll("*");for(var i=0;i<all.length;i++){var br=all[i].getBoundingClientRect();if(all[i].offsetParent&&br.y>400&&br.width>10&&br.width<80&&br.height>10&&br.height<80&&(all[i].tagName==="svg"||all[i].tagName==="BUTTON"||all[i].tagName==="path"||all[i].tagName==="use"||all[i].getAttribute("role")==="button")){r.push(all[i].tagName+":"+Math.round(br.y)+":"+Math.round(br.x)+":"+Math.round(br.w)+"x"+Math.round(br.h)+":"+(all[i].className||"").toString().slice(0,30));}}return r.join("|");})()',
    returnByValue: true
  });
  console.log('Buttons >y400:', btns.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
