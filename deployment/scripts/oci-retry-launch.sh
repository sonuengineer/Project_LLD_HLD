#!/usr/bin/env bash
# Keep trying to launch the Always Free A1 instance until Oracle has capacity.
# Runs on this PC (Git Bash) or any Linux box. NOT run yet -- needs the setup below.
#
# One-time setup:
#   1. Install the OCI CLI: https://docs.oracle.com/iaas/Content/API/SDKDocs/cliinstall.htm
#   2. `oci setup config`  -> creates ~/.oci/config and an API key pair.
#      Upload the PUBLIC API key in the console: Profile -> My profile -> API keys -> Add API key.
#      (This is a credential for your whole account: keep ~/.oci private, never commit it.)
#   3. Create the network once in the console: Networking -> Virtual cloud networks ->
#      "Start VCN Wizard" -> "Create VCN with Internet Connectivity". Copy the PUBLIC subnet OCID.
#   4. Fill in the variables below (OCIDs are on each resource's details page).
#
# Usage:  bash oci-retry-launch.sh
set -uo pipefail

COMPARTMENT_OCID="${COMPARTMENT_OCID:?set to the tenancy (root compartment) OCID}"
SUBNET_OCID="${SUBNET_OCID:?set to the public subnet OCID}"
IMAGE_OCID="${IMAGE_OCID:?set to the Canonical Ubuntu 24.04 aarch64 image OCID for ap-mumbai-1}"
AD="${AD:?set to the availability domain name, e.g. foCn:AP-MUMBAI-1-AD-1}"
OCPUS="${OCPUS:-4}"
MEMORY_GB="${MEMORY_GB:-24}"
SSH_PUB="${SSH_PUB:-$HOME/.ssh/oracle_portfolio.pub}"
WAIT_SECONDS="${WAIT_SECONDS:-180}"   # don't hammer the API; a few minutes between tries is plenty

attempt=0
while true; do
  attempt=$((attempt + 1))
  echo "[$(date '+%F %T')] attempt $attempt: A1 ${OCPUS} OCPU / ${MEMORY_GB} GB"
  out=$(oci compute instance launch \
    --compartment-id "$COMPARTMENT_OCID" \
    --availability-domain "$AD" \
    --shape VM.Standard.A1.Flex \
    --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEMORY_GB}" \
    --image-id "$IMAGE_OCID" \
    --subnet-id "$SUBNET_OCID" \
    --assign-public-ip true \
    --boot-volume-size-in-gbs 100 \
    --display-name portfolio-a1 \
    --ssh-authorized-keys-file "$SSH_PUB" 2>&1)
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "$out" | grep -E '"(id|lifecycle-state)"' | head -2
    echo "Launched. Check the console for the public IP."
    exit 0
  fi
  if echo "$out" | grep -qiE 'out of (host )?capacity|InternalError'; then
    echo "  no capacity yet, retrying in ${WAIT_SECONDS}s"
    sleep "$WAIT_SECONDS"
    continue
  fi
  echo "Stopping on a non-capacity error:"
  echo "$out" | tail -20
  exit 1
done
