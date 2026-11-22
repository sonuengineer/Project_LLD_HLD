from __future__ import annotations

import ipaddress

import pytest

from minibox import network

I = ipaddress.IPv4Interface


def test_first_subnet_when_nothing_is_used():
    assert network.pick_subnet([I("127.0.0.1/8"), I("10.0.0.5/24")]) == ipaddress.IPv4Network("10.200.0.0/30")


def test_skips_subnets_already_used_on_the_host():
    used = [I("10.200.0.1/30"), I("10.200.0.5/30")]
    assert network.pick_subnet(used) == ipaddress.IPv4Network("10.200.0.8/30")


def test_a_wider_host_network_inside_the_pool_blocks_every_subnet_it_covers():
    assert network.pick_subnet([I("10.200.0.9/24")]) == ipaddress.IPv4Network("10.200.1.0/30")


def test_refuses_when_the_host_network_covers_the_whole_pool():
    with pytest.raises(RuntimeError):
        network.pick_subnet([I("10.1.2.3/8")])


def test_refuses_when_the_pool_is_full():
    pool = ipaddress.IPv4Network("10.200.0.0/29")
    with pytest.raises(RuntimeError):
        network.pick_subnet([I("10.200.0.1/30"), I("10.200.0.5/30")], pool)


def test_link_addresses_and_names():
    link = network.VethLink("mbx00000000", ipaddress.IPv4Network("10.200.0.4/30"))
    assert str(link.host_ip) == "10.200.0.5/30" and str(link.container_ip) == "10.200.0.6/30"
    assert link.as_dict()["container_if"] == "eth0"
    name = network.new_host_ifname()
    assert name.startswith("mbx") and len(name) <= 15
