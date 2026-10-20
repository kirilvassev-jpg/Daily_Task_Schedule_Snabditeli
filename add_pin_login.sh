#!/bin/bash
FILE="Driver_view.html"

# 1. Add login screen HTML after <body>
sed -i '/<body>/a\
\
<div id="loginScreen" style="position:fixed;inset:0;z-index:9999;background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);display:flex;align-items:center;justify-content:center;">\
  <div style="background:#fff;border-radius:16px;padding:32px;width:300px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.25);">\
    <div style="font-size:40px;margin-bottom:12px;">🔐</div>\
    <div style="font-size:18px;font-weight:700;color:#1e3a5f;margin-bottom:4px;">Вход за шофьори</div>\
    <div style="font-size:13px;color:#6b7280;margin-bottom:20px;">Въведи своя 4-цифрен PIN код</div>\
    <input id="pinInput" type="password" inputmode="numeric" maxlength="4" pattern="[0-9]*" placeholder="• • • •" style="width:100%;box-sizing:border-box;text-align:center;font-size:28px;letter-spacing:12px;padding:12px;border:2px solid #e5e7eb;border-radius:10px;outline:none;margin-bottom:16px;" oninput="if(this.value.length===4)verifyPin()">\
    <div id="pinError" style="color:#dc2626;font-size:13px;min-height:20px;margin-bottom:12px;"></div>\
    <button onclick="verifyPin()" style="width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;">Вход</button>\
  </div>\
</div>' "$FILE"

# 2. Add PIN map and login logic before saveFCMToken function
sed -i '/^function saveFCMToken/i\
/* ── PIN Login ── */\
var DRIVER_PINS = {\
  "1001": "Ангел Драгомиров",\
  "1002": "Димитър Йотов",\
  "1003": "Николай Пейчинов"\
};\
var loggedDriver = localStorage.getItem("driverName") || null;\
if (loggedDriver) { document.getElementById("loginScreen").style.display = "none"; }\
function verifyPin() {\
  var pin = document.getElementById("pinInput").value;\
  if (DRIVER_PINS[pin]) {\
    loggedDriver = DRIVER_PINS[pin];\
    localStorage.setItem("driverName", loggedDriver);\
    document.getElementById("loginScreen").style.display = "none";\
  } else {\
    document.getElementById("pinError").textContent = "❌ Грешен PIN код";\
    document.getElementById("pinInput").value = "";\
    document.getElementById("pinInput").focus();\
  }\
}\
' "$FILE"

# 3. Add driverName to FCM token save — update the URL line
sed -i "s|updateMask.fieldPaths=token&updateMask.fieldPaths=updatedAt|updateMask.fieldPaths=token\&updateMask.fieldPaths=updatedAt\&updateMask.fieldPaths=driverName|" "$FILE"

# 4. Add driverName field to the fetch body
sed -i 's/token:     { stringValue: token },/token:     { stringValue: token },\n        driverName:{ stringValue: loggedDriver || "unknown" },/' "$FILE"

echo "Done! PIN login added."
