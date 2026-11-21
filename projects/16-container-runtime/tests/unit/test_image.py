import os
import sys

import pytest

from minibox import image
from minibox.image import DigestMismatch, UnsafePath, Whiteout, apply_layer, classify, clean_member_path

from .layers import digest, make_tar

needs_symlinks = pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")


def write(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


def tree(root):
    out = {}
    for dp, dns, fns in os.walk(root):
        for d in dns:
            out[os.path.relpath(os.path.join(dp, d), root).replace(os.sep, "/") + "/"] = None
        for f in fns:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, root).replace(os.sep, "/")] = open(p, "rb").read().decode()
    return out


# ---- digests -------------------------------------------------------------------------------------

def test_sha256_file_and_bytes_agree(tmp_path):
    p = write(tmp_path, "b", b"hello")
    assert image.sha256_file(p) == image.sha256_bytes(b"hello") == digest(b"hello")


def test_diff_id_is_digest_of_uncompressed_tar(tmp_path):
    raw = make_tar([("file", "a", "x")])
    gz = write(tmp_path, "l.tgz", make_tar([("file", "a", "x")], gz=True))
    assert image.sha256_file(gz, gunzip=True) == digest(raw)
    assert image.sha256_file(gz) != digest(raw)


def test_check_digest_ok_and_mismatch():
    d = digest(b"abc")
    image.check_digest(d, d, "x")
    with pytest.raises(DigestMismatch, match="mismatch"):
        image.check_digest(digest(b"abd"), d, "layer 0")


@pytest.mark.parametrize("bad", ["md5:abc", "sha256:short", "sha256", ""])
def test_check_digest_rejects_malformed_expected(bad):
    with pytest.raises(DigestMismatch):
        image.check_digest(digest(b"x"), bad, "x")


# ---- names and whiteouts -------------------------------------------------------------------------

@pytest.mark.parametrize("name,expected", [
    ("etc/passwd", "etc/passwd"), ("./etc/passwd", "etc/passwd"), ("/etc/passwd", "etc/passwd"),
    ("etc//x/./y", "etc/x/y"), ("./", ""), ("bin/", "bin"),
])
def test_clean_member_path(name, expected):
    assert clean_member_path(name) == expected


@pytest.mark.parametrize("name", ["../x", "etc/../../x", "a/..", "./../etc"])
def test_clean_member_path_rejects_dotdot(name):
    with pytest.raises(UnsafePath):
        clean_member_path(name)


def test_classify():
    assert classify("etc/.wh.motd") == Whiteout("file", "etc/motd")
    assert classify(".wh.top") == Whiteout("file", "top")
    assert classify("var/cache/.wh..wh..opq") == Whiteout("opaque", "var/cache")
    assert classify("etc/motd") is None
    assert classify("etc/x.wh.y") is None
    with pytest.raises(UnsafePath):
        classify("etc/.wh.")
    with pytest.raises(UnsafePath):
        classify("etc/.wh...")


# ---- applying layers -----------------------------------------------------------------------------

def base_layer(tmp_path):
    return write(tmp_path, "l0.tar", make_tar([
        ("dir", "etc"), ("file", "etc/motd", "hello"), ("file", "etc/hosts", "h"),
        ("dir", "var"), ("dir", "var/cache"), ("file", "var/cache/a", "1"), ("file", "var/cache/b", "2"),
        ("dir", "tmp"),
    ]))


def test_single_layer(tmp_path):
    root = tmp_path / "rootfs"
    counts = apply_layer(base_layer(tmp_path), str(root))
    assert tree(root)["etc/motd"] == "hello"
    assert counts == {"whiteouts": 0, "opaque": 0, "entries": 8}


