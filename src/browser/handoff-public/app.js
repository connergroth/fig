/* Browser Handoff — phone client.
 *
 * Opens a WebSocket to ws://<host>/ws, renders incoming JPEG frames into a
 * full-bleed <img>, and forwards touch/mouse/wheel/keyboard input back to the
 * remote tab with coordinates mapped into the remote tab's DEVICE-PIXEL space.
 *
 * Wire protocol (verbatim shared contract):
 *   server->client: {t:"frame",data,w,h} | {t:"status",msg} | {t:"bye"}
 *   client->server: {t:"mouse",type,x,y,button} | {t:"wheel",x,y,dx,dy}
 *                    {t:"key",type,key,code,text} | {t:"done"}
 */
(function () {
  "use strict";

  // --- DOM refs ---
  var statusbar = document.getElementById("statusbar");
  var stage = document.getElementById("stage");
  var frameImg = document.getElementById("frame");
  var placeholder = document.getElementById("placeholder");
  var doneBtn = document.getElementById("doneBtn");
  var kbdBtn = document.getElementById("kbdBtn");
  var kbdInput = document.getElementById("kbdInput");
  var overlay = document.getElementById("overlay");
  var overlayTitle = document.getElementById("overlayTitle");
  var overlaySub = document.getElementById("overlaySub");

  // --- state ---
  var ws = null;
  var wsClosedByServer = false;
  var reconnectDelay = 500; // ms, grows with backoff
  var MAX_RECONNECT = 8000;

  // remote tab's device pixel size (from frame messages)
  var devW = 0;
  var devH = 0;

  // last pointer position in device space (for wheel anchoring)
  var lastDevX = 0;
  var lastDevY = 0;

  // ===================================================================
  // WebSocket
  // ===================================================================
  function wsUrl() {
    var scheme = "ws:"; // served off LAN; backend uses plain ws
    if (window.location.protocol === "https:") scheme = "wss:";
    return scheme + "//" + window.location.host + "/ws";
  }

  function setStatus(msg, cls) {
    statusbar.textContent = msg;
    statusbar.classList.remove("ok", "err");
    if (cls) statusbar.classList.add(cls);
  }

  function connect() {
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectDelay = 500;
      setStatus("connected to " + window.location.hostname, "ok");
      sendViewport();
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = function () {
      ws = null;
      if (wsClosedByServer) return;
      setStatus("disconnected — reconnecting…", "err");
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will follow and handle reconnect
      setStatus("connection error", "err");
    };
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT, Math.round(reconnectDelay * 1.6));
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // Tell the server the phone's live viewing area so it can reshape the remote tab to
  // match — this is what makes the page fill the screen instead of letterboxing.
  function sendViewport() {
    var r = stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    send({
      t: "viewport",
      w: Math.round(r.width),
      h: Math.round(r.height),
      dpr: window.devicePixelRatio || 1,
    });
  }

  // Re-match on rotate / resize (debounced).
  var vpTimer = null;
  function scheduleViewport() {
    if (vpTimer) clearTimeout(vpTimer);
    vpTimer = setTimeout(sendViewport, 250);
  }
  window.addEventListener("resize", scheduleViewport);
  window.addEventListener("orientationchange", scheduleViewport);

  function handleMessage(msg) {
    switch (msg.t) {
      case "frame":
        renderFrame(msg);
        break;
      case "status":
        // Server sends a one-line instruction here ("drive this one step…"); we keep
        // the top bar as a clean "connected to <host>" line instead of instructions.
        break;
      case "bye":
        showOverlay("session ended", "you can close this page.");
        wsClosedByServer = true;
        if (ws) {
          try { ws.close(); } catch (e) {}
        }
        break;
      default:
        break;
    }
  }

  // ===================================================================
  // Frame rendering
  // ===================================================================
  function renderFrame(msg) {
    if (typeof msg.w === "number" && msg.w > 0) devW = msg.w;
    if (typeof msg.h === "number" && msg.h > 0) devH = msg.h;
    if (!msg.data) return;
    frameImg.src = "data:image/jpeg;base64," + msg.data;
    if (placeholder && !placeholder.classList.contains("hidden")) {
      placeholder.classList.add("hidden");
    }
  }

  /**
   * Compute the on-screen rect actually occupied by the letterboxed image
   * (object-fit: contain) inside the stage. Returns null if we don't yet know
   * the device size.
   */
  function displayedRect() {
    if (!devW || !devH) return null;
    var box = stage.getBoundingClientRect();
    var boxW = box.width;
    var boxH = box.height;
    if (boxW <= 0 || boxH <= 0) return null;

    var scale = Math.min(boxW / devW, boxH / devH);
    var dispW = devW * scale;
    var dispH = devH * scale;
    var left = box.left + (boxW - dispW) / 2;
    var top = box.top + (boxH - dispH) / 2;
    return { left: left, top: top, width: dispW, height: dispH };
  }

  /**
   * Map a viewport (clientX/clientY) point to remote device-pixel coords.
   * Returns null if outside the displayed image rect.
   */
  function toDevice(clientX, clientY) {
    var r = displayedRect();
    if (!r) return null;
    if (
      clientX < r.left ||
      clientX > r.left + r.width ||
      clientY < r.top ||
      clientY > r.top + r.height
    ) {
      return null;
    }
    var x = Math.round(((clientX - r.left) / r.width) * devW);
    var y = Math.round(((clientY - r.top) / r.height) * devH);
    x = Math.max(0, Math.min(devW, x));
    y = Math.max(0, Math.min(devH, y));
    lastDevX = x;
    lastDevY = y;
    return { x: x, y: y };
  }

  function sendMouse(type, p, button) {
    send({ t: "mouse", type: type, x: p.x, y: p.y, button: button || "left" });
  }

  // ===================================================================
  // Touch input  (primary path) — phone-native:
  //   • one-finger tap            -> click
  //   • one-finger drag           -> scroll the page (like a normal phone)
  //   • two-finger drag           -> click-and-drag (sliders, "drag the piece" captchas)
  // ===================================================================
  var TAP_SLOP = 10; // px of finger travel under which a touch counts as a tap, not a scroll

  var gesture = null; // "scroll" (provisional, may end as a tap) | "drag2" | null
  var startX = 0, startY = 0; // first-finger position at touchstart
  var lastX = 0, lastY = 0;   // first-finger position last move (for scroll deltas)
  var movedPastSlop = false;  // has the one-finger touch traveled enough to be a scroll
  var tapPt = null;           // device coords of the initial touch, for a tap->click

  stage.addEventListener(
    "touchstart",
    function (e) {
      e.preventDefault();
      if (e.touches.length >= 2) {
        // two fingers -> click-and-drag: press at the center, then follow the move
        gesture = "drag2";
        var c = twoFingerCenter(e.touches);
        var p = toDevice(c.x, c.y);
        if (p) {
          sendMouse("mousePressed", p, "left");
          lastDevX = p.x;
          lastDevY = p.y;
        }
        return;
      }
      // one finger -> assume scroll, but resolve to a tap (click) if it never moves
      gesture = "scroll";
      var t = e.touches[0];
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      movedPastSlop = false;
      tapPt = toDevice(t.clientX, t.clientY);
    },
    { passive: false }
  );

  stage.addEventListener(
    "touchmove",
    function (e) {
      e.preventDefault();
      if (gesture === "drag2") {
        var c = twoFingerCenter(e.touches);
        var p = toDevice(c.x, c.y);
        if (p) {
          sendMouse("mouseMoved", p, "left");
          lastDevX = p.x;
          lastDevY = p.y;
        }
        return;
      }
      if (gesture !== "scroll") return;
      var t = e.touches[0];
      if (!movedPastSlop &&
          (Math.abs(t.clientX - startX) > TAP_SLOP || Math.abs(t.clientY - startY) > TAP_SLOP)) {
        movedPastSlop = true;
      }
      if (!movedPastSlop) return;
      // remote wheel: dy positive when content should scroll down (finger up = scroll down)
      var dx = lastX - t.clientX;
      var dy = lastY - t.clientY;
      lastX = t.clientX;
      lastY = t.clientY;
      var anchor = toDevice(t.clientX, t.clientY);
      var ax = anchor ? anchor.x : lastDevX;
      var ay = anchor ? anchor.y : lastDevY;
      send({ t: "wheel", x: ax, y: ay, dx: Math.round(dx), dy: Math.round(dy) });
    },
    { passive: false }
  );

  function endTouch(e) {
    e.preventDefault();
    if (gesture === "drag2") {
      send({ t: "mouse", type: "mouseReleased", x: lastDevX, y: lastDevY, button: "left" });
      if (!e.touches || e.touches.length < 2) gesture = null;
      return;
    }
    if (gesture === "scroll") {
      if (!movedPastSlop && tapPt) {
        // never moved -> it was a tap -> click
        sendMouse("mousePressed", tapPt, "left");
        send({ t: "mouse", type: "mouseReleased", x: tapPt.x, y: tapPt.y, button: "left" });
      }
      gesture = null;
      return;
    }
    gesture = null;
  }
  stage.addEventListener("touchend", endTouch, { passive: false });
  stage.addEventListener("touchcancel", endTouch, { passive: false });

  function twoFingerCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  // ===================================================================
  // Mouse input  (desktop testing)
  // ===================================================================
  var mouseDown = false;

  stage.addEventListener("mousedown", function (e) {
    var pt = toDevice(e.clientX, e.clientY);
    if (!pt) return;
    e.preventDefault();
    mouseDown = true;
    sendMouse("mousePressed", pt, "left");
  });

  window.addEventListener("mousemove", function (e) {
    var pt = toDevice(e.clientX, e.clientY);
    if (!pt) {
      // still update nothing if outside; keep last anchor
      return;
    }
    if (mouseDown) sendMouse("mouseMoved", pt, "left");
    else sendMouse("mouseMoved", pt, "none");
  });

  window.addEventListener("mouseup", function (e) {
    if (!mouseDown) return;
    mouseDown = false;
    var pt = toDevice(e.clientX, e.clientY);
    var x = pt ? pt.x : lastDevX;
    var y = pt ? pt.y : lastDevY;
    send({ t: "mouse", type: "mouseReleased", x: x, y: y, button: "left" });
  });

  // desktop wheel scroll
  stage.addEventListener(
    "wheel",
    function (e) {
      var pt = toDevice(e.clientX, e.clientY);
      var x = pt ? pt.x : lastDevX;
      var y = pt ? pt.y : lastDevY;
      e.preventDefault();
      send({ t: "wheel", x: x, y: y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
    },
    { passive: false }
  );

  // ===================================================================
  // Keyboard
  // ===================================================================
  var kbdOpen = false;

  kbdBtn.addEventListener("click", function () {
    kbdOpen = !kbdOpen;
    if (kbdOpen) {
      kbdInput.value = "";
      prevInputValue = "";
      kbdInput.focus();
      kbdBtn.classList.add("active");
    } else {
      kbdInput.blur();
      kbdBtn.classList.remove("active");
    }
  });

  kbdInput.addEventListener("blur", function () {
    kbdOpen = false;
    kbdBtn.classList.remove("active");
  });

  // Printable characters AND backspace are handled exclusively by the input-diff
  // path below (the reliable cross-keyboard source). keydown forwards ONLY control
  // and navigation keys that don't change the field value — sending printables here
  // too would double-type every character.
  var CONTROL_KEYS = {
    Enter: 1, Tab: 1, Escape: 1, Delete: 1,
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Home: 1, End: 1,
  };
  kbdInput.addEventListener("keydown", function (e) {
    if (!CONTROL_KEYS[e.key]) return;
    if (e.key === "Tab") e.preventDefault();
    send({ t: "key", type: "keyDown", key: e.key, code: e.code || "", text: "" });
    send({ t: "key", type: "keyUp", key: e.key, code: e.code || "", text: "" });
  });

  // Mobile soft keyboards often fire unreliable keydown (key === "Unidentified").
  // Use the input event to diff the value and emit a char per inserted character.
  var prevInputValue = "";
  kbdInput.addEventListener("input", function () {
    var v = kbdInput.value;
    if (v.length > prevInputValue.length && v.indexOf(prevInputValue) === 0) {
      var added = v.slice(prevInputValue.length);
      for (var i = 0; i < added.length; i++) {
        var ch = added[i];
        send({ t: "key", type: "char", key: ch, code: "", text: ch });
      }
    } else if (v.length < prevInputValue.length) {
      // backspace(s) — emit Backspace key events for each removed char
      var removed = prevInputValue.length - v.length;
      for (var j = 0; j < removed; j++) {
        send({ t: "key", type: "keyDown", key: "Backspace", code: "Backspace", text: "" });
        send({ t: "key", type: "keyUp", key: "Backspace", code: "Backspace", text: "" });
      }
    }
    prevInputValue = v;
    // keep the buffer from growing unbounded
    if (v.length > 200) {
      kbdInput.value = "";
      prevInputValue = "";
    }
  });

  function printableText(e) {
    if (typeof e.key === "string" && e.key.length === 1) return e.key;
    return "";
  }

  // ===================================================================
  // Done button
  // ===================================================================
  doneBtn.addEventListener("click", function () {
    send({ t: "done" });
    doneBtn.classList.add("finishing");
    doneBtn.textContent = "finishing up…";
    doneBtn.disabled = true;
    setStatus("finishing up…", "ok");
  });

  // ===================================================================
  // Overlay
  // ===================================================================
  function showOverlay(title, sub) {
    overlayTitle.textContent = title;
    overlaySub.textContent = sub || "";
    overlay.classList.remove("hidden");
  }

  // Prevent iOS rubber-band / pinch zoom at the document level.
  document.addEventListener(
    "touchmove",
    function (e) {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false }
  );
  document.addEventListener("gesturestart", function (e) {
    e.preventDefault();
  });

  // kick off
  setStatus("connecting…");
  connect();
})();
