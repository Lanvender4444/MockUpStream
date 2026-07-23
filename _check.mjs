import fs from "fs";
const html = fs.readFileSync("D:/MockUpStream/panel.html", "utf8");
const start = html.indexOf("function app()");
const end = html.lastIndexOf("};");
console.log("start:", start, "end:", end);
console.log("After };" + JSON.stringify(html.slice(end+2, end+20)));
const js = html.slice(start, end + 3);
console.log("JS ends with: " + JSON.stringify(js.slice(-10)));
// Check depth
let depth = 0, inStr = false, strChar = "";
for (let i = 0; i < js.length; i++) {
  const ch = js[i];
  if (inStr) {
    if (ch === "\\" && i + 1 < js.length) { i++; continue; }
    if (ch === strChar) inStr = false;
    continue;
  }
  if (ch === "\"" || ch === "'" || ch === "`") { inStr = true; strChar = ch; continue; }
  if (ch === "{") depth++;
  if (ch === "}") depth--;
}
console.log("Depth with +1 char:", depth);
