"""Create the network and keep retrying the Always Free A1 launch until Oracle has capacity.

Uses the OCI Python SDK (pip package `oci`) and ~/.oci/config. Safe to re-run: existing resources are reused,
and it exits immediately if an instance with the same name already exists.

  python oci_a1_grab.py --network-only           # just create/check the network
  python oci_a1_grab.py                          # network + retry launch (4 OCPU / 24 GB, every 180 s)
  python oci_a1_grab.py --ocpus 2 --memory 12    # smaller size
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

import oci

NAME = "portfolio"
INSTANCE_NAME = "portfolio-a1"
SHAPE = "VM.Standard.A1.Flex"
SSH_PUB = Path.home() / ".ssh" / "oracle_portfolio.pub"


def log(msg: str) -> None:
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def first(items, **match):
    for it in items:
        if all(getattr(it, k) == v for k, v in match.items()):
            return it
    return None


def ensure_network(cfg: dict, comp: str) -> str:
    net = oci.core.VirtualNetworkClient(cfg)
    alive = lambda xs: [x for x in xs if x.lifecycle_state == "AVAILABLE"]

    vcn = first(alive(oci.pagination.list_call_get_all_results(net.list_vcns, comp).data), display_name=f"{NAME}-vcn")
    if not vcn:
        vcn = net.create_vcn(oci.core.models.CreateVcnDetails(
            compartment_id=comp, display_name=f"{NAME}-vcn", cidr_blocks=["10.0.0.0/16"], dns_label="portfoliovcn")).data
        vcn = oci.wait_until(net, net.get_vcn(vcn.id), "lifecycle_state", "AVAILABLE").data
        log(f"created VCN {vcn.id}")
    else:
        log(f"VCN exists {vcn.id}")

    igw = first(alive(net.list_internet_gateways(comp, vcn_id=vcn.id).data), display_name=f"{NAME}-igw")
    if not igw:
        igw = net.create_internet_gateway(oci.core.models.CreateInternetGatewayDetails(
            compartment_id=comp, vcn_id=vcn.id, display_name=f"{NAME}-igw", is_enabled=True)).data
        igw = oci.wait_until(net, net.get_internet_gateway(igw.id), "lifecycle_state", "AVAILABLE").data
        log(f"created internet gateway {igw.id}")

    # Default route table: 0.0.0.0/0 -> internet gateway
    net.update_route_table(vcn.default_route_table_id, oci.core.models.UpdateRouteTableDetails(route_rules=[
        oci.core.models.RouteRule(destination="0.0.0.0/0", destination_type="CIDR_BLOCK", network_entity_id=igw.id)]))
    log("route 0.0.0.0/0 -> internet gateway")

    # Default security list: allow all egress; ingress 22/80/443 + ICMP fragmentation-needed (path MTU)
    tcp = lambda p: oci.core.models.IngressSecurityRule(
        source="0.0.0.0/0", protocol="6",
        tcp_options=oci.core.models.TcpOptions(destination_port_range=oci.core.models.PortRange(min=p, max=p)))
    net.update_security_list(vcn.default_security_list_id, oci.core.models.UpdateSecurityListDetails(
        ingress_security_rules=[tcp(22), tcp(80), tcp(443), oci.core.models.IngressSecurityRule(
            source="0.0.0.0/0", protocol="1", icmp_options=oci.core.models.IcmpOptions(type=3, code=4))],
        egress_security_rules=[oci.core.models.EgressSecurityRule(destination="0.0.0.0/0", protocol="all")]))
    log("security list: ingress 22, 80, 443 open")

    sub = first(alive(net.list_subnets(comp, vcn_id=vcn.id).data), display_name=f"{NAME}-public")
    if not sub:
        sub = net.create_subnet(oci.core.models.CreateSubnetDetails(
            compartment_id=comp, vcn_id=vcn.id, display_name=f"{NAME}-public", cidr_block="10.0.0.0/24",
            dns_label="public", prohibit_public_ip_on_vnic=False,
            route_table_id=vcn.default_route_table_id, security_list_ids=[vcn.default_security_list_id])).data
        sub = oci.wait_until(net, net.get_subnet(sub.id), "lifecycle_state", "AVAILABLE").data
        log(f"created public subnet {sub.id}")
    else:
        log(f"subnet exists {sub.id}")
    return sub.id


def find_image(compute, comp: str) -> str:
    imgs = compute.list_images(comp, operating_system="Canonical Ubuntu", operating_system_version="24.04",
                               shape=SHAPE, sort_by="TIMECREATED", sort_order="DESC").data
    imgs = [i for i in imgs if "Minimal" not in i.display_name]
    if not imgs:
        sys.exit("no Ubuntu 24.04 image found for A1")
    log(f"image {imgs[0].display_name}")
    return imgs[0].id


def public_ip(cfg: dict, comp: str, instance_id: str) -> str | None:
    compute = oci.core.ComputeClient(cfg)
    net = oci.core.VirtualNetworkClient(cfg)
    for att in compute.list_vnic_attachments(comp, instance_id=instance_id).data:
        if att.lifecycle_state == "ATTACHED":
            return net.get_vnic(att.vnic_id).data.public_ip
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ocpus", type=float, default=4)
    ap.add_argument("--memory", type=float, default=24)
    ap.add_argument("--boot-gb", type=int, default=100)
    ap.add_argument("--interval", type=int, default=180, help="seconds between attempts")
    ap.add_argument("--network-only", action="store_true")
    args = ap.parse_args()

    if args.ocpus > 4 or args.memory > 24 or args.boot_gb > 200:
        sys.exit("refusing: above Always Free limits (4 OCPU / 24 GB / 200 GB)")

    cfg = oci.config.from_file()
    comp = cfg["tenancy"]  # root compartment
    identity = oci.identity.IdentityClient(cfg)
    compute = oci.core.ComputeClient(cfg)

    subnet_id = ensure_network(cfg, comp)
    if args.network_only:
        return

    existing = [i for i in compute.list_instances(comp, display_name=INSTANCE_NAME).data
                if i.lifecycle_state not in ("TERMINATED", "TERMINATING")]
    if existing:
        log(f"instance already exists: {existing[0].id} ({existing[0].lifecycle_state}); "
            f"public IP {public_ip(cfg, comp, existing[0].id)}")
        return

    ad = identity.list_availability_domains(comp).data[0].name
    details = oci.core.models.LaunchInstanceDetails(
        compartment_id=comp, availability_domain=ad, display_name=INSTANCE_NAME, shape=SHAPE,
        shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(ocpus=args.ocpus, memory_in_gbs=args.memory),
        source_details=oci.core.models.InstanceSourceViaImageDetails(
            image_id=find_image(compute, comp), boot_volume_size_in_gbs=args.boot_gb),
        create_vnic_details=oci.core.models.CreateVnicDetails(subnet_id=subnet_id, assign_public_ip=True),
        metadata={"ssh_authorized_keys": SSH_PUB.read_text().strip()},
    )

    attempt = 0
    while True:
        attempt += 1
        log(f"attempt {attempt}: {SHAPE} {args.ocpus:g} OCPU / {args.memory:g} GB in {ad}")
        try:
            inst = compute.launch_instance(details).data
        except oci.exceptions.ServiceError as e:
            msg = (e.message or "").lower()
            if "capacity" in msg or e.status in (500, 503):
                log(f"  no capacity ({e.status} {e.code}); retry in {args.interval}s")
                time.sleep(args.interval)
                continue
            if e.status == 429:
                log(f"  rate limited; retry in {args.interval * 2}s")
                time.sleep(args.interval * 2)
                continue
            log(f"  stopping on error: {e.status} {e.code} {e.message}")
            sys.exit(1)
        log(f"LAUNCHED {inst.id} -- waiting for RUNNING")
        oci.wait_until(compute, compute.get_instance(inst.id), "lifecycle_state", "RUNNING", max_wait_seconds=900)
        log(f"RUNNING. public IP: {public_ip(cfg, comp, inst.id)}")
        log("next: ssh -i ~/.ssh/oracle_portfolio ubuntu@<public IP>")
        return


if __name__ == "__main__":
    main()
