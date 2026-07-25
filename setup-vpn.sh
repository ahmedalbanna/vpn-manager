#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# WireGuard VPN Server Setup Script
# ============================================================
# Safe to re-run (idempotent). Detects existing state and skips
# already-completed steps.
# ============================================================

# --- Detect node path (nvm, usr, or common paths) ---
detect_node_path() {
    if [ -x "/usr/local/bin/node" ]; then echo "/usr/local/bin/node"
    elif [ -x "/usr/bin/node" ]; then echo "/usr/bin/node"
    elif command -v node &>/dev/null; then command -v node
    elif [ -x "/root/.nvm/versions/node/current/bin/node" ]; then echo "/root/.nvm/versions/node/current/bin/node"
    else find / -name node -type f -executable 2>/dev/null | head -1
    fi
}
NODE_PATH=$(detect_node_path)
WG_QUICK="/usr/bin/wg-quick"
SYSTEMD="/usr/bin/systemctl"
UFW="/usr/sbin/ufw"
SYSCTL="/sbin/sysctl"
IPTABLES="/sbin/iptables"

# Detect public IP if not provided
if [[ -z "$SERVER_IP" ]]; then
    echo "==> Detecting server public IP..."
    SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 ipinfo.io/ip 2>/dev/null || echo "")
    if [[ -z "$SERVER_IP" ]]; then
        # Fallback to eth0 IP
        SERVER_IP=$(ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
    fi
fi

echo "============================================"
echo "  WireGuard VPN Setup"
echo "============================================"
echo "  Server IP:      $SERVER_IP"
echo "  VPN Port:       $VPN_PORT/UDP"
echo "  VPN Subnet:     $VPN_SUBNET"
echo "  Interface:      $VPN_INTERFACE"
echo "  Mgmt Port:      $MANAGEMENT_PORT"
echo "============================================"
echo ""

# -----------------------------------------------------------
# Step 1: Install packages
# -----------------------------------------------------------
echo "[1/9] Installing required packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq wireguard qrencode jq curl bc ufw sudo 2>&1 | tail -5

# -----------------------------------------------------------
# Step 2: Create vpn-manager user
# -----------------------------------------------------------
echo "[2/9] Creating vpn-manager user..."
if ! id "$MANAGER_USER" &>/dev/null; then
    useradd -r -s /bin/false -d /opt/vpn-manager "$MANAGER_USER"
    mkdir -p /opt/vpn-manager/clients
    chown -R "$MANAGER_USER:$MANAGER_USER" /opt/vpn-manager
else
    echo "  User '$MANAGER_USER' already exists — skipping."
fi

# -----------------------------------------------------------
# Step 3: Create directories
# -----------------------------------------------------------
echo "[3/9] Creating directory structure..."
mkdir -p "$WG_DIR/server" "$CLIENTS_DIR" "$CONFIG_DIR" "$MGMT_DIR/public"
chmod 700 "$WG_DIR"
chmod 700 "$WG_DIR/server"
chmod 700 "$CLIENTS_DIR"

# -----------------------------------------------------------
# Step 4: Generate WireGuard server keypair
# -----------------------------------------------------------
echo "[4/9] Generating WireGuard server keypair..."
if [[ ! -f "${SERVER_DIR}/privatekey" ]]; then
    ${WG_QUICK} genkey 2>/dev/null | tee "${SERVER_DIR}/privatekey" | ${WG_QUICK} pubkey > "${SERVER_DIR}/publickey" 2>/dev/null || \
    wg genkey | tee "${SERVER_DIR}/privatekey" | wg pubkey > "${SERVER_DIR}/publickey"
    chmod 600 "${SERVER_DIR}/privatekey"
    chmod 644 "${SERVER_DIR}/publickey"
    echo "  Keys generated."
else
    echo "  Server keypair already exists — skipping."
fi

SERVER_PUB_KEY=$(cat "${SERVER_DIR}/publickey")
SERVER_PRIV_KEY=$(cat "${SERVER_DIR}/privatekey")

# -----------------------------------------------------------
# Step 5: Create wg0.conf
# -----------------------------------------------------------
echo "[5/9] Creating WireGuard configuration..."
WG_CONF="${WG_DIR}/${VPN_INTERFACE}.conf"

# Collect currently-running services for reference
EXPOSED_SERVICES="[]"
while IFS= read -r line; do
    PORT=$(echo "$line" | awk '{print $4}' | rev | cut -d: -f1 | rev)
    PROC=$(echo "$line" | awk '{print $NF}' | cut -d, -f1)
    if [[ "$PORT" =~ ^[0-9]+$ ]] && [[ "$PORT" -lt 65536 ]] && [[ "$PORT" -ne "$VPN_PORT" ]]; then
        EXPOSED_SERVICES=$(echo "$EXPOSED_SERVICES" | jq --argjson p "$PORT" --arg pr "$PROC" '. + [{"port": $p, "process": $pr}]')
    fi
done < <(ss -tlnp 2>/dev/null | grep LISTEN | grep '0.0.0.0' | grep -v ':22 ' | grep -v ":${VPN_PORT} ")

cat > "$WG_CONF" <<WGEOF
[Interface]
PrivateKey = ${SERVER_PRIV_KEY}
Address = 10.0.0.1/24
ListenPort = ${VPN_PORT}
PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -s ${VPN_SUBNET} -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -s ${VPN_SUBNET} -o eth0 -j MASQUERADE
PostUp = sysctl -w net.ipv4.ip_forward=1
PostDown = sysctl -w net.ipv4.ip_forward=0
WGEOF

chmod 600 "$WG_CONF"
echo "  WireGuard config written to ${WG_CONF}"

# -----------------------------------------------------------
# Step 6: Enable IP forwarding persistently
# -----------------------------------------------------------
echo "[6/9] Configuring IP forwarding..."
SYSCTL_CONF="/etc/sysctl.d/99-wg.conf"
if [[ ! -f "$SYSCTL_CONF" ]]; then
    cat > "$SYSCTL_CONF" <<EOF
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv4.conf.${VPN_INTERFACE}.forwarding = 1
EOF
    sysctl -p "$SYSCTL_CONF" >/dev/null 2>&1
    echo "  IP forwarding enabled persistently."
else
    echo "  IP forwarding already configured — skipping."
fi

# -----------------------------------------------------------
# Step 7: Configure UFW firewall
# -----------------------------------------------------------
echo "[7/9] Configuring UFW firewall..."

# Set default forward policy to ACCEPT for VPN forwarding
sed -i 's/^#*DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
if ! grep -q '^DEFAULT_FORWARD_POLICY' /etc/default/ufw; then
    echo 'DEFAULT_FORWARD_POLICY="ACCEPT"' >> /etc/default/ufw
fi

# Allow VPN port
$UFW allow "${VPN_PORT}/udp" comment "WireGuard VPN" 2>/dev/null || true

# Allow management port
$UFW allow "${MANAGEMENT_PORT}/tcp" comment "VPN Manager Web UI" 2>/dev/null || true

# Allow SSH (ensure it stays open)
$UFW allow 22/tcp comment "SSH" 2>/dev/null || true

# Enable UFW if not already enabled
$UFW --force enable 2>/dev/null || true

echo "  UFW rules configured."

# -----------------------------------------------------------
# Step 8: Configure sudoers for vpn-manager user
# -----------------------------------------------------------
echo "[8/9] Configuring sudoers for ${MANAGER_USER}..."
SUDOERS_FILE="/etc/sudoers.d/vpn-manager"
cat > "$SUDOERS_FILE" <<SUDOEOF
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
${MANAGER_USER} ALL=(root) NOPASSWD: /usr/bin/env
SUDOEOF

chmod 440 "$SUDOERS_FILE"
echo "  Sudoers rules written."

# Ensure vpn-manager can write to client dir
chown -R "${MANAGER_USER}:${MANAGER_USER}" "${CLIENTS_DIR}"
chown -R "${MANAGER_USER}:${MANAGER_USER}" "${CONFIG_DIR}"

# -----------------------------------------------------------
# Step 9: Enable and start WireGuard
# -----------------------------------------------------------
echo "[9/9] Enabling and starting WireGuard..."
systemctl enable wg-quick@wg0 2>/dev/null || true
systemctl restart wg-quick@wg0 2>/dev/null || true

# Verify WireGuard is running
sleep 1
if wg show "$VPN_INTERFACE" &>/dev/null; then
    echo "  WireGuard is running on ${VPN_INTERFACE}."
else
    echo "  WARNING: WireGuard may not have started correctly. Check with: wg show"
fi

# -----------------------------------------------------------
# Summary
# -----------------------------------------------------------
echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "  VPN Server Public Key:"
echo "    ${SERVER_PUB_KEY}"
echo ""
echo "  VPN Endpoint:"
echo "    ${SERVER_IP}:${VPN_PORT}"
echo ""
echo "  VPN Subnet:"
echo "    ${VPN_SUBNET}"
echo ""
echo "  Admin Credentials:"
echo "    Created. Set your password now:"
echo "    sudo -u ${MANAGER_USER} passwd"
echo ""
echo "  Management Web UI:"
echo "    http://${SERVER_IP}:${MANAGEMENT_PORT}"
echo ""
echo "  Client configs are stored in: ${CLIENTS_DIR}/"
echo ""
echo "  Next steps:"
echo "    1. Set a strong admin password: sudo passwd ${MANAGER_USER}"
echo "    2. Generate a client key via the web UI"
echo "    3. Import the .conf file into WireGuard on your device"
echo "    4. Connect and access your services through the VPN"
echo ""
echo "============================================"
