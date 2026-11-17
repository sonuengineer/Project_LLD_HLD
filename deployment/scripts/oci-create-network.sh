#!/usr/bin/env bash
# Creates the network the A1 instance needs, using the OCI CLI (~/.oci/config must work).
# VCN 10.0.0.0/16 + internet gateway + default route + security list (22, 80, 443 in) + public subnet 10.0.0.0/24.
# Safe to re-run: reuses resources that already exist with the same display name.
# Prints the subnet OCID at the end (needed by oci-retry-launch.sh).
set -euo pipefail

OCI="${OCI:-oci}"
C="${COMPARTMENT_OCID:?set COMPARTMENT_OCID (tenancy OCID = root compartment)}"
NAME="${NAME:-portfolio}"

q() { "$OCI" "$@" --all --query "data[?\"lifecycle-state\"=='AVAILABLE'] | [0].id" --raw-output 2>/dev/null || true; }

VCN=$(q network vcn list --compartment-id "$C" --display-name "$NAME-vcn")
if [[ -z "$VCN" || "$VCN" == "null" ]]; then
  VCN=$("$OCI" network vcn create --compartment-id "$C" --display-name "$NAME-vcn" \
        --cidr-blocks '["10.0.0.0/16"]' --dns-label portfoliovcn \
        --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "VCN      $VCN"

IGW=$(q network internet-gateway list --compartment-id "$C" --vcn-id "$VCN" --display-name "$NAME-igw")
if [[ -z "$IGW" || "$IGW" == "null" ]]; then
  IGW=$("$OCI" network internet-gateway create --compartment-id "$C" --vcn-id "$VCN" --display-name "$NAME-igw" \
        --is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "IGW      $IGW"

# Default route table of the VCN: send 0.0.0.0/0 to the internet gateway.
RT=$("$OCI" network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
"$OCI" network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
echo "Routes   0.0.0.0/0 -> IGW"

# Default security list: all egress; ingress SSH/HTTP/HTTPS from anywhere + ICMP path-MTU messages.
SL=$("$OCI" network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)
tcp() { echo "{\"source\":\"0.0.0.0/0\",\"protocol\":\"6\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":$1,\"max\":$1}}}"; }
INGRESS="[$(tcp 22),$(tcp 80),$(tcp 443),{\"source\":\"0.0.0.0/0\",\"protocol\":\"1\",\"isStateless\":false,\"icmpOptions\":{\"type\":3,\"code\":4}}]"
EGRESS='[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]'
"$OCI" network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" >/dev/null
echo "Firewall ingress 22, 80, 443 open"

SUBNET=$(q network subnet list --compartment-id "$C" --vcn-id "$VCN" --display-name "$NAME-public")
if [[ -z "$SUBNET" || "$SUBNET" == "null" ]]; then
  SUBNET=$("$OCI" network subnet create --compartment-id "$C" --vcn-id "$VCN" --display-name "$NAME-public" \
           --cidr-block 10.0.0.0/24 --dns-label public --prohibit-public-ip-on-vnic false \
           --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
           --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "SUBNET   $SUBNET"
