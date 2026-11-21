"""Build small fixture layer tarballs in memory (no network, no root)."""
from __future__ import annotations

import gzip
import hashlib
import io
import tarfile


def make_tar(entries: list[tuple], gz: bool = False) -> bytes:
    """entries: ("dir", name) | ("file", name, content) | ("symlink", name, target)"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        for e in entries:
            kind, name = e[0], e[1]
            ti = tarfile.TarInfo(name)
            ti.mtime = 1_700_000_000
            if kind == "dir":
                ti.type, ti.mode = tarfile.DIRTYPE, 0o755
                tf.addfile(ti)
            elif kind == "file":
                data = e[2].encode() if isinstance(e[2], str) else e[2]
                ti.size, ti.mode = len(data), (e[3] if len(e) > 3 else 0o644)
                tf.addfile(ti, io.BytesIO(data))
            elif kind == "symlink":
                ti.type, ti.linkname = tarfile.SYMTYPE, e[2]
                tf.addfile(ti)
            else:
                raise ValueError(kind)
    raw = buf.getvalue()
    return gzip.compress(raw, mtime=0) if gz else raw


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()
