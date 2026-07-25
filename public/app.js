(function () {
  "use strict";

  const API = "/api";

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const loginScreen = $("#login-screen");
  const dashboardScreen = $("#dashboard-screen");
  const loginForm = $("#login-form");
  const loginError = $("#login-error");
  const logoutBtn = $("#btn-logout");
  const vpnToggle = $("#vpn-toggle");
  const vpnDetail = $("#vpn-detail");
  const vpnActions = $("#vpn-actions");
  const statusInfo = $("#status-info");
  const servicesList = $("#services-list");
  const saveServicesBtn = $("#btn-save-services");
  const clientsList = $("#clients-list");
  const addClientBtn = $("#btn-add-client");
  const clientModal = $("#client-modal");
  const addClientForm = $("#add-client-form");
  const clientResult = $("#client-result");
  const settingsForm = $("#settings-form");
  const logsOutput = $("#logs-output");
  const refreshLogsBtn = $("#btn-refresh-logs");
  const toast = $("#toast");
  const topbarStatus = $("#topbar-status");
  const lanSubnetGroup = $("#lan-subnet-group");

  // ---- Auth ----
  async function checkAuth() {
    try {
      const r = await fetch(`${API}/auth/check`);
      const d = await r.json();
      return d.authenticated;
    } catch {
      return false;
    }
  }

  function showLogin() {
    loginScreen.classList.remove("hidden");
    dashboardScreen.classList.add("hidden");
  }

  function showDashboard() {
    loginScreen.classList.add("hidden");
    dashboardScreen.classList.remove("hidden");
    loadAll();
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = $("#login-user").value.trim();
    const pass = $("#login-pass").value;
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const d = await r.json();
      if (d.ok) {
        showDashboard();
      } else {
        loginError.textContent = d.error || "Login failed";
        loginError.hidden = false;
      }
    } catch (err) {
      loginError.textContent = "Network error";
      loginError.hidden = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await fetch(`${API}/auth/logout`, { method: "POST" });
    showLogin();
  });

  // ---- VPN Control ----
  vpnToggle.addEventListener("change", async () => {
    const on = vpnToggle.checked;
    const action = on ? "start" : "stop";
    try {
      await fetch(`${API}/vpn/${action}`, { method: "POST" });
      showToast(on ? "VPN started" : "VPN stopped", on ? "success" : "");
      await refreshStatus();
    } catch (err) {
      vpnToggle.checked = !on;
      showToast("Failed: " + err.message, "error");
    }
  });

  $("#btn-start").addEventListener("click", async () => {
    vpnToggle.checked = true;
    await vpnToggle.dispatchEvent(new Event("change"));
  });
  $("#btn-stop").addEventListener("click", async () => {
    vpnToggle.checked = false;
    await vpnToggle.dispatchEvent(new Event("change"));
  });
  $("#btn-restart").addEventListener("click", async () => {
    try {
      await fetch(`${API}/vpn/restart`, { method: "POST" });
      showToast("VPN restarted", "success");
      await refreshStatus();
    } catch (err) {
      showToast("Failed: " + err.message, "error");
    }
  });

  // ---- Status ----
  async function refreshStatus() {
    try {
      const r = await fetch(`${API}/status`);
      const d = await r.json();
      renderStatus(d);
    } catch (err) {
      console.error("Status fetch error:", err);
    }
  }

  function renderStatus(d) {
    vpnToggle.checked = d.vpnEnabled && d.interfaceUp;
    vpnActions.style.display = d.vpnEnabled ? "flex" : "flex";

    let detail = `<div>Server IP: <strong>${d.serverIp || "auto"}</strong></div>`;
    detail += `<div>VPN Subnet: <strong>${d.vpnSubnet}</strong></div>`;
    detail += `<div>VPN Port: <strong>${d.vpnPort}/UDP</strong></div>`;
    detail += `<div>Interface: <strong>${d.vpnInterface} ${d.interfaceUp ? "🟢 UP" : "🔴 DOWN"}</strong></div>`;
    detail += `<div>Clients: <strong>${d.clientCount}</strong></div>`;
    vpnDetail.innerHTML = detail;

    let wgPreview = d.wgStatus
      ? d.wgStatus
          .split("\n")
          .slice(0, 10)
          .join("\n")
      : "No status available";
    statusInfo.innerHTML = `
      <div class="label">State</div><div class="value">${d.vpnEnabled ? "🟢 Active" : "🔴 Inactive"}</div>
      <div class="label">Interface</div><div class="value">${d.vpnInterface}</div>
      <div class="label">Endpoint</div><div class="value">${d.serverIp}:${d.vpnPort}</div>
      <div class="label">Subnet</div><div class="value">${d.vpnSubnet}</div>
      <div class="label">Peers</div><div class="value">${d.clientCount}</div>
      <div class="label" style="grid-column:1/-1;">WireGuard Output:</div>
      <pre style="grid-column:1/-1;max-height:120px;overflow:auto;font-size:0.75rem;color:var(--text-dim);">${escapeHtml(wgPreview)}</pre>
    `;

    topbarStatus.textContent = d.vpnEnabled ? "VPN ON" : "VPN OFF";
    topbarStatus.className = "badge " + (d.vpnEnabled ? "active" : "inactive");
  }

  // ---- Services ----
  async function loadServices() {
    try {
      const r = await fetch(`${API}/services`);
      const services = await r.json();
      renderServices(services);
    } catch (err) {
      console.error("Services fetch error:", err);
    }
  }

  function renderServices(services) {
    if (!services.length) {
      servicesList.innerHTML = "<p style='color:var(--text-dim);font-size:0.85rem;'>No services detected.</p>";
      return;
    }
    servicesList.innerHTML = services
      .map(
        (s) => `
      <div class="service-item">
        <div>
          <span class="svc-port">:${s.port}</span>
          <span class="svc-proc">${escapeHtml(s.process)}</span>
        </div>
        <label class="switch">
          <input type="checkbox" data-port="${s.port}" ${s.exposedToVpn ? "checked" : ""} />
          <span class="slider"></span>
        </label>
      </div>`
      )
      .join("");
  }

  saveServicesBtn.addEventListener("click", async () => {
    const checkboxes = servicesList.querySelectorAll('input[type="checkbox"][data-port]');
    const ports = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) ports.push(parseInt(cb.dataset.port));
    });
    try {
      await fetch(`${API}/services`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposedPorts: ports }),
      });
      showToast("Services saved", "success");
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    }
  });

  // ---- Clients ----
  async function loadClients() {
    try {
      const r = await fetch(`${API}/clients`);
      const clients = await r.json();
      renderClients(clients);
    } catch (err) {
      console.error("Clients fetch error:", err);
    }
  }

  function renderClients(clients) {
    if (!clients.length) {
      clientsList.innerHTML = "<p style='color:var(--text-dim);font-size:0.85rem;'>No clients yet. Click '+ Add Client' to create one.</p>";
      return;
    }
    clientsList.innerHTML = clients
      .map(
        (c) => `
      <div class="client-item">
        <div>
          <span class="client-name">${escapeHtml(c.name)}</span>
          <span class="client-meta">${c.ip}</span>
        </div>
        <div class="client-actions">
          <a href="${API}/clients/${c.id}/download" class="btn small">Download</a>
          <button class="btn small danger" data-client-id="${c.id}">Delete</button>
        </div>
      </div>`
      )
      .join("");

    // Wire up delete buttons
    clientsList.querySelectorAll("[data-client-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.clientId;
        if (!confirm("Delete this client?")) return;
        try {
          await fetch(`${API}/clients/${id}`, { method: "DELETE" });
          showToast("Client deleted", "success");
          loadClients();
        } catch (err) {
          showToast("Delete failed: " + err.message, "error");
        }
      });
    });
  }

  addClientBtn.addEventListener("click", () => {
    clientModal.classList.remove("hidden");
    clientResult.hidden = true;
    addClientForm.reset();
  });

  $("#btn-modal-close").addEventListener("click", () => {
    clientModal.classList.add("hidden");
  });

  addClientForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = addClientForm.querySelector("[name=clientName]").value.trim();
    if (!name) return;
    try {
      const r = await fetch(`${API}/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (r.ok) {
        clientResult.innerHTML = `
          <p><strong>Client created:</strong> ${escapeHtml(d.name)}</p>
          <p><strong>IP:</strong> ${escapeHtml(d.ip)}</p>
          <p><strong>Private Key:</strong></p>
          <pre style="font-size:0.7rem;word-break:break-all;">${escapeHtml(d.privateKey)}</pre>
          <a href="${API}/clients/${d.id}/download" class="btn small">Download .conf</a>
          ${d.qrAvailable ? `<a href="${API}/clients/${d.id}/qr" class="btn small">View QR</a>` : ""}
        `;
        clientResult.hidden = false;
        addClientForm.reset();
        showToast("Client created!", "success");
        loadClients();
      } else {
        clientResult.innerHTML = `<p class="error-msg">${escapeHtml(d.error || "Failed")}</p>`;
        clientResult.hidden = false;
      }
    } catch (err) {
      clientResult.innerHTML = `<p class="error-msg">${escapeHtml(err.message)}</p>`;
      clientResult.hidden = false;
    }
  });

  // ---- Settings ----
async function loadSettings() {
  try {
    const r = await fetch(`${API}/settings`);
    const d = await r.json();
    settingsForm.querySelector("[name=adminUser]").value = d.adminUser || "admin";
    settingsForm.querySelector("[name=vpnPort]").value = d.vpnPort || 51820;
    settingsForm.querySelector("[name=vpnSubnet]").value = d.vpnSubnet || "10.0.0.0/24";
    settingsForm.querySelector("[name=serverIp]").value = d.serverIp || "";
    settingsForm.querySelector("[name=managementPort]").value = d.managementPort || 8090;
    settingsForm.querySelector("[name=allowLanAccess]").checked = d.allowLanAccess || false;
    settingsForm.querySelector("[name=localLanSubnet]").value = d.localLanSubnet || "";
    lanSubnetGroup.style.display = d.allowLanAccess ? "block" : "none";

    // Toggle LAN subnet field
    settingsForm.querySelector("[name=allowLanAccess]").onchange = function () {
      lanSubnetGroup.style.display = this.checked ? "block" : "none";
    };
  } catch (err) {
    console.error("Settings fetch error:", err);
  }
}

  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(settingsForm);
    const payload = {};
    for (const [k, v] of formData.entries()) {
      if (k === "vpnPort" || k === "managementPort") {
        payload[k] = parseInt(v) || 0;
      } else if (k === "allowLanAccess") {
        payload[k] = true;
      } else {
        payload[k] = v;
      }
    }
    // Only include password if non-empty
    const pwd = formData.get("adminPassword");
    if (pwd && pwd.length >= 6) {
      payload.adminPassword = pwd;
    } else {
      delete payload.adminPassword;
    }

    try {
      const r = await fetch(`${API}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.ok) {
        showToast("Settings saved", "success");
      } else {
        showToast(d.error || "Save failed", "error");
      }
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    }
  });

  // ---- Logs ----
  async function refreshLogs() {
    try {
      const r = await fetch(`${API}/logs`);
      const d = await r.json();
      logsOutput.textContent = d.logs || "(no logs available)";
    } catch (err) {
      logsOutput.textContent = "Error loading logs: " + err.message;
    }
  }

  refreshLogsBtn.addEventListener("click", refreshLogs);

  // ---- Toast ----
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = "toast " + (type || "");
    toast.hidden = false;
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  // ---- Utilities ----
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---- Load all data ----
  async function loadAll() {
    await Promise.all([refreshStatus(), loadServices(), loadClients(), loadSettings(), refreshLogs()]);
  }

  // ---- Init ----
  async function init() {
    const authed = await checkAuth();
    if (authed) {
      showDashboard();
    } else {
      showLogin();
    }
  }

  init();
})();
