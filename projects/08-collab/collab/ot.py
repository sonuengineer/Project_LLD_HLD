"""Operational Transformation for plain text (the ot.js / Google-Wave TextOperation model).

An operation is a list of components walked left to right over the document:
    int > 0   retain n characters (skip over them)
    str       insert this text
    int < 0   delete -n characters
It must cover the WHOLE document: base_length = length it applies to, target_length = length after.

Core functions:
    apply(doc, op)            -> new doc
    compose(a, b)             -> one op equivalent to a then b
    transform(a, b)           -> (a', b') with apply(apply(S, a), b') == apply(apply(S, b), a')
                                 ("TP1"). When both insert at the same spot, a's insert goes first.
    transform_index(op, i)    -> where cursor i moves after op

Why OT works here with a central server: the server totally orders operations (revisions), so only TP1
is needed. Peer-to-peer OT without a central order also needs TP2, which is notoriously hard -- that's
where CRDTs are usually preferred.
"""
from __future__ import annotations

from typing import Iterator, Union

Component = Union[int, str]


class OTError(ValueError):
    pass


def is_retain(c) -> bool:
    return isinstance(c, int) and c > 0


def is_insert(c) -> bool:
    return isinstance(c, str)


def is_delete(c) -> bool:
    return isinstance(c, int) and c < 0


class TextOp:
    __slots__ = ("ops", "base_length", "target_length")

    def __init__(self, ops: list[Component] | None = None):
        self.ops: list[Component] = []
        self.base_length = 0
        self.target_length = 0
        for c in ops or []:
            if is_retain(c):
                self.retain(c)
            elif is_insert(c):
                self.insert(c)
            elif is_delete(c):
                self.delete(-c)
            else:
                raise OTError(f"invalid component {c!r}")

    # ---- builders (normalising: adjacent components merge; insert is placed before delete) ----------
    def retain(self, n: int) -> "TextOp":
        if n == 0:
            return self
        if n < 0:
            raise OTError("retain expects a positive integer")
        self.base_length += n
        self.target_length += n
        if self.ops and is_retain(self.ops[-1]):
            self.ops[-1] += n
        else:
            self.ops.append(n)
        return self

    def insert(self, s: str) -> "TextOp":
        if not s:
            return self
        self.target_length += len(s)
        ops = self.ops
        if ops and is_insert(ops[-1]):
            ops[-1] += s
        elif ops and is_delete(ops[-1]):
            # Canonical form: insert before delete (insert+delete == delete+insert at the same spot).
            if len(ops) > 1 and is_insert(ops[-2]):
                ops[-2] += s
            else:
                ops.append(ops[-1])
                ops[-2] = s
        else:
            ops.append(s)
        return self

    def delete(self, n: int) -> "TextOp":
        if n == 0:
            return self
        if n < 0:
            raise OTError("delete expects a positive integer")
        self.base_length += n
        if self.ops and is_delete(self.ops[-1]):
            self.ops[-1] -= n
        else:
            self.ops.append(-n)
        return self

    # ---- misc ---------------------------------------------------------------------------------------
    def is_noop(self) -> bool:
        return not self.ops or (len(self.ops) == 1 and is_retain(self.ops[0]))

    def to_json(self) -> list[Component]:
        return list(self.ops)

    @classmethod
    def from_json(cls, data) -> "TextOp":
        if not isinstance(data, list):
            raise OTError("operation must be a list")
        return cls(data)

    def __eq__(self, other) -> bool:
        return isinstance(other, TextOp) and self.ops == other.ops

    def __repr__(self) -> str:
        return f"TextOp({self.ops!r})"


def _iter(op: TextOp) -> Iterator[Component | None]:
    yield from op.ops
    while True:
        yield None


def apply(doc: str, op: TextOp) -> str:
    if len(doc) != op.base_length:
        raise OTError(f"operation base length {op.base_length} != document length {len(doc)}")
    out, i = [], 0
    for c in op.ops:
        if is_retain(c):
            out.append(doc[i:i + c])
            i += c
        elif is_insert(c):
            out.append(c)
        else:
            i -= c
    return "".join(out)


