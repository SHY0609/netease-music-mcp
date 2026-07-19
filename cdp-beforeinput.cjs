const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  const result = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      // 1. Clear existing content first
      'var ed=document.querySelector("[class*=DraftEditor-root] [contenteditable=true]");',
      'if(!ed) return "no editable";',
      'ed.focus();',
      // Select all and delete
      'var sel=window.getSelection();',
      'var range=document.createRange();',
      'range.selectNodeContents(ed);',
      'sel.removeAllRanges();sel.addRange(range);',
      'document.execCommand("delete", false, null);',
      // 2. Insert text using beforeinput + input events (Draft.js listens for these)',
      'var textNode=document.createTextNode("SentFromCDP!");',
      'var beforeInput=new InputEvent("beforeinput",{',
      'inputType:"insertText",',
      'data:"SentFromCDP!",',
      'bubbles:true, cancelable:true',
      '});',
      '// Insert text node at cursor',
      'var newRange=document.createRange();',
      'newRange.setStart(ed, ed.childNodes.length);',
      'newRange.collapse(true);',
      'sel.removeAllRanges();sel.addRange(newRange);',
      // Dispatch beforeinput
      'ed.dispatchEvent(beforeInput);',
      // Insert the text',
      'newRange.insertNode(textNode);',
      'newRange.collapse(false);',
      // Dispatch input event',
      'var inputEv=new InputEvent("input",{',
      'inputType:"insertText",',
      'data:"SentFromCDP!",',
      'bubbles:true, cancelable:false',
      '});',
      'ed.dispatchEvent(inputEv);',
      'return "done, txt:"+ed.textContent;',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('beforeinput:', result.result?.value);

  await new Promise(r=>setTimeout(r,2000));

  // Check if send button appeared
  const check = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ct=document.querySelector(".commentInput-right-ct");',
      'if(!ct) return "no right-ct";',
      'var all=ct.querySelectorAll("*");',
      'var vis=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'var tag=all[i].tagName;',
      'if(all[i].offsetParent && br.width>10 && br.height>10){',
      'vis.push(tag+":"+Math.round(br.width)+"x"+Math.round(br.height)+":"+(all[i].className||"").toString().slice(0,30));',
      '}',
      '}',
      'return "visible("+vis.length+"):"+vis.join(",");',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Send area:', check.result?.value?.slice(0, 500));

  // Check text
  const txt = await cmd('Runtime.evaluate', {
    expression: 'document.querySelector("[class*=DraftEditor-root]")?.textContent||"none"',
    returnByValue: true
  });
  console.log('Text:', txt.result?.value);

  // Try clicking all 4 SVGs in the commentInput-right-ct container
  const clickAll = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ct=document.querySelector(".commentInput-right-ct");',
      'if(!ct) return "no ct";',
      'var svgs=ct.querySelectorAll("svg");',
      'var clicked=[];',
      'for(var i=svgs.length-1;i>=0;i--){',
      'var br=svgs[i].getBoundingClientRect();',
      'if(br.width>0 && br.height>0){',
      'svgs[i].dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));',
      'clicked.push("svg"+i+":"+Math.round(br.width)+"x"+Math.round(br.height));',
      '}',
      '}',
      'return "clicked:"+clicked.join(",");',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Click SVGs:', clickAll.result?.value);

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 25000);
