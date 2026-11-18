"""Create the Always Free AMD micro server (VM.Standard.E2.1.Micro: 1 OCPU / 1 GB) with our SSH key.

Optionally deletes a micro instance made by hand first (--replace "<exact display name>"): it only deletes an
instance with that exact name AND the micro shape, and also deletes its boot volume.

  python oci_micro_create.py                                   # create portfolio-micro
  python oci_micro_create.py --replace instance-20261118-1027  # delete that micro, then create ours
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import oci

sys.path.insert(0, str(Path(__file__).resolve().parent))
from oci_a1_grab import SSH_PUB, ensure_network, log  # noqa: E402

SHAPE = "VM.Standard.E2.1.Micro"
NAME = "portfolio-micro"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default=NAME)
    ap.add_argument("--replace", help="exact display name of a micro instance to delete first")
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()

    cfg = oci.config.from_file()
    comp = cfg["tenancy"]
    compute = oci.core.ComputeClient(cfg)
    alive = lambda xs: [i for i in xs if i.lifecycle_state not in ("TERMINATED", "TERMINATING")]

    if args.replace:
        targets = alive(compute.list_instances(comp, display_name=args.replace).data)
        if len(targets) != 1 or targets[0].shape != SHAPE:
            sys.exit(f"refusing: expected exactly one {SHAPE} named {args.replace!r}, found {[(t.display_name, t.shape) for t in targets]}")
        log(f"terminating {targets[0].display_name} ({targets[0].id}) and its boot volume")
        compute.terminate_instance(targets[0].id, preserve_boot_volume=False)
        oci.wait_until(compute, compute.get_instance(targets[0].id), "lifecycle_state", "TERMINATED", max_wait_seconds=900)
        log("terminated")

    if alive(compute.list_instances(comp, display_name=args.name).data):
        sys.exit(f"instance {args.name} already exists")

    subnet_id = ensure_network(cfg, comp)
    identity = oci.identity.IdentityClient(cfg)
    ad = identity.list_availability_domains(comp).data[0].name
    imgs = compute.list_images(comp, operating_system="Canonical Ubuntu", operating_system_version="24.04",
                               shape=SHAPE, sort_by="TIMECREATED", sort_order="DESC").data
    imgs = [i for i in imgs if "Minimal" not in i.display_name]
    if not imgs:
        sys.exit("no Ubuntu 24.04 image for the micro shape")
    log(f"image {imgs[0].display_name}")

    details = oci.core.models.LaunchInstanceDetails(
        compartment_id=comp, availability_domain=ad, display_name=args.name, shape=SHAPE,
        source_details=oci.core.models.InstanceSourceViaImageDetails(image_id=imgs[0].id),
        create_vnic_details=oci.core.models.CreateVnicDetails(subnet_id=subnet_id, assign_public_ip=True),
        metadata={"ssh_authorized_keys": SSH_PUB.read_text().strip()},
    )
    attempt = 0
    while True:
        attempt += 1
        log(f"attempt {attempt}: {SHAPE} in {ad}")
        try:
            inst = compute.launch_instance(details).data
            break
        except oci.exceptions.ServiceError as e:
            if "capacity" in (e.message or "").lower() or e.status in (429, 500, 503):
                log(f"  retry in {args.interval}s ({e.status} {e.code})")
                time.sleep(args.interval)
                continue
            sys.exit(f"stopping on error: {e.status} {e.code} {e.message}")
    log(f"LAUNCHED {inst.id} -- waiting for RUNNING")
    oci.wait_until(compute, compute.get_instance(inst.id), "lifecycle_state", "RUNNING", max_wait_seconds=900)
    net = oci.core.VirtualNetworkClient(cfg)
    for att in compute.list_vnic_attachments(comp, instance_id=inst.id).data:
        if att.lifecycle_state == "ATTACHED":
            log(f"RUNNING. public IP: {net.get_vnic(att.vnic_id).data.public_ip}")
    log("next: ssh -i ~/.ssh/oracle_portfolio ubuntu@<public IP>")


if __name__ == "__main__":
    main()
