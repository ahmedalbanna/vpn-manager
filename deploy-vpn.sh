#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# WireGuard VPN + Web Manager - Deployment Script
# Works on any Ubuntu 22.04/24.04 server
# Safe to re-run (idempotent)
# ============================================================

VPN_PORT="${VPN_PORT:-51820}"
VPN_SUBNET="${VPN_SUBNET:-10.0.0.0/24}"
VPN_INTERFACE="wg0"
WG_DIR="/etc/wireguard"
SERVER_DIR="${WG_DIR}/server"
CLIENTS_DIR="${WG_DIR}/clients"
MGMT_DIR="/opt/vpn-manager"
CONFIG_DIR="/etc/vpn-manager"
MANAGER_USER="vpn-manager"
MANAGEMENT_PORT="${MANAGEMENT_PORT:-8090}"
SERVER_IP="${SERVER_IP:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_err() { echo -e "${RED}[ERR]${NC} $1"; }
log_info() { echo -e "${YELLOW}[*]${NC} $1"; }

# ---------- Detect server IP ----------
if [[ -z "$SERVER_IP" ]]; then
    SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || \
                curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || \
                ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1 || echo "auto")
fi

# ---------- Detect node path ----------
detect_node() {
    for p in /usr/local/bin/node /usr/bin/node; do
        [[ -x "$p" ]] && echo "$p" && return
    done
    command -v node 2>/dev/null && return
    find / -name node -type f -executable 2>/dev/null | head -1
}
NODE_PATH=$(detect_node)
[[ -z "$NODE_PATH" ]] && log_err "Node.js not found" && exit 1
log_ok "Node.js found at: $NODE_PATH"

# ---------- Main steps ----------
echo "============================================"
echo "  WireGuard VPN Deployment"
echo "  Server IP: $SERVER_IP"
echo "============================================"

# 1. Install packages
log_info "Installing packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq 2>/dev/null
apt-get install -y -qq wireguard qrencode jq curl bc ufw sudo 2>&1 | tail -3
log_ok "Packages installed"

# 2. Create vpn-manager user
log_info "Creating vpn-manager user..."
id "$MANAGER_USER" 2>/dev/null || useradd -r -s /bin/false -d /opt/vpn-manager "$MANAGER_USER"
mkdir -p /opt/vpn-manager/clients "$CONFIG_DIR" "$CLIENTS_DIR"
chown -R "$MANAGER_USER:$MANAGER_USER" /opt/vpn-manager /etc/vpn-manager /etc/wireguard/clients 2>/dev/null || true
log_ok "User created"

# 3. Fix WireGuard directory permissions (allow vpn-manager to read keys)
log_info "Fixing directory permissions..."
chmod 755 "$WG_DIR" "$WG_DIR/server" "$CLIENTS_DIR" 2>/dev/null || true
chmod 644 "${SERVER_DIR}/publickey" 2>/dev/null || true
log_ok "Permissions set"

# 4. Generate WireGuard keypair
log_info "Generating WireGuard keypair..."
if [[ ! -f "${SERVER_DIR}/privatekey" ]]; then
    wg genkey > "${SERVER_DIR}/privatekey"
    cat "${SERVER_DIR}/privatekey" | wg pubkey > "${SERVER_DIR}/publickey"
    chmod 600 "${SERVER_DIR}/privatekey"
    chmod 644 "${SERVER_DIR}/publickey"
    log_ok "Keys generated"
else
    log_ok "Keys already exist"
fi
SERVER_PUB_KEY=$(cat "${SERVER_DIR}/publickey")

# 5. Create wg0.conf
log_info "Creating WireGuard config..."
WG_CONF="${WG_DIR}/${VPN_INTERFACE}.conf"
cat > "$WG_CONF" << WGEOF
[Interface]
PrivateKey = $(cat "${SERVER_DIR}/privatekey")
Address = 10.0.0.1/24
ListenPort = ${VPN_PORT}
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -s ${VPN_SUBNET} -o eth0 -j MASQUERADE; sysctl -w net.ipv4.ip_forward=1
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -s ${VPN_SUBNET} -o eth0 -j MASQUERADE; sysctl -w net.ipv4.ip_forward=0
WGEOF
chmod 600 "$WG_CONF"
log_ok "Config written"

