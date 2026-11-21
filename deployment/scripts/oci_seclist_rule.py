"""Add or remove ONE tagged ingress rule on the portfolio VCN's default security list, safely.

Why a tool: update_security_list REPLACES the whole ingress list, so a careless call can delete the SSH/80/443 rules and lock
you out. This script reads the current rules, changes only what you ask, shows the difference, and re-reads afterwards to
prove that every other rule is unchanged. It defaults to a dry run; nothing is written without --apply.

  show                                                   list the rules, the subnet(s) and which instances use them
  add    --cidr 10.0.0.39/32 --ports 18001-18004 --tag h11-bench-temp [--apply]
  remove --tag h11-bench-temp [--apply]                  removes only rules whose description is exactly the tag

Every write first saves a backup of the full rule list under ~/.oci/seclist-backups/ (outside the repo, because it
contains resource IDs). Uses ~/.oci/config like the other scripts in this folder.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import oci

VCN_NAME = "portfolio-vcn"
BACKUPS = Path.home() / ".oci" / "seclist-backups"


def rule_key(r) -> tuple:
    """A comparable identity for an ingress rule."""
    t = r.tcp_options.destination_port_range if r.tcp_options and r.tcp_options.destination_port_range else None
    return (r.protocol, r.source, r.source_type, bool(r.is_stateless), (t.min, t.max) if t else None, r.description or "")


def describe(r) -> str:
    proto = {"6": "tcp", "17": "udp", "1": "icmp", "all": "all"}.get(str(r.protocol), str(r.protocol))
    ports = ""
    if r.tcp_options and r.tcp_options.destination_port_range:
        p = r.tcp_options.destination_port_range
        ports = f" dport {p.min}" + (f"-{p.max}" if p.max != p.min else "")
    return f"{proto:4} from {r.source}{ports}" + (f"  [{r.description}]" if r.description else "")


def load():
    cfg = oci.config.from_file()
    net = oci.core.VirtualNetworkClient(cfg)
    compute = oci.core.ComputeClient(cfg)
    comp = cfg["tenancy"]
    vcns = [v for v in oci.pagination.list_call_get_all_results(net.list_vcns, comp).data
            if v.display_name == VCN_NAME and v.lifecycle_state == "AVAILABLE"]
    if len(vcns) != 1:
        sys.exit(f"expected exactly one VCN named {VCN_NAME}, found {len(vcns)}")
    vcn = vcns[0]
    sl = net.get_security_list(vcn.default_security_list_id).data
    return cfg, net, compute, comp, vcn, sl


def show(net, compute, comp, vcn, sl) -> None:
    print(f"VCN {vcn.display_name} {vcn.cidr_block}; default security list: {sl.display_name}")
    print("ingress rules:")
    for r in sl.ingress_security_rules:
        print("  ", describe(r))
    subnets = oci.pagination.list_call_get_all_results(net.list_subnets, comp, vcn_id=vcn.id).data
    for s in subnets:
        uses = vcn.default_security_list_id in (s.security_list_ids or [])
        print(f"subnet {s.display_name} {s.cidr_block}: uses this security list: {uses}")
    for inst in compute.list_instances(comp).data:
        if inst.lifecycle_state != "RUNNING":
            continue
        for att in compute.list_vnic_attachments(comp, instance_id=inst.id).data:
            if att.lifecycle_state == "ATTACHED":
                vnic = net.get_vnic(att.vnic_id).data
                print(f"instance {inst.display_name}: private IP {vnic.private_ip}, subnet attached to this list: "
                      f"{vcn.default_security_list_id in (net.get_subnet(vnic.subnet_id).data.security_list_ids or [])}")


def backup(sl) -> Path:
    BACKUPS.mkdir(parents=True, exist_ok=True)
    path = BACKUPS / f"{time.strftime('%Y%m%d-%H%M%S')}-{sl.display_name}.json"
    path.write_text(json.dumps(oci.util.to_dict(sl), indent=1, default=str), encoding="utf-8")
    return path


def apply_change(net, sl, new_ingress, before_keys: set, expect_added: set, expect_removed: set) -> None:
    details = oci.core.models.UpdateSecurityListDetails(ingress_security_rules=new_ingress, egress_security_rules=sl.egress_security_rules)
    net.update_security_list(sl.id, details)
    after = net.get_security_list(sl.id).data
    after_keys = {rule_key(r) for r in after.ingress_security_rules}
    problems = []
    if after_keys != (before_keys | expect_added) - expect_removed:
        problems.append("the resulting rule set is not exactly the expected one")
    if {rule_key(r) for r in after.egress_security_rules} != {rule_key_egress(r) for r in sl.egress_security_rules}:
        problems.append("egress rules changed")
    if problems:
        sys.exit("VERIFY FAILED: " + "; ".join(problems) + ". Restore from the backup file printed above.")
    print("verified: every other rule is unchanged. Rules now:")
    for r in after.ingress_security_rules:
        print("  ", describe(r))


def rule_key_egress(r) -> tuple:
    return (r.protocol, r.destination, r.destination_type, bool(r.is_stateless))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("show")
    a = sub.add_parser("add")
    a.add_argument("--cidr", required=True)
    a.add_argument("--ports", required=True, help="for example 18001-18004 or 18001")
    a.add_argument("--tag", required=True)
    a.add_argument("--apply", action="store_true")
    a.add_argument("--allow-wide", action="store_true", help="allow a CIDR that is not a single host (/32)")
    r = sub.add_parser("remove")
    r.add_argument("--tag", required=True)
    r.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    cfg, net, compute, comp, vcn, sl = load()
    if args.cmd == "show":
        show(net, compute, comp, vcn, sl)
        return

    current = list(sl.ingress_security_rules)
    before_keys = {rule_key(x) for x in current}

    if args.cmd == "add":
        if not args.cidr.endswith("/32") and not args.allow_wide:
            sys.exit("refusing: CIDR is not a single host (/32). Use --allow-wide only if you really mean it.")
        if any((x.description or "") == args.tag for x in current):
            sys.exit(f"a rule tagged {args.tag!r} already exists; remove it first")
        lo, _, hi = args.ports.partition("-")
        lo, hi = int(lo), int(hi or lo)
        if not (1024 <= lo <= hi <= 65535):
            sys.exit("ports must be between 1024 and 65535")
        new = oci.core.models.IngressSecurityRule(
            protocol="6", source=args.cidr, source_type="CIDR_BLOCK", is_stateless=False, description=args.tag,
            tcp_options=oci.core.models.TcpOptions(destination_port_range=oci.core.models.PortRange(min=lo, max=hi)))
        changed = current + [new]
        added, removed = {rule_key(new)}, set()
        print("WILL ADD:", describe(new))
    else:
        keep = [x for x in current if (x.description or "") != args.tag]
        gone = [x for x in current if (x.description or "") == args.tag]
        if not gone:
            sys.exit(f"no rule tagged {args.tag!r}: nothing to remove")
        changed = keep
        added, removed = set(), {rule_key(x) for x in gone}
        for x in gone:
            print("WILL REMOVE:", describe(x))

    print(f"rules before: {len(current)}, after: {len(changed)}. All other rules are kept exactly as they are:")
    for x in current:
        print("   keep" if x in changed else "   DROP", describe(x))
    if not args.apply:
        print("\nDRY RUN: nothing written. Add --apply to do it.")
        return
    print("backup written:", backup(sl))
    apply_change(net, sl, changed, before_keys, added, removed)


if __name__ == "__main__":
    main()
