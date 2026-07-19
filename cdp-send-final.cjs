const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Find the 3rd SPAN (x=443) in commentInput-right-ct and click it via CDP
  const pos = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ct=document.querySelector(".commentInput-right-ct");',
      'if(!ct) return "null";',
      'var spans=ct.querySelectorAll("span");',
      '// The last (rightmost) span is the send button',
      'var sendBtn=spans[spans.length-1];',
      'if(!sendBtn) return "null";',
      'var r=sendBtn.getBoundingClientRect();',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),idx:spans.length-1,svg:sendBtn.innerHTML.slice(0,100)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send btn:', pos.result?.value);

  if (pos.result?.value && pos.result.value !== 'null') {
    const btn = JSON.parse(pos.result.value);
    console.log('Clicking at', btn.x, btn.y);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:btn.x,y:btn.y});
    await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:btn.x,y:btn.y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,200));
    await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:btn.x,y:btn.y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,3000));

    // Verify
    const check = await cmd('Runtime.evaluate', {
      expression: '(document.body?.innerText||"").slice(-300)',
      returnByValue: true
    });
    console.log('RESULT:', (check.result?.value||'').slice(0, 400));
  }

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 20000);
