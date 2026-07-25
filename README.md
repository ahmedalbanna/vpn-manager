# WireGuard VPN + Web Manager - Deployment Guide

A portable VPN server setup with a web-based management dashboard. Deploys WireGuard VPN with a Node.js management UI for turning VPN on/off, creating client configs, and managing server settings.

## What's Included

| File | Purpose |
|------|---------|
| `setup-vpn.sh` | Automated server setup script (idempotent) |
| `/opt/vpn-manager/` | Web management application |
| `/opt/vpn-manager/server.js` | Express API backend |
| `/opt/vpn-manager/public/` | Dashboard UI (index.html, app.js, style.css) |
| `/opt/vpn-manager/package.json` | Node.js dependencies |
| `/opt/vpn-manager/vpn-manager.service` | Systemd service unit |
| `/etc/wireguard/wg0.conf` | WireGuard server config |
| `/etc/vpn-manager/config.json` | VPN settings & client registry |

## Prerequisites (on any new server)

- Ubuntu 22.04 / 24.04 (or any Linux with systemd)
- Root access (or sudo)
- Public IP address
- Port 51820/UDP open (for WireGuard VPN)
- Port 8090/TCP open (for management UI, optional)
- Docker is NOT required — uses systemd + native node

## Quick Start

### 1. Deploy the setup script

```bash
# Copy setup-vpn.sh to the server
scp setup-vpn.sh root@your-server:/root/

# SSH in and run it
ssh root@your-server
bash /root/setup-vpn.sh
```

### 2. What the script does automatically

- Installs WireGuard, qrencode, jq, UFW
- Generates WireGuard server keypair
- Creates `wg0.conf` with NAT masquerading
- Enables IP forwarding persistently
- Opens UFW ports (51820/udp, 8090/tcp)
- Creates `vpn-manager` user with limited sudo
- Deploys the web manager to `/opt/vpn-manager/`
- Installs Node.js dependencies
- Enables `wg-quick@wg0` and `vpn-manager` as systemd services
- Configures `wg0.conf` dynamically

### 3. Access the management dashboard

Open in browser: **`http://<server-ip>:8090`**

Login with username `admin` and the password you set during setup.

## Usage

### Dashboard Pages

1. **VPN Connection** — Toggle VPN on/off, restart WireGuard
2. **Status** — View interface state, peer count, WireGuard output
3. **Services** — Toggle which services are exposed to VPN clients
4. **Clients** — Create new client configs, download `.conf` files, view QR codes, delete clients
5. **Settings** — Configure VPN port, subnet, server IP, management port, LAN access
6. **Logs** — View WireGuard system logs

### Connecting a Client Device (e.g., 192.168.8.200)

1. Open the VPN Manager dashboard
2. Go to **Clients** → click **+ Add Client**
3. Enter a name (e.g., "Living Room iPad")
4. Click **Create** — the config appears with a **Download** button
5. Download the `.conf` file to your device
6. Install WireGuard app on your device:
   - **iOS/Android**: WireGuard app from app store
   - **macOS/Windows**: WireGuard desktop client from wireguard.com
   - **Linux**: `sudo apt install wireguard`
7. Import the `.conf` file into the WireGuard app
8. Activate the tunnel
9. Your device can now access all VPN-exposed services on the server

## Configuration

All VPN settings are stored in `/etc/vpn-manager/config.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `vpnPort` | 51820 | WireGuard UDP port |
| `vpnSubnet` | 10.0.0.0/24 | VPN internal subnet |
| `serverIp` | auto-detected | Server public IP (for client configs) |
| `managementPort` | 8090 | Web UI port |
| `vpnEnabled` | false | Current VPN state |
| `allowLanAccess` | false | Let VPN clients reach local LAN |
| `exposedServices` | [] | List of ports exposed to VPN |
| `clients` | [] | Registered VPN clients |

### Changing VPN Settings via API

```bash
# Update server IP (if it changed)
curl -X PUT http://localhost:8090/api/settings \
  -H "Content-Type: application/json" \
  -d '{"serverIp": "YOUR_NEW_IP"}'
```

## Updating the Management App

```bash
# Push new version to server
scp -r vpn-manager/ root@server:/opt/vpn-manager/
ssh root@server "cd /opt/vpn-manager && npm install"
ssh root@server "systemctl restart vpn-manager"
```

## Firewall Rules (UFW)

The setup script automatically configures UFW:
- **51820/udp** — WireGuard VPN
- **8090/tcp** — Management UI (disable if not needed)
- **Forwarding** — Enabled in `/etc/default/ufw`

To disable management UI access from the internet:
```bash
ufw delete allow 8090/tcp
```

## Troubleshooting

### VPN shows as DOWN on dashboard
```bash
systemctl start wg-quick@wg0
systemctl status wg-quick@wg0
```

### Client creation fails with permission denied
```bash
# Fix directory permissions
chown -R vpn-manager:vpn-manager /etc/wireguard/clients/
chmod 755 /etc/wireguard/
chmod 755 /etc/wireguard/server/
```

### Can't connect to dashboard
```bash
# Check if port is open
ufw status | grep 8090
# Check service status
systemctl status vpn-manager
```

### Reset admin password
Delete `/etc/vpn-manager/config.json` and restart vpn-manager. The next login will prompt to set a new password.

## Security Notes

- Server private key is stored at `/etc/wireguard/server/privatekey` (mode 600)
- The management UI requires authentication
- VPN traffic is fully encrypted via WireGuard
- The `vpn-manager` user has limited sudo access (only specific commands)
- DNS server for VPN clients: `10.0.0.1` (the WireGuard server itself)

## Multi-Server Deployment

To deploy on multiple servers with the same configuration:

1. Copy `setup-vpn.sh` to each server
2. Run it on each server — it auto-detects IP and configures accordingly
3. Manage each server's VPN independently via its own dashboard

For shared client configs across servers (different subnets), generate a separate client per server with the appropriate `AllowedIPs`.
