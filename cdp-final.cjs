const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Step 1: Find the RIGHT DraftEditor for THIS modal (not the recommended videos)
  const editorInfo = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var editors=document.querySelectorAll(".DraftEditor-root");',
      'var result=[];',
      'for(var i=0;i<editors.length;i++){',
      'var r=editors[i].getBoundingClientRect();',
      'result.push({idx:i,y:Math.round(r.y),vis:!!editors[i].offsetParent,',
      'parent5:(editors[i].parentElement?.parentElement?.parentElement?.parentElement?.parentElement?.textContent||"").slice(0,50)',
      '});',
      '}',
      'return JSON.stringify(result);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('DraftEditors:', editorInfo.result?.value);

  // Step 2: Focus the FIRST visible DraftEditor (should be the comment input)
  const focus = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector(".DraftEditor-root");',
      'if(!ed) return "no editor";',
      'ed.focus();',
      'ed.click();',
      'return "focused";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Focus:', focus.result?.value);
  await new Promise(r=>setTimeout(r,500));

  // Step 3: Try Input.insertText first (simplest)
  try {
    await cmd('Input.insertText', { text: 'CDPtest' });
    console.log('insertText done');
  } catch(e) {
    console.log('insertText failed:', e.message);

    // Fallback: type via key events
    const txt = 'CDPtest';
    for (const ch of txt) {
      await cmd('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: ch.charCodeAt(0) });
      await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
      await cmd('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: ch.charCodeAt(0) });
      await new Promise(r=>setTimeout(r,40));
    }
    console.log('keyEvent typing done');
  }
  await new Promise(r=>setTimeout(r,2000));

  // Step 4: Find the ARROW SEND button
  // It's a small element near the DraftEditor, likely an SVG or button
  const sendBtn = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector(".DraftEditor-root");',
      'if(!ed) return "no editor";',
      // Go up to find the comment input container
      'var container=ed.closest("[class*=comment]")||ed.closest("[class*=input]")||ed.parentElement?.parentElement?.parentElement;',
      'if(!container) container=ed.closest("div");',
      // Search in container for arrow send button (small svg/button/icon)
      'var all=container.querySelectorAll("*");',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'var tag=all[i].tagName;',
      // Send button: small (>10x10 <60x60), near the editor area
      'if(all[i].offsetParent && br.width>10 && br.width<60 && br.height>10 && br.height<60',
      '&& br.y>300',
      '&& (tag==="svg"||tag==="path"||tag==="BUTTON"||tag==="use"||all[i].getAttribute("role")==="button"',
      '||(all[i].className||"").toString().includes("send")',
      '||(all[i].className||"").toString().includes("submit")',
      '||(all[i].className||"").toString().includes("arrow")',
      '||(all[i].className||"").toString().includes("publish")',
      ')){',
      'return JSON.stringify({tag:tag,x:Math.round(br.left+br.width/2),y:Math.round(br.top+br.height/2),w:Math.round(br.width),h:Math.round(br.height),cls:(all[i].className||"").toString().slice(0,40)});',
      '}',
      '}',
      // Broader search: any small button/svg near the bottom
      'var bodyBtns=document.querySelectorAll("svg,button,[role=button]");',
      'for(var j=0;j<bodyBtns.length;j++){',
      'var br2=bodyBtns[j].getBoundingClientRect();',
      'if(bodyBtns[j].offsetParent && br2.y>300 && br2.width>10 && br2.width<60 && br2.height>10 && br2.height<60){',
      'return JSON.stringify({tag:bodyBtns[j].tagName,x:Math.round(br2.left+br2.width/2),y:Math.round(br2.top+br2.height/2),w:Math.round(br2.width),h:Math.round(br2.height),yPos:Math.round(br2.y),cls:(bodyBtns[j].className||"").toString().slice(0,40)});',
      '}',
      '}',
      'return "no send btn";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send button:', sendBtn.result?.value);

  // Step 5: Click the send button if found
  if (sendBtn.result?.value && sendBtn.result.value !== '"no send btn"') {
    const btn = JSON.parse(sendBtn.result.value);
    console.log('Clicking:', btn);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:btn.x,y:btn.y});
    await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:btn.x,y:btn.y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,150));
    await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:btn.x,y:btn.y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,2000));

    // Verify
    const check = await cmd('Runtime.evaluate', {
      expression: '(document.body?.innerText||"").slice(-300)',
      returnByValue: true
    });
    console.log('Result:', check.result?.value?.slice(0,400));
  }

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
