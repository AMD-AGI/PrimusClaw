# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""Cross-language Fernet samples, using nothing but `cryptography` (what the Python worker encrypts with).

    python3 fernet_golden.py generate > ../data/fernet-golden.json   # Python makes tokens; the TS tests decrypt them
    python3 fernet_golden.py verify < samples.json                    # the TS tests make tokens; Python decrypts them

Keys, IVs and times come from a seeded generator, so `generate` writes the same file on every run.
"""

import base64
import hashlib
import hmac
import json
import random
import sys

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

LINK_HASH_LABEL = b"primusclaw-teams/link-code-hmac/v1"
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
TEXTS = ["", "ak-", "密钥 🔑 key", "é" * 17, "x" * 15, "y" * 16, "z" * 33, "whsec-" + "0123456789abcdef" * 4]


def _key(rng):
    return base64.urlsafe_b64encode(rng.randbytes(32)).decode()


def _plaintext(rng, i):
    if i < len(TEXTS):
        return TEXTS[i].encode()
    if i % 3 == 0:
        return "".join(rng.choice("abc中文💬\n\"\\ ") for _ in range(rng.randrange(1, 60))).encode()
    return rng.randbytes(rng.randrange(0, 300))


def _tampered(token):
    """The token with one byte of each part flipped (version, time, IV, ciphertext, MAC), each still base64."""
    raw = base64.urlsafe_b64decode(token)
    out = []
    for at in (0, 4, 12, 30, len(raw) - 1):
        changed = bytearray(raw)
        changed[at] ^= 0x01
        out.append(base64.urlsafe_b64encode(bytes(changed)).decode())
    return out


def generate():
    rng = random.Random(20261109)
    samples = []
    for i in range(100):
        keys = [_key(rng) for _ in range(1 + i % 3)]
        signer = keys[i % len(keys)]  # not always the first: a reader tries every key
        plain = _plaintext(rng, i)
        token = Fernet(signer.encode())._encrypt_from_parts(plain, rng.randrange(0, 2**40), rng.randbytes(16)).decode()
        samples.append(
            {
                "keys": keys,
                "plaintext_b64": base64.b64encode(plain).decode(),
                "token": token,
                "tampered": _tampered(token),
            }
        )
    link_codes = []
    for _ in range(20):
        key = _key(rng)
        code = "".join(rng.choice(CODE_ALPHABET) for _ in range(8))
        derived = hmac.new(base64.urlsafe_b64decode(key.encode()), LINK_HASH_LABEL, hashlib.sha256).digest()
        link_codes.append({"fernet_key": key, "code": code, "hash": hmac.new(derived, code.encode(), hashlib.sha256).hexdigest()})
    json.dump({"fernet": samples, "link_codes": link_codes}, sys.stdout, indent=1)
    sys.stdout.write("\n")


def verify():
    """Reads {"fernet": [{keys, plaintext_b64, token, tampered}]}; prints {"decrypted": n, "equal": n, "refused": n, "tampered": n}."""
    samples = json.load(sys.stdin)["fernet"]
    counts = {"samples": len(samples), "equal": 0, "tampered": 0, "refused": 0}
    for s in samples:
        multi = MultiFernet([Fernet(k.encode()) for k in s["keys"]])
        if multi.decrypt(s["token"].encode()) == base64.b64decode(s["plaintext_b64"]):
            counts["equal"] += 1
        for bad in s["tampered"]:
            counts["tampered"] += 1
            try:
                multi.decrypt(bad.encode())
            except InvalidToken:
                counts["refused"] += 1
    json.dump(counts, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    {"generate": generate, "verify": verify}[sys.argv[1]]()
