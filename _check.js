const fs = require("fs");
const html = fs.readFileSync("D:/MockUpStream/panel.html", "utf8");
const start = html.indexOf("function app()");
const end = html.lastIndexOf("};");
const js = html.slice(start, end + 2);

let depth = 0;
let inStr = false, strChar = "";
for (let i = 0; i < js.length; i++) {
  const ch = js[i];
  if (inStr) {
    if (ch === "\\" && i + 1 < js.length) { i++; continue; }
    if (ch === strChar) inStr = false;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strChar = ch; continue; }
  if (ch === "{") depth++;
  if (ch === "}") depth--;
}
console.log("Brace depth:", depth);

if (depth !== 0) {
  // Binary search to find the imbalance
  let lo = 0, hi = js.length;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    let d = 0;
    inStr = false; strChar = "";
    for (let i = 0; i < mid; i++) {
      const ch = js[i];
      if (inStr) {
        if (ch === "\\" && i + 1 < js.length) { i++; continue; }
        if (ch === strChar) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = true; strChar = ch; continue; }
      if (ch === "{") d++;
      if (ch === "}") d--;
    }
    if (d <= 0) lo = mid;
    else hi = mid;
  }
  console.log("Imbalance near position:", lo);
  console.log("Context:", js.slice(Math.max(0, lo - 50), lo + 50));
}

try {
  new Function(js);
  console.log("JS syntax OK");
} catch (e) {
  console.log("JS syntax error:", e.message);
  const m = e.stack || "";
  console.log(m);
}
