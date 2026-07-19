const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const TEXT = 'x';
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // 1. Focus editor + clear + insert
  await cmd('Runtime.evaluate', {
    expression: '(function(){var ed=document.querySelector("[class*=DraftEditor-root] [contenteditable]");if(!ed)return;ed.focus();document.execCommand("selectAll",false,null);document.execCommand("delete",false,null);document.execCommand("insertText",false,"SentFromCDP");return ed.textContent;})()',
    returnByValue: true
  });
  await new Promise(r=>setTimeout(r,2000));

  // 2. Get position of wchsYBpK send button
  const pos = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var btn=document.querySelector(".wchsYBpK.jfGCpJo0");',
      'if(!btn) return "null";',
      'var r=btn.getBoundingClientRect();',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send btn pos:', pos.result?.value);

  // 3. Also check what the SVG looks like (is it enabled?)
  const svgInfo = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var btn=document.querySelector(".wchsYBpK.jfGCpJo0");',
      'if(!btn) return "no btn";',
      'var svg=btn.querySelector("svg");',
      'return "SVG:"+(svg?svg.outerHTML.slice(0,300):"no svg")+" BTN:"+btn.outerHTML.slice(0,200);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send btn HTML:', (svgInfo.result?.value||'').slice(0, 500));

  // 4. Click it!
  if (pos.result?.value && pos.result.value !== 'null') {
    const {x,y} = JSON.parse(pos.result.value);
    console.log('Clicking send at', x, y);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,150));
    await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,3000));

    // Verify
    const check = await cmd('Runtime.evaluate', {
      expression: '(document.body?.innerText||"").slice(-300)',
      returnByValue: true
    });
    console.log('After click:', (check.result?.value||'').slice(0, 400));
  }

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 25000);
