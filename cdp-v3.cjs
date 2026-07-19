const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Clear editor content first
  await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return;',
      'ed.focus();',
      'var sel=window.getSelection();',
      'var range=document.createRange();',
      'range.selectNodeContents(ed);',
      'sel.removeAllRanges();sel.addRange(range);',
      'document.execCommand("delete",false,null);',
      'return "cleared:"+ed.textContent;',
      '})()'
    ].join(''),
    returnByValue: true
  });
  await new Promise(r=>setTimeout(r,500));

  // 1. CDP click on editor to activate
  const pos = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return "null";',
      'var r=ed.getBoundingClientRect();',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  const {x,y} = JSON.parse(pos.result.value);
  console.log('Click editor at:', x, y);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
  await new Promise(r=>setTimeout(r,150));
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  await new Promise(r=>setTimeout(r,2000));

  // 2. Clear again + type one character via CDP keyDown/char/keyUp
  const ch = 'A';
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, windowsVirtualKeyCode: 65 });
  await new Promise(r=>setTimeout(r,20));
  await cmd('Input.dispatchKeyEvent', { type: 'char', text: ch });
  await new Promise(r=>setTimeout(r,20));
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: 65 });
  await new Promise(r=>setTimeout(r,1500));

  // 3. Check: editor text + find ALL elements near editor y
  const check = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'var txt=ed?ed.textContent:"";',
      'var er=ed?ed.getBoundingClientRect():null;',
      'var ey=er?Math.round(er.y):-1;',
      // Find ALL visible elements in a 100px band around the editor
      'var all=document.querySelectorAll("*");',
      'var near=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'var tag=all[i].tagName;',
      'if(all[i].offsetParent && br.y>ey-20 && br.y<ey+100 && br.width>10 && br.width<80 && br.height>10 && br.height<80){',
      'near.push({tag:tag,y:Math.round(br.y),x:Math.round(br.x),w:Math.round(br.width),h:Math.round(br.height),cls:(all[i].className||"").toString().slice(0,40),txt:(all[i].textContent||"").slice(0,10)});',
      '}',
      '}',
      'return JSON.stringify({txt:txt.slice(0,30),ey:ey,near:near.slice(0,20)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('After typing:', check.result?.value?.slice(0, 1200));

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 25000);
