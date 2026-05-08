#!/usr/bin/env bash
# ufw-lockdown-cf.sh
#
# Restrict inbound 80/443 to Cloudflare IP ranges only. Run this AFTER you've
# confirmed every domain on this VPS is proxied through Cloudflare (orange
# cloud). If any domain is on gray cloud or accessed directly by IP, this
# WILL break it — that's the point.
#
# Verify before running:
#   1. List nginx vhosts:        ls /etc/nginx/sites-enabled/
#   2. For each domain, check:   dig +short <domain>
#      If the answer is in the CF range list below, that vhost is fine.
#      If it's your VPS IP directly, this script would lock it out.
#   3. Cert-renewal: certbot HTTP-01 challenge needs port 80 reachable from
#      Let's Encrypt's IPs. Either use DNS-01 challenges, or run this LATER
#      and temporarily allow 80 from anywhere when renewing.
#
# Reversal:
#   sudo ufw delete <rule-number>     (use `sudo ufw status numbered`)
#   sudo ufw allow 80
#   sudo ufw allow 443
#
# Usage:
#   sudo bash ufw-lockdown-cf.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root (use sudo)." >&2
   exit 1
fi

echo "═══════════════════════════════════════════════════════════"
echo "  UFW Cloudflare-only lockdown (ports 80, 443)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Current UFW status:"
ufw status numbered | grep -E "(80|443|Nginx)" || true
echo ""
read -rp "Proceed? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# Fetch live CF IP ranges (refreshed daily by CF)
echo "Fetching Cloudflare IP ranges..."
CF_V4=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4/)
CF_V6=$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6/)

if [[ -z "$CF_V4" ]]; then
    echo "Failed to fetch Cloudflare IPv4 ranges. Aborting." >&2
    exit 1
fi

# Remove existing wide-open Nginx Full rules
echo "Removing wide-open Nginx Full rules..."
ufw delete allow "Nginx Full" 2>/dev/null || true
ufw delete allow 80/tcp        2>/dev/null || true
ufw delete allow 443/tcp       2>/dev/null || true
ufw delete allow 80            2>/dev/null || true
ufw delete allow 443           2>/dev/null || true

# Allow per-CF-range
echo "Adding Cloudflare IPv4 allow rules..."
while IFS= read -r cidr; do
    [[ -z "$cidr" ]] && continue
    ufw allow proto tcp from "$cidr" to any port 80 comment "CF v4 :80"
    ufw allow proto tcp from "$cidr" to any port 443 comment "CF v4 :443"
done <<< "$CF_V4"

if [[ -n "$CF_V6" ]]; then
    echo "Adding Cloudflare IPv6 allow rules..."
    while IFS= read -r cidr; do
        [[ -z "$cidr" ]] && continue
        ufw allow proto tcp from "$cidr" to any port 80 comment "CF v6 :80"
        ufw allow proto tcp from "$cidr" to any port 443 comment "CF v6 :443"
    done <<< "$CF_V6"
fi

ufw reload
echo ""
echo "Done. Verify with: sudo ufw status numbered"
echo ""
echo "TEST: from outside the VPS, your domain should still load via Cloudflare,"
echo "but a direct \`curl -I http://<VPS_IP>\` from elsewhere should HANG / fail."
echo ""
echo "If anything broke, revert with: sudo ufw allow 80 && sudo ufw allow 443"