def test_gzip_layer(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(write(tmp_path, "l.tgz", make_tar([("file", "x", "gz")], gz=True)), str(root))
    assert tree(root) == {"x": "gz"}


def test_whiteout_deletes_lower_file(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    counts = apply_layer(write(tmp_path, "l1.tar", make_tar([("dir", "etc"), ("file", "etc/.wh.motd", "")])), str(root))
    t = tree(root)
    assert "etc/motd" not in t and "etc/.wh.motd" not in t and t["etc/hosts"] == "h"
    assert counts["whiteouts"] == 1


def test_whiteout_deletes_lower_directory_recursively(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    apply_layer(write(tmp_path, "l1.tar", make_tar([("file", ".wh.var", "")])), str(root))
    assert not any(k.startswith("var") for k in tree(root))


def test_opaque_dir_hides_lower_children_but_keeps_this_layers_files(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    apply_layer(write(tmp_path, "l1.tar", make_tar([
        ("dir", "var/cache"), ("file", "var/cache/new", "3"), ("file", "var/cache/.wh..wh..opq", ""),
    ])), str(root))
    t = tree(root)
    # the opaque marker comes AFTER 'new' in the tar, and must still not delete it
    assert t["var/cache/new"] == "3"
    assert "var/cache/a" not in t and "var/cache/b" not in t and "var/cache/.wh..wh..opq" not in t


def test_whiteout_does_not_hide_a_file_of_the_same_layer(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    # spec: a whiteout only applies to LOWER layers; the re-added file in this layer survives
    apply_layer(write(tmp_path, "l1.tar", make_tar([("file", "etc/motd", "new"), ("file", "etc/.wh.motd", "")])),
                str(root))
    assert tree(root)["etc/motd"] == "new"


def test_whiteout_of_missing_file_is_harmless(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    apply_layer(write(tmp_path, "l1.tar", make_tar([("file", "etc/.wh.nothere", "")])), str(root))
    assert tree(root)["etc/motd"] == "hello"


def test_upper_layer_replaces_file_with_directory_and_back(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    apply_layer(write(tmp_path, "l1.tar", make_tar([("dir", "etc/motd"), ("file", "etc/motd/x", "d")])), str(root))
    assert tree(root)["etc/motd/x"] == "d"
    apply_layer(write(tmp_path, "l2.tar", make_tar([("file", "etc/motd", "f")])), str(root))
    assert tree(root)["etc/motd"] == "f"


def test_upper_layer_overwrites_file(tmp_path):
    root = tmp_path / "rootfs"
    apply_layer(base_layer(tmp_path), str(root))
    apply_layer(write(tmp_path, "l1.tar", make_tar([("file", "etc/hosts", "changed")])), str(root))
    assert tree(root)["etc/hosts"] == "changed"


def test_dotdot_member_is_refused(tmp_path):
    root = tmp_path / "rootfs"
    with pytest.raises(UnsafePath):
        apply_layer(write(tmp_path, "evil.tar", make_tar([("file", "../evil", "x")])), str(root))
    assert not (tmp_path / "evil").exists()


def test_dotdot_whiteout_is_refused(tmp_path):
    (tmp_path / "victim").write_text("keep me")
    root = tmp_path / "rootfs"
    with pytest.raises(UnsafePath):
        apply_layer(write(tmp_path, "evil.tar", make_tar([("file", "../.wh.victim", "")])), str(root))
    assert (tmp_path / "victim").read_text() == "keep me"


@needs_symlinks
def test_symlink_in_layer_cannot_redirect_a_later_file_outside(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "rootfs"
    apply_layer(write(tmp_path, "l0.tar", make_tar([("symlink", "link", str(outside))])), str(root))
    with pytest.raises(UnsafePath):
        apply_layer(write(tmp_path, "l1.tar", make_tar([("file", "link/pwned", "x")])), str(root))
    assert not (outside / "pwned").exists()


@needs_symlinks
def test_whiteout_through_symlink_outside_is_refused(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "victim").write_text("keep")
    root = tmp_path / "rootfs"
    apply_layer(write(tmp_path, "l0.tar", make_tar([("symlink", "link", str(outside))])), str(root))
    with pytest.raises(UnsafePath):
        apply_layer(write(tmp_path, "l1.tar", make_tar([("file", "link/.wh.victim", "")])), str(root))
    assert (outside / "victim").exists()


@needs_symlinks
def test_absolute_symlinks_are_kept_as_is(tmp_path):
    # images are full of them (bin/sh -> /bin/busybox); they are resolved INSIDE the container later
    root = tmp_path / "rootfs"
    apply_layer(write(tmp_path, "l0.tar", make_tar([("dir", "bin"), ("symlink", "bin/sh", "/bin/busybox")])), str(root))
    assert os.readlink(root / "bin" / "sh") == "/bin/busybox"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX modes")
def test_sticky_and_world_writable_modes_survive(tmp_path):
    # tarfile's own 'tar' filter would turn a 1777 /tmp into 0755; we keep the image's mode
    import stat
    import tarfile, io
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        ti = tarfile.TarInfo("tmp")
        ti.type, ti.mode = tarfile.DIRTYPE, 0o1777
        tf.addfile(ti)
    root = tmp_path / "rootfs"
    apply_layer(write(tmp_path, "l.tar", buf.getvalue()), str(root))
    assert stat.S_IMODE(os.stat(root / "tmp").st_mode) == 0o1777
