const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.MANAGEMENT_PORT || 8090;
const WG_INTERFACE = process.env.WG_INTERFACE || "wg0";
const WG_CONF = process.env.WG_CONF || "/etc/wireguard/wg0.conf";
const CLIENTS_DIR = process.env.CLIENTS_DIR || "/etc/wireguard/clients";
const CONFIG_DIR = process.env.CONFIG_DIR || "/etc/vpn-manager";
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: "vpn-manager-secret-" + os.hostname(),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
  })
);

// -----------------------------------------------------------
// Auth middleware
// -----------------------------------------------------------
function requireAuth(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ error: "Authentication required" });
}

// -----------------------------------------------------------
// Helper: run command as root via sudo
// -----------------------------------------------------------
function sudo(cmd) {
  return new Promise((resolve, reject) => {
    exec(`sudo -n ${cmd}`, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// -----------------------------------------------------------
// Helpers: config file
// -----------------------------------------------------------
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return { vpnEnabled: false, clients: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// -----------------------------------------------------------
// Helpers: generate WireGuard keypair
// -----------------------------------------------------------
function generateKeypair() {
  return new Promise((resolve, reject) => {
    exec("wg genkey", { timeout: 5000 }, (err, privKey) => {
      if (err) return reject(err);
      privKey = privKey.trim();
      exec(
        `echo "${privKey}" | wg pubkey`,
        { timeout: 5000 },
        (err2, pubKey) => {
          if (err2) return reject(err2);
          resolve({ privateKey: privKey, publicKey: pubKey.trim() });
        }
      );
    });
  });
}

// -----------------------------------------------------------
// Helpers: next client IP
// -----------------------------------------------------------
function nextClientIp(cfg) {
  const used = cfg.clients.map((c) => parseInt(c.ip.split(".")[3], 10));
  for (let i = 2; i <= 254; i++) {
    if (!used.includes(i)) return `10.0.0.${i}/32`;
  }
  return null;
}

// -----------------------------------------------------------
// Helper: get running services
// -----------------------------------------------------------
function getRunningServices() {
  return new Promise((resolve) => {
    exec("ss -tlnp 2>/dev/null", { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      const services = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const match = line.match(
          /LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+\s+users:\(\("([^"]+)"[^)]*\)\)/
        );
        if (match) {
          const addr = match[1];
          const port = parseInt(match[2], 10);
          const proc = match[3];
          if (addr === "0.0.0.0" || addr === "*") {
            services.push({ port, process: proc, bound: addr });
          }
        }
      }
      resolve(services);
    });
  });
}

// -----------------------------------------------------------
// Auth routes
// -----------------------------------------------------------
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const cfg = loadConfig();

  if (!cfg.adminPasswordHash) {
    // First login — set password
    const hash = await bcrypt.hash(password, 10);
    cfg.adminUser = username;
    cfg.adminPasswordHash = hash;
    saveConfig(cfg);
    req.session.admin = true;
    res.json({ ok: true, message: "Admin password set and logged in." });
    return;
  }

  if (username !== cfg.adminUser) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, cfg.adminPasswordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.session.admin = true;
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get("/api/auth/check", (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.admin) });
});

// -----------------------------------------------------------
// VPN lifecycle
// -----------------------------------------------------------
app.post("/api/vpn/start", requireAuth, async (req, res) => {
  try {
    await sudo(`systemctl start wg-quick@${WG_INTERFACE}`);
    const cfg = loadConfig();
    cfg.vpnEnabled = true;
    saveConfig(cfg);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/vpn/stop", requireAuth, async (req, res) => {
  try {
    await sudo(`systemctl stop wg-quick@${WG_INTERFACE}`);
    const cfg = loadConfig();
    cfg.vpnEnabled = false;
    saveConfig(cfg);
    res.json({ ok: true, status: "stopped" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/vpn/restart", requireAuth, async (req, res) => {
  try {
    await sudo(`systemctl restart wg-quick@${WG_INTERFACE}`);
    const cfg = loadConfig();
    cfg.vpnEnabled = true;
    saveConfig(cfg);
    res.json({ ok: true, status: "running" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------
// Status
// -----------------------------------------------------------
app.get("/api/status", requireAuth, async (req, res) => {
  try {
    const cfg = loadConfig();
    let wgStatus = null;
    try {
      wgStatus = await sudo(`wg show ${WG_INTERFACE} 2>/dev/null || echo "inactive"`);
    } catch {
      wgStatus = "inactive";
    }

    // Check if WireGuard interface is up
    let ifaceUp = false;
    try {
      const ipLink = await sudo(`ip link show ${WG_INTERFACE} 2>/dev/null`);
      ifaceUp = ipLink.includes("UP") && !ipLink.includes("DOWN");
    } catch {
      ifaceUp = false;
    }

    const publicIp = await sudo(
      "curl -s --max-time 5 ifconfig.me 2>/dev/null || echo ''"
    ).catch(() => "");

    res.json({
      vpnEnabled: cfg.vpnEnabled,
      vpnInterface: WG_INTERFACE,
      vpnSubnet: cfg.vpnSubnet || "10.0.0.0/24",
      vpnPort: cfg.vpnPort || 51820,
      serverIp: cfg.serverIp || publicIp,
      interfaceUp: ifaceUp,
      wgStatus: wgStatus,
      clientCount: cfg.clients ? cfg.clients.length : 0,
      clients: (cfg.clients || []).map((c) => ({
        id: c.id,
        name: c.name,
        ip: c.ip,
        publicKey: c.publicKey,
        createdAt: c.createdAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------
// Settings
// -----------------------------------------------------------
app.get("/api/settings", requireAuth, (req, res) => {
  const cfg = loadConfig();
  const { adminPasswordHash, ...safe } = cfg;
  safe.adminUser = cfg.adminUser || "admin";
  safe.adminPasswordSet = !!cfg.adminPasswordHash;
  res.json(safe);
});

app.put("/api/settings", requireAuth, async (req, res) => {
  const cfg = loadConfig();
  const {
    vpnPort,
    vpnSubnet,
    serverIp,
    managementPort,
    allowLanAccess,
    localLanSubnet,
    exposedServices,
    adminPassword,
  } = req.body;

  if (vpnPort !== undefined) cfg.vpnPort = parseInt(vpnPort);
  if (vpnSubnet !== undefined) cfg.vpnSubnet = vpnSubnet;
  if (serverIp !== undefined) cfg.serverIp = serverIp;
  if (managementPort !== undefined) cfg.managementPort = parseInt(managementPort);
  if (allowLanAccess !== undefined) cfg.allowLanAccess = allowLanAccess;
  if (localLanSubnet !== undefined) cfg.localLanSubnet = localLanSubnet;
  if (exposedServices !== undefined) cfg.exposedServices = exposedServices;

  if (adminPassword && adminPassword.length >= 6) {
    cfg.adminPasswordHash = await bcrypt.hash(adminPassword, 10);
  }

  saveConfig(cfg);
  res.json({ ok: true, msg: "Settings saved" });
});

// -----------------------------------------------------------
// Services
// -----------------------------------------------------------
app.get("/api/services", requireAuth, async (req, res) => {
  try {
    const services = await getRunningServices();
    const cfg = loadConfig();
    const exposed = cfg.exposedServices || [];
    // Merge: for each detected service, mark if exposed
    const enriched = services.map((s) => ({
      ...s,
      exposedToVpn: exposed.includes(s.port),
    }));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/services", requireAuth, async (req, res) => {
  const { exposedPorts } = req.body;
  const cfg = loadConfig();
  cfg.exposedServices = exposedPorts || [];
  saveConfig(cfg);
  res.json({ ok: true, exposedServices: cfg.exposedServices });
});

// -----------------------------------------------------------
// Clients
// -----------------------------------------------------------
app.get("/api/clients", requireAuth, (req, res) => {
  const cfg = loadConfig();
  res.json(
    (cfg.clients || []).map((c) => ({
      id: c.id,
      name: c.name,
      ip: c.ip,
      publicKey: c.publicKey,
      createdAt: c.createdAt,
    }))
  );
});

app.post("/api/clients", requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Client name is required" });

    const cfg = loadConfig();
    const keypair = await generateKeypair();
    const clientIp = nextClientIp(cfg);
    if (!clientIp) {
      return res.status(400).json({ error: "No available IP in VPN subnet" });
    }

    const clientId = `client-${Date.now()}`;
    const client = {
      id: clientId,
      name,
      publicKey: keypair.publicKey,
      privateKey: keypair.privateKey,
      ip: clientIp,
      allowedIps: cfg.vpnSubnet || "10.0.0.0/24",
      createdAt: new Date().toISOString(),
    };

    // Save to config
    if (!cfg.clients) cfg.clients = [];
    cfg.clients.push(client);
    saveConfig(cfg);

    // Write client .conf file
    const confContent = generateClientConf(client, cfg);
    const confPath = path.join(CLIENTS_DIR, `${client.id}.conf`);
    fs.writeFileSync(confPath, confContent, { mode: 0o600 });

    // Generate QR code (WireGuard URI format)
    const qrData = encodeWireguardUri(confContent);
    const qrPath = path.join(CLIENTS_DIR, `${client.id}.png`);
    try {
      await qrcode.toFile(qrPath, qrData, { width: 300, margin: 2 });
    } catch {
      // QR generation is non-critical
    }

    const { privateKey: _priv, ...safe } = client;
    safe.confContent = confContent;
    safe.qrAvailable = fs.existsSync(qrPath);
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/clients/:id", requireAuth, (req, res) => {
  try {
    const cfg = loadConfig();
    const clientId = req.params.id;
    if (!cfg.clients) cfg.clients = [];

    cfg.clients = cfg.clients.filter((c) => c.id !== clientId);
    saveConfig(cfg);

    // Remove config files
    const confPath = path.join(CLIENTS_DIR, `${clientId}.conf`);
    const qrPath = path.join(CLIENTS_DIR, `${clientId}.png`);
    try {
      if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
    } catch {}
    try {
      if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
    } catch {}

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/clients/:id/download", requireAuth, (req, res) => {
  const clientId = req.params.id;
  const confPath = path.join(CLIENTS_DIR, `${clientId}.conf`);
  if (!fs.existsSync(confPath)) {
    return res.status(404).json({ error: "Client config not found" });
  }
  res.setHeader("Content-Type", "text/plain");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${clientId}.conf"`
  );
  res.sendFile(confPath);
});

app.get("/api/clients/:id/qr", requireAuth, (req, res) => {
  const clientId = req.params.id;
  const qrPath = path.join(CLIENTS_DIR, `${clientId}.png`);
  if (!fs.existsSync(qrPath)) {
    return res.status(404).json({ error: "QR code not found" });
  }
  res.setHeader("Content-Type", "image/png");
  res.sendFile(qrPath);
});

// -----------------------------------------------------------
// Logs
// -----------------------------------------------------------
app.get("/api/logs", requireAuth, async (req, res) => {
  try {
    const journal = await sudo(
      "journalctl -u wg-quick@wg0 --no-pager -n 200 --output=short-precise 2>/dev/null || echo ''"
    );
    res.json({ logs: journal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------
// Helpers
// -----------------------------------------------------------
function generateClientConf(client, cfg) {
  const serverPub = fs.readFileSync(
    path.join("/etc/wireguard/server", "publickey"),
    "utf8"
  );
  const endpoint = `${cfg.serverIp || "auto"}:${cfg.vpnPort || 51820}`;
  return `[Interface]
PrivateKey = ${client.privateKey}
Address = ${client.ip}
DNS = 10.0.0.1

[Peer]
PublicKey = ${serverPub.trim()}
Endpoint = ${endpoint}
AllowedIPs = ${client.allowedIps || cfg.vpnSubnet || "10.0.0.0/24"}
PersistentKeepalive = 25
`;
}

function encodeWireguardUri(configContent) {
  // WireGuard QR format: wireguard://?config=BASE64
  const base64 = Buffer.from(configContent).toString("base64");
  return `wireguard://?config=${base64}`;
}

// -----------------------------------------------------------
// Start
// -----------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`VPN Manager running on http://0.0.0.0:${PORT}`);
});
