#!/bin/sh
# Run as root after Docker starts. Rules apply only to the scanner bridge.
set -eu
bridge=br-adtocart
network=adtocart-scanner
chain=ADTOCART-EGRESS
if ! docker network inspect "$network" >/dev/null 2>&1; then
  docker network create --driver bridge --subnet 172.30.80.0/24 \
    --opt com.docker.network.bridge.name="$bridge" "$network" >/dev/null
fi
# Refuse to attach restrictions to an unexpectedly configured network.
[ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$network")" = "$bridge" ]
[ "$(docker network inspect -f '{{.EnableIPv6}}' "$network")" = false ]
iptables -w -N "$chain" 2>/dev/null || true
# Keep rule updates fail-closed for this bridge.
iptables -w -I DOCKER-USER 1 -i "$bridge" -j REJECT
iptables -w -F "$chain"
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A "$chain" -d "$cidr" -j REJECT
done
iptables -w -A "$chain" -p tcp -m multiport --dports 80,443 -j RETURN
iptables -w -A "$chain" -j REJECT
iptables -w -C DOCKER-USER -i "$bridge" -j "$chain" 2>/dev/null || iptables -w -I DOCKER-USER 2 -i "$bridge" -j "$chain"
# Includes the host's public IP and bridge gateway, without affecting SSH ingress.
iptables -w -C INPUT -i "$bridge" -j REJECT 2>/dev/null || iptables -w -I INPUT 1 -i "$bridge" -j REJECT
iptables -w -D DOCKER-USER -i "$bridge" -j REJECT