# 6. IP forwarding
log_info "Enabling IP forwarding..."
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-wg.conf
sysctl -p /etc/sysctl.d/99-wg.conf >/dev/null 2>&1
log_ok "IP forwarding enabled"

# 7. UFW
log_info "Configuring firewall..."
sed -i 's/^#*DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
grep -q '^DEFAULT_FORWARD_POLICY' /etc/default/ufw || echo 'DEFAULT_FORWARD_POLICY="ACCEPT"' >> /etc/default/ufw
ufw allow "${VPN_PORT}/udp" comment "WireGuard VPN" 2>/dev/null || true
ufw allow "${MANAGEMENT_PORT}/tcp" comment "VPN Manager" 2>/dev/null || true
ufw allow 22/tcp comment "SSH" 2>/dev/null || true
ufw --force enable 2>/dev/null || true
log_ok "Firewall configured"

# 8. Sudoers
log_info "Configuring sudo access..."
cat > /etc/sudoers.d/vpn-manager << SUDOEOF
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start wg-quick@${VPN_INTERFACE}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl stop wg-quick@${VPN_INTERFACE}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl restart wg-quick@${VPN_INTERFACE}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl status wg-quick@${VPN_INTERFACE}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/sbin/ufw allow
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/sbin/ufw delete allow
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/sbin/ufw reload
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/wg show ${VPN_INTERFACE}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/wg setconf ${VPN_INTERFACE} ${WG_CONF}
${MANAGER_USER} ALL=(root) NOPASSWD: /bin/cat ${WG_CONF}
${MANAGER_USER} ALL=(root) NOPASSWD: /bin/ls ${CLIENTS_DIR}/
${MANAGER_USER} ALL=(root) NOPASSWD: /bin/cat ${CLIENTS_DIR}/*
${MANAGER_USER} ALL=(root) NOPASSWD: /bin/rm ${CLIENTS_DIR}/*
${MANAGER_USER} ALL=(root) NOPASSWD: /bin/mkdir -p ${CLIENTS_DIR}
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/wg genkey
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/wg pubkey
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/qrencode
SUDOEOF
chmod 440 /etc/sudoers.d/vpn-manager
log_ok "Sudoers configured"

# 9. Enable and start WireGuard
log_info "Starting WireGuard..."
systemctl daemon-reload
systemctl enable wg-quick@wg0 2>/dev/null || true
systemctl restart wg-quick@wg0 2>/dev/null || true
sleep 1
wg show "$VPN_INTERFACE" >/dev/null 2>&1 && log_ok "WireGuard is RUNNING" || log_err "WireGuard failed to start"

# 10. Start VPN Manager web app
log_info "Starting VPN Manager web UI..."
systemctl enable vpn-manager 2>/dev/null || true
systemctl restart vpn-manager 2>/dev/null || true
sleep 1
systemctl is-active vpn-manager >/dev/null 2>&1 && log_ok "VPN Manager running on :${MANAGEMENT_PORT}" || log_err "VPN Manager failed to start"

# ---- Summary ----
echo ""
echo "============================================"
echo "  Deployment Complete!"
echo "============================================"
echo "  VPN Endpoint:   ${SERVER_IP}:${VPN_PORT}/UDP"
echo "  VPN Subnet:     ${VPN_SUBNET}"
echo "  WireGuard Key:  ${SERVER_PUB_KEY}"
echo "  Management UI:  http://${SERVER_IP}:${MANAGEMENT_PORT}"
echo "  Client Configs: ${CLIENTS_DIR}/"
echo ""
echo "  Next: Open the management UI in a browser,"
echo "  log in (first time: set a password),"
echo "  add a client, and connect your device."
echo "============================================"
