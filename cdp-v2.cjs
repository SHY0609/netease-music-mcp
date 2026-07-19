const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/16B1D671F22714812C845BEF1956C575');
const pending = new Map(); let cid = 0;
function cmd(m, p) { return new Promise((r,j)=>{const id=++cid;pending.set(id,{resolve:r,reject:j});ws.send(JSON.stringify({id,method:m,params:p}));setTimeout(()=>{if(pending.has(id)){pending.delete(id);j(new Error('timeout'));}},10000);});}
ws.on('message',d=>{try{const m=JSON.parse(d.toString());if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(new Error(m.error.message)):x.resolve(m.result);}}catch{}});
ws.on('open', async () => {
  await cmd('Runtime.enable');

  // Check DraftEditor content after insertText
  const check = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector(".DraftEditor-root");',
      'if(!ed) return "no editor";',
      'var inner=ed.querySelector("[data-text=true],.public-DraftEditor-content");',
      'var txt=inner?inner.textContent:ed.textContent;',
      'var spans=ed.querySelectorAll("span[data-text=true]");',
      'var spanTexts=[];',
      'for(var i=0;i<spans.length;i++) spanTexts.push(spans[i].textContent);',
      'return JSON.stringify({txt:txt.slice(0,50),spans:spanTexts.join("|").slice(0,100),edHTML:ed.outerHTML.slice(0,500)});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('Editor state:', (check.result?.value||'').slice(0,800));

  // Force text into DraftEditor using React internal state
  const forceText = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return "no ed";',
      // Try to find React fiber
      'var key=Object.keys(ed).find(k=>k.startsWith("__reactFiber")||k.startsWith("__reactInternalInstance"));',
      'if(!key) return "no react fiber";',
      // Navigate fiber to find the Draft.js EditorState
      'var fiber=ed[key];',
      'var depth=0;',
      'while(fiber&&depth<20){',
      'if(fiber.stateNode&&fiber.stateNode.getEditorState){',
      'var es=fiber.stateNode.getEditorState();',
      'return "found draft state:"+es.getCurrentContent().getPlainText().slice(0,50);',
      '}',
      'fiber=fiber.return;depth++;',
      '}',
      'return "searched "+depth+" levels, no draft state";',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('React fiber:', forceText.result?.value);

  // Alternative: type via document.execCommand('insertText')
  const execCmd = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'if(!ed) return "no ed";',
      'ed.focus();',
      'var sel=window.getSelection();',
      'var range=document.createRange();',
      // Focus at end of editor
      'var lastChild=ed.lastChild;',
      'if(lastChild){range.setStartAfter(lastChild);range.collapse(true);}',
      'else{range.selectNodeContents(ed);range.collapse(false);}',
      'sel.removeAllRanges();sel.addRange(range);',
      // Use execCommand to insert (Draft.js handles this)
      'document.execCommand("insertText", false, "EXECtest123");',
      'return "done, txt:"+ed.textContent.slice(0,30);',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('execCommand:', execCmd.result?.value);

  await new Promise(r=>setTimeout(r,2000));

  // Now check for send button again
  const findSend = await cmd('Runtime.evaluate', {
    expression: [
      '(function(){',
      'var ed=document.querySelector("[class*=DraftEditor-root]");',
      'var txt=ed?ed.textContent:"";',
      'var hasContent=txt&&txt.length>0;',
      // Find ALL SVGs/buttons in view
      'var all=document.querySelectorAll("svg,button");',
      'var btns=[];',
      'for(var i=0;i<all.length;i++){',
      'var br=all[i].getBoundingClientRect();',
      'if(all[i].offsetParent && br.y>440 && br.y<520 && br.width>10 && br.width<80 && br.height>10 && br.height<80){',
      'btns.push({tag:all[i].tagName,y:Math.round(br.y),x:Math.round(br.x),w:Math.round(br.width),h:Math.round(br.height),cls:(all[i].className||"").toString().slice(0,40)});',
      '}',
      '}',
      'return JSON.stringify({hasContent:hasContent,txt:txt.slice(0,40),btns:btns});',
      '})()'
    ].join(''),
    returnByValue: true
  });
  console.log('After execCommand:', findSend.result?.value?.slice(0,800));

  ws.close(); process.exit(0);
});
setTimeout(() => process.exit(1), 25000);
