import json
import os

import pytest

from minibox import registry
from minibox.image import DigestMismatch
from minibox.registry import Fetched, RegistryError, parse_reference, parse_www_authenticate, select_platform

from .layers import digest, make_tar

GZ = "application/vnd.oci.image.layer.v1.tar+gzip"


# ---- references and auth -------------------------------------------------------------------------

@pytest.mark.parametrize("text,reg,repo,tag,dig", [
    ("alpine", "registry-1.docker.io", "library/alpine", "latest", None),
    ("alpine:3.20", "registry-1.docker.io", "library/alpine", "3.20", None),
    ("library/busybox:1.36", "registry-1.docker.io", "library/busybox", "1.36", None),
    ("someuser/app:v1", "registry-1.docker.io", "someuser/app", "v1", None),
    ("ghcr.io/owner/repo:tag", "ghcr.io", "owner/repo", "tag", None),
    ("localhost:5000/x", "localhost:5000", "x", "latest", None),
    ("alpine@sha256:" + "a" * 64, "registry-1.docker.io", "library/alpine", None, "sha256:" + "a" * 64),
])
def test_parse_reference(text, reg, repo, tag, dig):
    r = parse_reference(text)
    assert (r.registry, r.repository, r.tag, r.digest) == (reg, repo, tag, dig)


@pytest.mark.parametrize("text", ["Alpine", "alpine@sha256:xyz", "a/../b", "alpine:bad tag", ""])
def test_parse_reference_rejects(text):
    with pytest.raises(ValueError):
        parse_reference(text)


def test_parse_www_authenticate():
    h = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"'
    assert parse_www_authenticate(h) == {"realm": "https://auth.docker.io/token", "service": "registry.docker.io",
                                         "scope": "repository:library/alpine:pull"}
    with pytest.raises(RegistryError):
        parse_www_authenticate('Basic realm="x"')
    with pytest.raises(RegistryError):
        parse_www_authenticate('Bearer service="x"')


INDEX = {"mediaType": registry.INDEX_TYPES[0], "manifests": [
    {"digest": "sha256:" + "1" * 64, "platform": {"os": "linux", "architecture": "amd64"}},
    {"digest": "sha256:" + "2" * 64, "platform": {"os": "linux", "architecture": "arm", "variant": "v7"}},
    {"digest": "sha256:" + "3" * 64, "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
    {"digest": "sha256:" + "4" * 64, "platform": {"os": "unknown", "architecture": "unknown"}},
]}


def test_select_platform():
    assert select_platform(INDEX, "linux", "arm64", "v8")["digest"] == "sha256:" + "3" * 64
    assert select_platform(INDEX, "linux", "arm64", None)["digest"] == "sha256:" + "3" * 64
    assert select_platform(INDEX, "linux", "amd64")["digest"] == "sha256:" + "1" * 64
    with pytest.raises(RegistryError, match="linux/riscv64"):
        select_platform(INDEX, "linux", "riscv64")
    with pytest.raises(RegistryError):
        select_platform(INDEX, "linux", "arm", "v6")


# ---- a fake registry -----------------------------------------------------------------------------

class FakeRegistry:
    """Serves /v2/... like Docker Hub: 401 with a Bearer challenge until a token is sent."""

    def __init__(self, layers: list[bytes], tamper: str | None = None, use_index: bool = True):
        self.blobs: dict[str, bytes] = {}
        self.calls: list[tuple[str, dict]] = []
        descs, diff_ids = [], []
        import gzip
        for raw_gz in layers:
            d = digest(raw_gz)
            self.blobs[d] = raw_gz
            descs.append({"mediaType": GZ, "digest": d, "size": len(raw_gz)})
            diff_ids.append(digest(gzip.decompress(raw_gz)))
        config = json.dumps({"architecture": "arm64", "os": "linux",
                             "rootfs": {"type": "layers", "diff_ids": diff_ids}}).encode()
        self.blobs[digest(config)] = config
        manifest = json.dumps({"schemaVersion": 2, "mediaType": registry.MANIFEST_TYPES[0],
                               "config": {"mediaType": "application/vnd.oci.image.config.v1+json",
                                          "digest": digest(config), "size": len(config)},
                               "layers": descs}).encode()
        self.manifests = {digest(manifest): manifest}
        index = json.dumps({"schemaVersion": 2, "mediaType": registry.INDEX_TYPES[0], "manifests": [
            {"digest": "sha256:" + "9" * 64, "platform": {"os": "linux", "architecture": "amd64"}},
            {"digest": digest(manifest), "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
        ]}).encode()
        self.manifests["3.20"] = index if use_index else manifest
        if tamper == "layer":
            first = descs[0]["digest"]
            self.blobs[first] = self.blobs[first][:-1] + bytes([self.blobs[first][-1] ^ 1])
        elif tamper == "config":
            self.blobs[digest(config)] = config.replace(b"arm64", b"amd64")
        elif tamper == "manifest":
            self.manifests[digest(manifest)] = manifest.replace(b'"schemaVersion": 2', b'"schemaVersion":  2')

    def __call__(self, url, headers, save_to):
        self.calls.append((url, dict(headers)))
        if url.startswith("https://auth.docker.io/token"):
            assert "scope=repository%3Alibrary%2Falpine%3Apull" in url
            return Fetched(200, {}, json.dumps({"token": "T0K"}).encode())
        if headers.get("Authorization") != "Bearer T0K":
            return Fetched(401, {"www-authenticate": 'Bearer realm="https://auth.docker.io/token",'
                                                     'service="registry.docker.io",'
                                                     'scope="repository:library/alpine:pull"'})
        prefix = "https://registry-1.docker.io/v2/library/alpine/"
        assert url.startswith(prefix), url
        kind, _, ref = url[len(prefix):].partition("/")
        if kind == "manifests":
            body = self.manifests.get(ref)
            if body is None:
                return Fetched(404, {})
            return Fetched(200, {"content-type": json.loads(body)["mediaType"]}, body)
        body = self.blobs.get(ref)
        if body is None:
            return Fetched(404, {})
        with open(save_to, "wb") as f:
            f.write(body)
        return Fetched(200, {})


def two_layers():
    l0 = make_tar([("dir", "etc"), ("file", "etc/motd", "hi"), ("file", "etc/issue", "alpine"),
                   ("dir", "var"), ("file", "var/a", "1")], gz=True)
    l1 = make_tar([("file", "etc/.wh.motd", ""), ("file", "etc/new", "n"),
                   ("dir", "var"), ("file", "var/.wh..wh..opq", ""), ("file", "var/b", "2")], gz=True)
    return [l0, l1]


ARM = ("linux", "arm64", "v8")


def test_pull_end_to_end_with_token_index_and_whiteouts(tmp_path):
    fake = FakeRegistry(two_layers())
    s = registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)
    root = tmp_path / "img" / "rootfs"
    assert (root / "etc" / "issue").read_text() == "alpine"
    assert (root / "etc" / "new").read_text() == "n"
    assert not (root / "etc" / "motd").exists()                 # whiteout from layer 1
    assert not (root / "var" / "a").exists()                    # opaque dir from layer 1
    assert (root / "var" / "b").read_text() == "2"
    assert s["layers"] == 2 and s["platform"] == "linux/arm64" and s["index_digest"]
    assert (tmp_path / "img" / "config.json").exists() and (tmp_path / "img" / "manifest.json").exists()
    # the token was fetched once and sent on every later request
    assert sum(1 for u, _ in fake.calls if u.startswith("https://auth.docker.io")) == 1


def test_pull_single_arch_manifest(tmp_path):
    fake = FakeRegistry(two_layers(), use_index=False)
    s = registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)
    assert s["index_digest"] is None and (tmp_path / "img" / "rootfs" / "var" / "b").exists()


