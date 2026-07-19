const cdp = require("./lib/cdp-douyin.cjs");
(async () => {
  const s = await cdp.newSession(false);
  await s.send("Page.navigate", { url: "https://www.douyin.com" });
  await new Promise(r=>setTimeout(r,5000));

  const ev = (expr) => s.send("Runtime.evaluate", { expression: expr, returnByValue: true }).then(r=>r?.result?.value||"");

  // Find login button coordinates and dispatch real mouse events
  const pos = await ev(`
    (function(){
      var all=document.querySelectorAll("*");
      for(var i=0;i<all.length;i++){
        var t=(all[i].textContent||"").replace(/\\s/g,"");
        if(t==="登录" && all[i].offsetParent){
          var r=all[i].getBoundingClientRect();
          return JSON.stringify({x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
        }
      }
      return "null";
    })()
  `);
  console.log("Login btn pos:", pos);

  if (pos !== "null") {
    const {x, y} = JSON.parse(pos);
    // Dispatch real mouse events via CDP Input
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log("Dispatched mouse click at", x, y);
    await new Promise(r=>setTimeout(r,6000));
  }

  console.log("URL after click:", await ev("window.location.href"));
  console.log("Modals visible:", await ev(`
    (function(){
      var modals=document.querySelectorAll("[class*=modal],[class*=dialog],[class*=popup],[class*=login],[class*=qrcode],[role=dialog]");
      var r=[];
      for(var i=0;i<modals.length;i++){
        if(modals[i].offsetParent){
          var txt=modals[i].innerText.slice(0,100);
          r.push((modals[i].className||"").slice(0,60)+" text="+txt);
        }
      }
      return r.join("|||")||"none";
    })()
  `));

  // Try looking for QR iframe
  console.log("IFrames:", await ev(`
    (function(){
      var ifs=document.querySelectorAll("iframe");
      var r=[];
      for(var i=0;i<ifs.length;i++){
        r.push("src="+(ifs[i].src||"").slice(0,150));
      }
      return r.join("|")||"none";
    })()
  `));

  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  require("fs").writeFileSync("/tmp/mouse-click-login.png", Buffer.from(shot.data, "base64"));
  console.log("Shot:", shot.data.length, "bytes");

  s.close();
  process.exit(0);
})();
