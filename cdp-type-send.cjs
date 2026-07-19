const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const TEXT = "CDP发送测试!";
const pending = new Map(); let cid = 0;
function send(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  console.log('Connected, filling Draft.js editor...');
  await send('Runtime.enable');

  // 1. Click the placeholder to focus the editor
  const pos = await send('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var all=document.querySelectorAll("*");',
      'for(var i=0;i<all.length;i++){',
      'var t=(all[i].textContent||"").trim();',
      'var r=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && r.y>300 && t==="留下你的精彩评论吧"){',
      'return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});',
      '}}',
      'return "null";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  const clickPos = pos?.result?.value;
  console.log('Placeholder at:', clickPos);

  if (clickPos && clickPos !== 'null') {
    const {x,y} = JSON.parse(clickPos);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,200));
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await new Promise(r=>setTimeout(r,2000));
  }

  // 2. Type each character via CDP keyEvent (Draft.js handles native keyboard)
  for (const ch of TEXT) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
    await new Promise(r=>setTimeout(r,50));
  }
  await new Promise(r=>setTimeout(r,1500));
  console.log('Typed:', TEXT);

  // 3. Check if send button appeared
  const btns = await send('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var res=[];',
      'var all=document.querySelectorAll("svg,button,[role=button]");',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && br.y>300 && br.width<80 && br.height<80){',
      'res.push(all[i].tagName+":w="+Math.round(br.width)+":h="+Math.round(br.height)+":y="+Math.round(br.y)+":x="+Math.round(br.x));',
      '}}',
      'return res.join(",");',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Buttons after typing:', btns.result?.value);

  // 4. Click send button (if any new small button appeared near the editor)
  const sendBtn = await send('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var editor=document.querySelector(".DraftEditor-root");',
      'if(!editor) return "no editor";',
      'var parent=editor.closest("[class*=comment],[class*=input],[class*=reply]")||editor.parentElement?.parentElement?.parentElement;',
      'if(!parent) return "no parent";',
      'var btns=parent.querySelectorAll("svg,button,[role=button]");',
      'for(var i=0;i<btns.length;i++){',
      'var br=btns[i].getBoundingClientRect();',
      'if(btns[i].offsetParent && br.width>10 && br.width<60 && br.height>10 && br.height<60){',
      'btns[i].click();',
      'btns[i].dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));',
      'return "clicked:"+btns[i].tagName+":w="+Math.round(br.width);',
      '}}',
      'return "no send btn in parent";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send click:', sendBtn.result?.value);

  await new Promise(r=>setTimeout(r,2000));
  const v = await send('Runtime.evaluate', {
    expression: '(document.body?.innerText||"").slice(-400)',
    returnByValue: true
  });
  console.log('AFTER:', v.result?.value?.slice(0,400));

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 30000);