@pytest.mark.parametrize("what", ["layer", "config", "manifest"])
def test_tampered_content_is_refused_and_nothing_is_applied(tmp_path, what):
    fake = FakeRegistry(two_layers(), tamper=what)
    with pytest.raises(DigestMismatch):
        registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)
    assert not (tmp_path / "img" / "rootfs").exists()


def test_failed_blob_is_deleted_not_cached(tmp_path):
    fake = FakeRegistry(two_layers(), tamper="layer")
    with pytest.raises(DigestMismatch):
        registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)
    blobs = os.listdir(tmp_path / "img" / "blobs" / "sha256")
    bad = [d for d in fake.blobs if fake.blobs[d] and digest(fake.blobs[d]) != d]
    assert bad and all(b.split(":")[1] not in blobs for b in bad)


def test_diff_id_mismatch_is_refused(tmp_path):
    fake = FakeRegistry(two_layers())
    # swap the order of diff_ids in the config: blobs still match their digests, content order does not
    cfg_digest = next(d for d, b in fake.blobs.items() if b.startswith(b"{"))
    cfg = json.loads(fake.blobs.pop(cfg_digest))
    cfg["rootfs"]["diff_ids"].reverse()
    new_cfg = json.dumps(cfg).encode()
    fake.blobs[digest(new_cfg)] = new_cfg
    for k, body in list(fake.manifests.items()):
        if cfg_digest.encode() in body and k.startswith("sha256:"):
            new_m = body.replace(cfg_digest.encode(), digest(new_cfg).encode()).replace(
                str(len(json.dumps(cfg))).encode(), str(len(new_cfg)).encode())
            del fake.manifests[k]
            fake.manifests[digest(new_m)] = new_m
            idx = json.loads(fake.manifests["3.20"])
            idx["manifests"][1]["digest"] = digest(new_m)
            fake.manifests["3.20"] = json.dumps(idx).encode()
    with pytest.raises(DigestMismatch, match="diff_id"):
        registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)


def test_wrong_platform_is_a_clear_error(tmp_path):
    fake = FakeRegistry(two_layers())
    with pytest.raises(RegistryError, match="riscv64"):
        registry.pull("alpine:3.20", str(tmp_path / "img"), fetch=fake, platform_=("linux", "riscv64", None),
                      log=lambda m: None)


def test_unknown_tag_is_an_error(tmp_path):
    fake = FakeRegistry(two_layers())
    with pytest.raises(RegistryError, match="404"):
        registry.pull("alpine:nope", str(tmp_path / "img"), fetch=fake, platform_=ARM, log=lambda m: None)


def test_authorization_header_is_not_forwarded_on_redirect():
    # urllib copies normal headers to the redirected request but not "unredirected" ones; blob
    # downloads redirect to a CDN, which must never see our registry token
    import urllib.request
    req = urllib.request.Request("https://registry.example/v2/x/blobs/sha256:" + "0" * 64)
    req.add_unredirected_header("Authorization", "Bearer secret")
    req.add_header("Accept", "*/*")
    new = urllib.request.HTTPRedirectHandler().redirect_request(req, None, 307, "Temporary Redirect", {},
                                                                "https://cdn.example/blob")
    assert new.get_header("Authorization") is None
    assert req.get_header("Authorization") == "Bearer secret"
