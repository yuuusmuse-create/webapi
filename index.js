const fs = require("fs");
const http = require("http");
const net = require("net");
const { execSync, spawn } = require("child_process");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ID = process.env.ID;
const WSPATH = process.env.WSPATH || "/vless";
const XRAY_PORT = 18080;
const XRAY_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip";
if (!ID) { console.error("ID env missing"); process.exit(1); }

function sh(cmd) { try { execSync(cmd, { stdio: "inherit" }); return true; } catch (e) { return false; } }

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => { s.end(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}

(async () => {
  if (!fs.existsSync("./xray")) {
    console.log("downloading xray...");
    const dl = sh(`curl -sL -o xray.zip "${XRAY_URL}"`) || sh(`wget -qO xray.zip "${XRAY_URL}"`);
    if (!dl || !fs.existsSync("xray.zip")) { console.error("xray download failed"); process.exit(1); }
    let extracted = false;
    try {
      const extract = require("extract-zip");
      await extract("xray.zip", { dir: process.cwd() });
      extracted = fs.existsSync("./xray");
    } catch (e) { console.log("extract-zip failed:", e.message); }
    if (!extracted) extracted = sh("unzip -o xray.zip xray") || sh("python3 -c \"import zipfile; zipfile.ZipFile('xray.zip').extract('xray')\"");
    if (!extracted || !fs.existsSync("./xray")) { console.error("xray extract failed"); process.exit(1); }
    sh("chmod +x xray");
  }

  const cfg = {
    log: { loglevel: "warning" },
    inbounds: [{
      port: XRAY_PORT,
      listen: "127.0.0.1",
      protocol: "vless",
      settings: { clients: [{ id: ID }], decryption: "none" },
      streamSettings: { network: "ws", wsSettings: { path: WSPATH } }
    }],
    outbounds: [{ protocol: "freedom" }]
  };
  fs.writeFileSync("config.json", JSON.stringify(cfg));

  // Keep xray alive: spawn it when 18080 is free, and re-check periodically.
  let xrayChild = null;
  function startXray() {
    if (xrayChild) return;
    console.log("starting xray...");
    const xray = spawn("./xray", ["run", "-c", "config.json"], { stdio: "inherit" });
    xrayChild = xray;
    xray.on("exit", (c) => { console.error("xray exited", c); xrayChild = null; });
  }
  async function ensureXray() {
    if (xrayChild) return;
    if (await portInUse(XRAY_PORT)) { console.log("xray already running on 18080, reusing it"); return; }
    startXray();
  }
  await ensureXray();
  setInterval(() => { ensureXray().catch((e) => console.error("ensureXray:", e.message)); }, 15000);

  // HTTP server on $PORT: / and /healthz return 200; /sub returns the plain
  // vless link built from the request Host header (so no hardcoded domain).
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else if (req.url === "/sub") {
      const host = req.headers.host || "";
      const link = `vless://${ID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(WSPATH)}#cweb`;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(link);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const path = (req.url || "").split("?")[0];
    if (path !== WSPATH) { socket.destroy(); return; }
    const upstream = net.connect(XRAY_PORT, "127.0.0.1", () => {
      upstream.setTimeout(0);
      let raw = req.method + " " + req.url + " HTTP/" + req.httpVersion + "\r\n";
      for (const [k, v] of Object.entries(req.headers)) {
        raw += k + ": " + (Array.isArray(v) ? v.join(", ") : v) + "\r\n";
      }
      raw += "\r\n";
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.setTimeout(5000, () => { try { upstream.destroy(); } catch (e) {} try { socket.destroy(); } catch (e) {} });
    upstream.on("error", () => { try { socket.destroy(); } catch (e) {} });
    socket.on("error", () => { try { upstream.destroy(); } catch (e) {} });
  });
  server.listen(PORT, () => console.log("listening on " + PORT + ", ws " + WSPATH + ", healthz ok"));
})();
