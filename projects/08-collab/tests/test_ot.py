"""OT correctness: unit cases + randomized property tests of the convergence laws."""
import random

import pytest

from collab.ot import OTError, TextOp, apply, compose, diff_op, transform, transform_index


def random_op(doc: str, rng: random.Random) -> TextOp:
    op = TextOp()
    i = 0
    while i < len(doc):
        r = rng.random()
        n = rng.randint(1, max(1, min(4, len(doc) - i)))
        if r < 0.2:
            op.insert("".join(rng.choice("abcXYZ ") for _ in range(rng.randint(1, 3))))
        elif r < 0.45:
            op.delete(n)
            i += n
        else:
            op.retain(n)
            i += n
    if rng.random() < 0.3:
        op.insert("".join(rng.choice("123") for _ in range(rng.randint(1, 3))))
    return op


def random_doc(rng):
    return "".join(rng.choice("hello world ") for _ in range(rng.randint(0, 25)))


def test_apply_basic():
    assert apply("hello", TextOp([5, " world"])) == "hello world"
    assert apply("hello world", TextOp([5, -6])) == "hello"
    assert apply("abc", TextOp(["X", 1, -1, "Y", 1])) == "XaYc"
    with pytest.raises(OTError):
        apply("abc", TextOp([2, "x"]))           # op doesn't cover the whole document


def test_normalisation_merges_components():
    op = TextOp().retain(2).retain(3).insert("a").insert("b").delete(1).delete(2)
    assert op.ops == [5, "ab", -3]
    op2 = TextOp().delete(2).insert("x")         # canonical: insert before delete
    assert op2.ops == ["x", -2]


def test_concurrent_insert_same_position_tie_break():
    doc = "ac"
    a, b = TextOp([1, "X", 1]), TextOp([1, "Y", 1])
    ap, bp = transform(a, b)
    assert apply(apply(doc, a), bp) == apply(apply(doc, b), ap) == "aXYc"   # a's insert goes first


def test_concurrent_delete_overlap():
    doc = "abcdef"
    a, b = TextOp([1, -3, 2]), TextOp([2, -3, 1])     # delete "bcd" vs delete "cde"
    ap, bp = transform(a, b)
    assert apply(apply(doc, a), bp) == apply(apply(doc, b), ap) == "af"


def test_delete_vs_insert_inside_deleted_range():
    doc = "abcdef"
    a, b = TextOp([1, -4, 1]), TextOp([3, "XYZ", 3])
    ap, bp = transform(a, b)
    assert apply(apply(doc, a), bp) == apply(apply(doc, b), ap) == "aXYZf"   # insert survives


@pytest.mark.parametrize("seed", range(5))
def test_property_transform_converges(seed):
    rng = random.Random(seed)
    for _ in range(400):
        doc = random_doc(rng)
        a, b = random_op(doc, rng), random_op(doc, rng)
        ap, bp = transform(a, b)
        assert apply(apply(doc, a), bp) == apply(apply(doc, b), ap)


@pytest.mark.parametrize("seed", range(5))
def test_property_compose_equals_sequential_apply(seed):
    rng = random.Random(100 + seed)
    for _ in range(400):
        doc = random_doc(rng)
        a = random_op(doc, rng)
        b = random_op(apply(doc, a), rng)
        assert apply(doc, compose(a, b)) == apply(apply(doc, a), b)


def test_transform_does_not_distribute_over_compose():
    """Finding (from a failed property test): transforming against s1 then s2 is NOT always equal to
    transforming against compose(s1, s2). compose() normalises to insert-before-delete, which can move s2's
    insert across a deleted character and flip the tie-break with a concurrent insert at the same spot.
    Consequence for the design: every party must transform against the SAME sequence of operations --
    the server transforms an incoming op against history one revision at a time, exactly as clients see it.
    (Minimal counterexample found by shrinking random cases.)"""
    doc = "heoo"
    client = TextOp(["aYYbZ", -3, 1, "221"])
    s1, s2 = TextOp([3, -1]), TextOp([3, "2"])
    stepwise = apply(apply(apply(doc, s1), s2), transform(transform(client, s1)[0], s2)[0])
    composed_s = compose(s1, s2)
    assert composed_s.ops == [3, "2", -1]                       # insert moved before the delete
    composed = apply(apply(doc, composed_s), transform(client, composed_s)[0])
    assert stepwise == "aYYbZ2212" and composed == "aYYbZ2221" and stepwise != composed


def test_transform_index_cursor():
    op = TextOp([2, "XYZ", 3])          # insert 3 chars at position 2
    assert transform_index(op, 1) == 1 and transform_index(op, 4) == 7
    op = TextOp([1, -3, 2])             # delete chars 1..3
    assert transform_index(op, 0) == 0 and transform_index(op, 2) == 1 and transform_index(op, 5) == 2


def test_diff_op():
    for old, new in [("hello world", "hello brave world"), ("abc", ""), ("", "xyz"), ("same", "same")]:
        assert apply(old, diff_op(old, new)) == new


def test_rejects_malformed():
    with pytest.raises(OTError):
        TextOp.from_json([1, 2.5])
    with pytest.raises(OTError):
        TextOp.from_json("not a list")
