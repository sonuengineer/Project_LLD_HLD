import pytest

from webhooks.services.signing import VerificationError, generate_secret, sign, signature_header, verify
from webhooks.services.ssrf import BlockedDestination, assert_public_destination, validate_url_syntax

BODY = b'{"id":"evt_1","type":"order.paid"}'


def headers(secrets, ts, msg_id="evt_1", body=BODY):
    return {"webhook-id": msg_id, "webhook-timestamp": str(ts), "webhook-signature": signature_header(secrets, msg_id, ts, body)}


def test_standard_webhooks_reference_vector():
    """Test vector published with the Standard Webhooks reference libraries."""
    sig = sign("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330,
               b'{"test": 2432232314}')
    assert sig == "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="


def test_roundtrip_and_tamper_detection():
    s = generate_secret()
    verify([s], headers([s], 1000), BODY, now=1000)
    with pytest.raises(VerificationError, match="no matching"):
        verify([s], headers([s], 1000), BODY + b" ", now=1000)            # body changed
    h = headers([s], 1000)
    h["webhook-id"] = "evt_2"
    with pytest.raises(VerificationError):
        verify([s], h, BODY, now=1000)                                     # id is signed too
    with pytest.raises(VerificationError, match="no matching"):
        verify([generate_secret()], headers([s], 1000), BODY, now=1000)    # wrong secret


def test_replay_outside_tolerance_rejected():
    s = generate_secret()
    with pytest.raises(VerificationError, match="tolerance"):
        verify([s], headers([s], 1000), BODY, now=1000 + 301)
    with pytest.raises(VerificationError, match="tolerance"):
        verify([s], headers([s], 1000), BODY, now=1000 - 301)              # future timestamps too
    verify([s], headers([s], 1000), BODY, now=1300)


def test_rotation_dual_signatures():
    old, new = generate_secret(), generate_secret()
    h = headers([new, old], 1000)
    assert len(h["webhook-signature"].split()) == 2
    verify([old], h, BODY, now=1000)          # customer not yet updated
    verify([new], h, BODY, now=1000)          # customer already updated
    verify([new, old], headers([new], 1000), BODY, now=1000)   # customer accepts both during their own rollout


def test_missing_headers():
    with pytest.raises(VerificationError, match="missing"):
        verify([generate_secret()], {}, BODY)


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/x", "https://127.0.0.1/x", "https://10.1.2.3/x", "https://192.168.1.10/x",
    "https://169.254.169.254/latest/meta-data/", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x",
    "https://localhost/x", "https://0.0.0.0/x"])
async def test_ssrf_blocks_internal_destinations(url):
    with pytest.raises(BlockedDestination):
        await assert_public_destination(url, allow_private=False)


async def test_ssrf_allows_public_ip():
    await assert_public_destination("https://93.184.215.14/hook", allow_private=False)


def test_url_syntax_rules():
    for bad in ["ftp://x.com/a", "https://user:pw@x.com/", "https:///nohost", "http://example.com/"]:
        with pytest.raises(BlockedDestination):
            validate_url_syntax(bad, allow_private=False)
    validate_url_syntax("http://receiver:9000/webhook", allow_private=True)