def compose(a: TextOp, b: TextOp) -> TextOp:
    if a.target_length != b.base_length:
        raise OTError("compose: a.target_length must equal b.base_length")
    out = TextOp()
    i1, i2 = _iter(a), _iter(b)
    o1, o2 = next(i1), next(i2)
    while True:
        if o1 is None and o2 is None:
            return out
        if is_delete(o1):
            out.delete(-o1)
            o1 = next(i1)
            continue
        if is_insert(o2):
            out.insert(o2)
            o2 = next(i2)
            continue
        if o1 is None or o2 is None:
            raise OTError("compose: operations have incompatible lengths")
        if is_retain(o1) and is_retain(o2):
            m = min(o1, o2)
            out.retain(m)
            o1, o2 = (o1 - m) or next(i1), (o2 - m) or next(i2)
        elif is_insert(o1) and is_delete(o2):
            if len(o1) > -o2:
                o1, o2 = o1[-o2:], next(i2)
            elif len(o1) == -o2:
                o1, o2 = next(i1), next(i2)
            else:
                o2, o1 = o2 + len(o1), next(i1)
        elif is_insert(o1) and is_retain(o2):
            if len(o1) > o2:
                out.insert(o1[:o2])
                o1, o2 = o1[o2:], next(i2)
            elif len(o1) == o2:
                out.insert(o1)
                o1, o2 = next(i1), next(i2)
            else:
                out.insert(o1)
                o2, o1 = o2 - len(o1), next(i1)
        elif is_retain(o1) and is_delete(o2):
            if o1 > -o2:
                out.delete(-o2)
                o1, o2 = o1 + o2, next(i2)
            elif o1 == -o2:
                out.delete(-o2)
                o1, o2 = next(i1), next(i2)
            else:
                out.delete(o1)
                o2, o1 = o2 + o1, next(i1)
        else:
            raise OTError("compose: unreachable state")


def transform(a: TextOp, b: TextOp) -> tuple[TextOp, TextOp]:
    """a and b were made concurrently on the same document. Returns (a', b') so both paths converge."""
    if a.base_length != b.base_length:
        raise OTError("transform: both operations must have the same base length")
    ap, bp = TextOp(), TextOp()
    i1, i2 = _iter(a), _iter(b)
    o1, o2 = next(i1), next(i2)
    while True:
        if o1 is None and o2 is None:
            return ap, bp
        if is_insert(o1):                       # tie-break: a's inserts win (go left)
            ap.insert(o1)
            bp.retain(len(o1))
            o1 = next(i1)
            continue
        if is_insert(o2):
            ap.retain(len(o2))
            bp.insert(o2)
            o2 = next(i2)
            continue
        if o1 is None or o2 is None:
            raise OTError("transform: operations have incompatible lengths")
        if is_retain(o1) and is_retain(o2):
            m = min(o1, o2)
            ap.retain(m)
            bp.retain(m)
            o1, o2 = (o1 - m) or next(i1), (o2 - m) or next(i2)
        elif is_delete(o1) and is_delete(o2):   # both deleted the same text: nobody needs to delete it again
            m = min(-o1, -o2)
            o1, o2 = (o1 + m) or next(i1), (o2 + m) or next(i2)
        elif is_delete(o1) and is_retain(o2):
            m = min(-o1, o2)
            ap.delete(m)
            o1, o2 = (o1 + m) or next(i1), (o2 - m) or next(i2)
        elif is_retain(o1) and is_delete(o2):
            m = min(o1, -o2)
            bp.delete(m)
            o1, o2 = (o1 - m) or next(i1), (o2 + m) or next(i2)
        else:
            raise OTError("transform: unreachable state")


def transform_index(op: TextOp, index: int) -> int:
    """Move a cursor position through an operation (inserts before it push it right, deletes pull left)."""
    new_index = index
    for c in op.ops:
        if is_retain(c):
            index -= c
        elif is_insert(c):
            new_index += len(c)
        else:
            new_index -= min(index, -c)
            index += c
        if index < 0:
            break
    return new_index


def diff_op(old: str, new: str) -> TextOp:
    """Minimal-ish op turning old into new (common prefix/suffix kept). Used for 'restore revision'."""
    p = 0
    while p < min(len(old), len(new)) and old[p] == new[p]:
        p += 1
    s = 0
    while s < min(len(old), len(new)) - p and old[-1 - s] == new[-1 - s]:
        s += 1
    return TextOp().retain(p).delete(len(old) - p - s).insert(new[p:len(new) - s]).retain(s)
