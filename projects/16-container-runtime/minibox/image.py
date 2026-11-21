"""Image layers: digest checks and applying layer tarballs (with OCI whiteouts) into one rootfs dir.

A layer is a tar of the files it adds or changes. Deletions are recorded as WHITEOUT entries:

    dir/.wh.name        'name' existed in a lower layer and is deleted by this layer
    dir/.wh..wh..opq    OPAQUE dir: everything 'dir' contained in LOWER layers is deleted

Per the OCI image spec a whiteout only hides content from LOWER layers, never files that the same
layer adds. So each layer is applied in two passes: first all its whiteouts (against what the lower
layers built), then its regular entries.

minibox flattens all layers into one directory, which then becomes the overlay's read-only lowerdir.
"""
from __future__ import annotations

import gzip
import hashlib
import os
import posixpath
import shutil
import tarfile
from dataclasses import dataclass

WH_PREFIX = ".wh."
WH_OPAQUE = ".wh..wh..opq"
CHUNK = 1 << 20


class DigestMismatch(Exception):
    pass


class UnsafePath(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_file(path: str, gunzip: bool = False) -> str:
    """Digest of a file; gunzip=True hashes the DECOMPRESSED stream (an OCI 'diff_id')."""
    h = hashlib.sha256()
    opener = gzip.open if gunzip else open
    with opener(path, "rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def check_digest(actual: str, expected: str, what: str) -> None:
    algo, _, hexpart = expected.partition(":")
    if algo != "sha256" or len(hexpart) != 64:
        raise DigestMismatch(f"{what}: unsupported or malformed digest {expected!r}")
    if actual != expected:
        raise DigestMismatch(f"{what}: digest mismatch: expected {expected}, got {actual}")


def clean_member_path(name: str) -> str:
    """Tar member name -> safe relative POSIX path. Rejects '..' and anything that normalises
    to the root itself; strips a leading './' or '/' (layer tars use both styles)."""
    p = name.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    p = p.lstrip("/")
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if any(x == ".." for x in parts):
        raise UnsafePath(f"tar member escapes the rootfs: {name!r}")
    return "/".join(parts)


@dataclass(frozen=True)
class Whiteout:
    kind: str       # 'file' (delete one entry) or 'opaque' (empty a directory)
    target: str     # relative path of the entry to delete, or of the directory to empty


def classify(rel: str) -> Whiteout | None:
    parent, base = posixpath.split(rel)
    if base == WH_OPAQUE:
        return Whiteout("opaque", parent)
    if base.startswith(WH_PREFIX):
        name = base[len(WH_PREFIX):]
        if not name or name in (".", ".."):
            raise UnsafePath(f"bad whiteout {rel!r}")
        return Whiteout("file", posixpath.join(parent, name))
    return None


def _inside(root: str, rel: str) -> str:
    """root/rel, refusing it if a symlink in rel's PARENT directories points outside root."""
    path = os.path.join(root, *rel.split("/")) if rel else root
    parent = os.path.realpath(os.path.dirname(path))
    real_root = os.path.realpath(root)
    if parent != real_root and not parent.startswith(real_root + os.sep):
        raise UnsafePath(f"{rel!r} resolves outside the rootfs (through a symlink)")
    return path


def _remove(path: str) -> None:
    if os.path.islink(path) or not os.path.isdir(path):
        if os.path.lexists(path):
            os.unlink(path)
    else:
        shutil.rmtree(path)


def apply_whiteout(root: str, wh: Whiteout) -> None:
    path = _inside(root, wh.target)
    if wh.kind == "file":
        _remove(path)
    elif os.path.isdir(path) and not os.path.islink(path):
        for entry in os.listdir(path):
            _remove(os.path.join(path, entry))


def _keep_mode(member: tarfile.TarInfo, dest: str) -> tarfile.TarInfo:
    # tarfile's 'tar' filter refuses absolute names and paths that leave dest through symlinks
    # (what we want), but it also clears setuid/sticky and group/other write bits, which would
    # turn the image's 1777 /tmp into 0755. Keep its checks, restore the image's real mode.
    checked = tarfile.tar_filter(member, dest)
    return checked.replace(mode=member.mode, deep=False)


def apply_layer(tar_path: str, root: str) -> dict:
    """Apply one layer (plain or gzip tar) on top of root. Returns counts for logs and tests."""
    os.makedirs(root, exist_ok=True)
    counts = {"whiteouts": 0, "opaque": 0, "entries": 0}
    with tarfile.open(tar_path, "r:*") as tf:
        members = tf.getmembers()
        regular = []
        for m in members:
            rel = clean_member_path(m.name)
            wh = classify(rel)
            if wh is None:
                if rel:
                    regular.append((rel, m))
                continue
            apply_whiteout(root, wh)
            counts["whiteouts" if wh.kind == "file" else "opaque"] += 1
        for rel, m in regular:
            path = _inside(root, rel)
            # A layer may replace a dir with a file or the other way round; tarfile won't.
            if os.path.lexists(path) and not (m.isdir() and os.path.isdir(path) and not os.path.islink(path)):
                _remove(path)
            m.name = rel
            if m.islnk():
                m.linkname = clean_member_path(m.linkname)
            tf.extract(m, root, numeric_owner=True, filter=_keep_mode)
            counts["entries"] += 1
    return counts
