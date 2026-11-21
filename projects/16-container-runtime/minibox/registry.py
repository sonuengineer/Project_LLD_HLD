"""Pull an image from an OCI / Docker registry with the stdlib only (urllib, json, hashlib, tarfile).

    1. GET /v2/<repo>/manifests/<tag>        401 + 'WWW-Authenticate: Bearer realm=..,service=..,scope=..'
    2. GET <realm>?service=..&scope=..       anonymous token (Docker Hub allows this for public images)
    3. GET the manifest again with the token; if it is an INDEX (multi-arch list), pick the entry for
       our platform and GET that manifest by its digest
    4. GET the config blob and every layer blob into blobs/sha256/<hex>
    5. VERIFY: every manifest fetched by digest, the config and every layer must hash to the digest
       that references it; every uncompressed layer must hash to the config's rootfs.diff_ids
    6. only then apply the layers, in order, into <dest>/rootfs (image.apply_layer, with whiteouts)

Nothing is applied until everything is verified, so a bad blob leaves no half-built rootfs.
The HTTP part is injectable (`fetch`), so the unit tests run the whole flow on fixture blobs.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

from . import image

DOCKER_HUB = "registry-1.docker.io"
INDEX_TYPES = ("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json")
MANIFEST_TYPES = ("application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json")
ACCEPT = ", ".join(INDEX_TYPES + MANIFEST_TYPES)
GZIP_LAYER_TYPES = ("application/vnd.oci.image.layer.v1.tar+gzip",
                    "application/vnd.docker.image.rootfs.diff.tar.gzip")
PLAIN_LAYER_TYPES = ("application/vnd.oci.image.layer.v1.tar",)
MAX_MANIFEST_BYTES = 4 << 20


class RegistryError(Exception):
    pass


@dataclass(frozen=True)
class Reference:
    registry: str
    repository: str
    tag: str | None
    digest: str | None

    @property
    def ref(self) -> str:
        return self.digest or self.tag or "latest"


def parse_reference(text: str) -> Reference:
    """'alpine:3.20' -> registry-1.docker.io, library/alpine, 3.20. Also host/repo:tag and repo@sha256:..."""
    digest = None
    if "@" in text:
        text, digest = text.split("@", 1)
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError(f"bad digest {digest!r}")
    first, sep, rest = text.partition("/")
    if sep and ("." in first or ":" in first or first == "localhost"):
        registry, path = first, rest
    else:
        registry, path = DOCKER_HUB, text
    tag = None
    if ":" in path.rsplit("/", 1)[-1]:
        path, tag = path.rsplit(":", 1)
    if registry == DOCKER_HUB and "/" not in path:
        path = "library/" + path                # official images live under library/
    if not re.fullmatch(r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*", path):
        raise ValueError(f"bad repository name {path!r}")
    if tag is not None and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", tag):
        raise ValueError(f"bad tag {tag!r}")
    if tag is None and digest is None:
        tag = "latest"
    return Reference(registry, path, tag, digest)


def parse_www_authenticate(header: str) -> dict[str, str]:
    """'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="..."' -> dict."""
    scheme, _, params = header.strip().partition(" ")
    if scheme.lower() != "bearer":
        raise RegistryError(f"unsupported auth scheme {scheme!r}")
    out = dict(re.findall(r'(\w+)="([^"]*)"', params))
    if "realm" not in out:
        raise RegistryError("WWW-Authenticate without realm")
    return out


def host_platform() -> tuple[str, str, str | None]:
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(machine, machine)
    return "linux", arch, ("v8" if arch == "arm64" else None)


def select_platform(index: dict, os_name: str, arch: str, variant: str | None = None) -> dict:
    """Pick the manifest descriptor for our platform from an image index. A variant in the index
    must match ours if both are given (arm64 is published as variant v8, sometimes with none)."""
    candidates = []
    for d in index.get("manifests", []):
        p = d.get("platform", {})
        if p.get("os") != os_name or p.get("architecture") != arch:
            continue
        if variant and p.get("variant") and p.get("variant") != variant:
            continue
        candidates.append(d)
    if not candidates:
        have = [f"{d.get('platform', {}).get('os')}/{d.get('platform', {}).get('architecture')}"
                for d in index.get("manifests", [])]
        raise RegistryError(f"no manifest for {os_name}/{arch} in index (have: {', '.join(have)})")
    return candidates[0]


@dataclass
class Fetched:
    status: int
    headers: dict[str, str]       # lower-case names
    body: bytes = b""


Fetch = Callable[[str, dict[str, str], str | None], Fetched]
"""fetch(url, headers, save_to) -> Fetched. With save_to, the body is streamed to that file."""


def urllib_fetch(url: str, headers: dict[str, str], save_to: str | None = None) -> Fetched:
    req = urllib.request.Request(url)
    for k, v in headers.items():
        if k.lower() == "authorization":
            # Blob GETs answer with a redirect to a CDN. An 'unredirected' header is NOT copied to
            # the redirected request, so our registry token is never sent to a third-party host.
            req.add_unredirected_header(k, v)
        else:
            req.add_header(k, v)
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as e:
        return Fetched(e.code, {k.lower(): v for k, v in e.headers.items()}, e.read(MAX_MANIFEST_BYTES))
    with resp:
        hdrs = {k.lower(): v for k, v in resp.headers.items()}
        if save_to:
            with open(save_to, "wb") as f:
                shutil.copyfileobj(resp, f, image.CHUNK)
            return Fetched(resp.status, hdrs)
        return Fetched(resp.status, hdrs, resp.read(MAX_MANIFEST_BYTES + 1))


class Registry:
    def __init__(self, ref: Reference, fetch: Fetch = urllib_fetch, log: Callable[[str], None] = lambda s: None):
        self.ref = ref
        self.fetch = fetch
        self.log = log
        self.token: str | None = None
        self.base = f"https://{ref.registry}/v2/{ref.repository}"

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        h = dict(extra or {})
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def _authenticate(self, challenge: str) -> None:
        params = parse_www_authenticate(challenge)
        query = {k: v for k, v in params.items() if k in ("service", "scope")}
        query.setdefault("scope", f"repository:{self.ref.repository}:pull")
        url = params["realm"] + "?" + urllib.parse.urlencode(query)
        r = self.fetch(url, {}, None)
        if r.status != 200:
            raise RegistryError(f"token request failed: HTTP {r.status}")
        body = json.loads(r.body)
        self.token = body.get("token") or body.get("access_token")
        if not self.token:
            raise RegistryError("token response without a token")

    def get(self, url: str, accept: str | None = None, save_to: str | None = None) -> Fetched:
        extra = {"Accept": accept} if accept else {}
        r = self.fetch(url, self._headers(extra), save_to)
        if r.status == 401 and "www-authenticate" in r.headers and self.token is None:
            self._authenticate(r.headers["www-authenticate"])
            r = self.fetch(url, self._headers(extra), save_to)
        if r.status != 200:
            raise RegistryError(f"GET {url}: HTTP {r.status}")
        return r

    def manifest(self, ref: str) -> tuple[dict, str, str]:
        """Returns (parsed manifest, media type, sha256 of the exact bytes)."""
        r = self.get(f"{self.base}/manifests/{ref}", accept=ACCEPT)
        if len(r.body) > MAX_MANIFEST_BYTES:
            raise RegistryError("manifest too large")
        digest = image.sha256_bytes(r.body)
        if ref.startswith("sha256:"):
            image.check_digest(digest, ref, "manifest")   # content addressed: the bytes ARE the name
        elif "docker-content-digest" in r.headers:
            # a TAG is a mutable name, so there is nothing to check against except what the registry
            # itself claims; checking that still catches a corrupted or truncated body
            image.check_digest(digest, r.headers["docker-content-digest"], "manifest (Docker-Content-Digest)")
        doc = json.loads(r.body)
        media = doc.get("mediaType") or r.headers.get("content-type", "").split(";")[0]
        return doc, media, digest

    def blob(self, digest: str, dest_dir: str) -> str:
        path = os.path.join(dest_dir, digest.split(":", 1)[1])
        if not os.path.exists(path):
            tmp = path + ".part"
            self.get(f"{self.base}/blobs/{digest}", save_to=tmp)
            os.replace(tmp, path)
        return path


def _verify_blob(path: str, expected: str, what: str, gunzip: bool = False) -> None:
    try:
        image.check_digest(image.sha256_file(path, gunzip=gunzip), expected, what)
    except image.DigestMismatch:
        os.unlink(path)            # never keep (and later reuse) a blob that failed its check
        raise


def pull(reference: str, dest: str, fetch: Fetch = urllib_fetch, platform_: tuple[str, str, str | None] | None = None,
         log: Callable[[str], None] = print) -> dict:
    """Pull `reference` into dest/rootfs. Also writes dest/manifest.json, dest/config.json and
    keeps the verified blobs in dest/blobs/sha256/. Returns a summary dict."""
    ref = parse_reference(reference)
    reg = Registry(ref, fetch, log)
    os_name, arch, variant = platform_ or host_platform()

    doc, media, mdigest = reg.manifest(ref.ref)
    index_digest = None
    if media in INDEX_TYPES or "manifests" in doc:
        index_digest = mdigest
        chosen = select_platform(doc, os_name, arch, variant)
        log(f"index {mdigest[:19]}: picked {os_name}/{arch} -> {chosen['digest'][:19]}")
        doc, media, mdigest = reg.manifest(chosen["digest"])
    if media not in MANIFEST_TYPES:
        raise RegistryError(f"unsupported manifest media type {media!r}")

    blobs = os.path.join(dest, "blobs", "sha256")
    os.makedirs(blobs, exist_ok=True)

    cfg_desc = doc["config"]
    cfg_path = reg.blob(cfg_desc["digest"], blobs)
    _verify_blob(cfg_path, cfg_desc["digest"], "config")
    with open(cfg_path, "rb") as f:
        config = json.loads(f.read())
    diff_ids = config.get("rootfs", {}).get("diff_ids", [])
    if len(diff_ids) != len(doc["layers"]):
        raise RegistryError(f"{len(doc['layers'])} layers but {len(diff_ids)} diff_ids in the config")

    layer_paths = []
    total = 0
    for i, (layer, diff_id) in enumerate(zip(doc["layers"], diff_ids)):
        lt = layer.get("mediaType", "")
        if lt not in GZIP_LAYER_TYPES + PLAIN_LAYER_TYPES:
            raise RegistryError(f"layer {i}: unsupported media type {lt!r} (only tar and tar+gzip)")
        p = reg.blob(layer["digest"], blobs)
        size = os.path.getsize(p)
        _verify_blob(p, layer["digest"], f"layer {i}")
        if "size" in layer and layer["size"] != size:
            raise image.DigestMismatch(f"layer {i}: size {size} != manifest size {layer['size']}")
        _verify_blob(p, diff_id, f"layer {i} diff_id", gunzip=lt in GZIP_LAYER_TYPES)
        log(f"layer {i}: {layer['digest'][:19]} {size} bytes verified")
        layer_paths.append(p)
        total += size

    rootfs = os.path.join(dest, "rootfs")
    if os.path.exists(rootfs):
        shutil.rmtree(rootfs)
    os.makedirs(rootfs)
    counts = [image.apply_layer(p, rootfs) for p in layer_paths]
    with open(os.path.join(dest, "manifest.json"), "w") as f:
        json.dump(doc, f, indent=1)
    shutil.copyfile(cfg_path, os.path.join(dest, "config.json"))
    summary = {"reference": reference, "index_digest": index_digest, "manifest_digest": mdigest,
               "platform": f"{os_name}/{arch}", "layers": len(layer_paths), "compressed_bytes": total,
               "apply": counts}
    log(json.dumps(summary))
    return summary

