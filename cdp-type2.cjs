const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const TEXT = "CDPtest";
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // 1. Find and focus the DraftEditor
  const r = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector(".DraftEditor-root");',
      'if(!ed) return "no DraftEditor";',
      'ed.focus();',
      '// Clear existing content - select all and delete',
      'var sel=window.getSelection();',
      'var range=document.createRange();',
      'range.selectNodeContents(ed);',
      'sel.removeAllRanges();',
      'sel.addRange(range);',
      '// Delete via execCommand',
      'document.execCommand("delete", false, null);',
      'return "cleared";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Clear:', r.result?.value);

  await new Promise(r=>setTimeout(r,1000));

  // 2. Type with full key sequence: keyDown + char + keyUp
  for (const ch of TEXT) {
    const key = ch.charCodeAt(0);
    // keyDown with keyCode
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key'+ch.toUpperCase(), keyCode: key, windowsVirtualKeyCode: key });
    await new Promise(r=>setTimeout(r,20));
    // char event
    await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch, code: 'Key'+ch.toUpperCase(), keyCode: key });
    await new Promise(r=>setTimeout(r,20));
    // keyUp
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key'+ch.toUpperCase(), keyCode: key, windowsVirtualKeyCode: key });
    await new Promise(r=>setTimeout(r,20));
  }
  console.log('Typed:', TEXT);
  await new Promise(r=>setTimeout(r,2000));

  // 3. Check content and find send button
  const check = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector(".DraftEditor-root");',
      'var txt=ed?ed.textContent:"";',
      '// Find all nearby small buttons/SVGs',
      'var container=ed?ed.closest("[class*=comment],[class*=input],[class*=reply],[class*=footer]")||ed.parentElement?.parentElement:null;',
      'if(!container) container=document.body;',
      'var btns=container.querySelectorAll("svg,button,[role=button]");',
      'var result=[];',
      'for(var i=0;i<btns.length;i++){',
      'var br=btns[i].getBoundingClientRect();',
      'if(btns[i].offsetParent && br.width>10 && br.width<60 && br.height>10 && br.height<60){',
      'result.push(btns[i].tagName+":w="+Math.round(br.width)+":h="+Math.round(br.height)+":cls="+(btns[i].className||"").toString().slice(0,30));',
      '}}',
      'return "TXT:"+txt.slice(0,30)+" BTNS:"+result.join(",");',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('After type:', check.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
