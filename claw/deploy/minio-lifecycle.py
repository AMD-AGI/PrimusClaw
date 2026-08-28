#!/usr/bin/env python3
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT
"""Configure MinIO / S3 bucket Lifecycle rules for Claw.

Idempotent: re-running replaces the owned rules (matched by ID) in-place while
preserving any other rules already on the bucket. Safe from CI/CD or runbooks.

Usage (from the repo root where .env lives):
    set -a && source .env && set +a && python3 claw/deploy/minio-lifecycle.py

Required env:  S3_ACCESS_KEY, S3_SECRET_KEY
Optional env:  S3_ENDPOINT, S3_BUCKET (default "claw"), S3_REGION (default
               "us-east-1"), S3_PLUGINS_BUCKET (default "plugins"). When
               S3_PLUGINS_BUCKET differs from S3_BUCKET, the import-staging rule
               targets that bucket only.

Dependency: boto3 (pip install boto3)

Rules owned by this script (keyed by ID, replace-in-place):
  - claw-import-staging : expire objects under prefix `imports/staging/` after N
      days (orphaned discover zips + `.meta.json`; API TTL is 1h, this is
      storage GC only).
  - claw-user-upload-*  : expire objects tagged `origin=user-upload` + `ttl=<tier>`
      after 1-30 days. Set by POST /v1/sessions/:id/upload.
  - claw-zip-cache-1d   : expire objects tagged `origin=zip-cache` + `ttl=1d`
      after 1 day (zip-task marker/artifact/failed sidecar).

To add more rules, extend the rule lists below and re-run.
"""
import os
import sys

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:
    sys.stderr.write("boto3 is required: pip install boto3\n")
    sys.exit(1)

MAIN_BUCKET = os.environ.get("S3_BUCKET") or "claw"
PLUGINS_BUCKET = (os.environ.get("S3_PLUGINS_BUCKET") or "plugins").strip() or "plugins"
ENDPOINT = os.environ.get("S3_ENDPOINT") or None
REGION = os.environ.get("S3_REGION") or "us-east-1"
ACCESS_KEY = os.environ.get("S3_ACCESS_KEY")
SECRET_KEY = os.environ.get("S3_SECRET_KEY")

# Days until S3 deletes abandoned import staging zips (must exceed API STAGE_TTL_MS).
IMPORT_STAGING_EXPIRE_DAYS = 7

if not ACCESS_KEY or not SECRET_KEY:
    sys.stderr.write("Missing S3_ACCESS_KEY / S3_SECRET_KEY in env\n")
    sys.exit(1)

# Tiered expiry for user uploads. The API tags each object origin=user-upload +
# ttl=<tier>; each rule combines both tags via an And filter.
# Adding a tier: append here AND update UPLOAD_TTL_DAYS_ALLOWED in the API.
USER_UPLOAD_TIERS = [
    ("claw-user-upload-1d", "1d", 1),
    ("claw-user-upload-2d", "2d", 2),
    ("claw-user-upload-7d", "7d", 7),
    ("claw-user-upload-15d", "15d", 15),
    ("claw-user-upload-30d", "30d", 30),
]


def user_upload_rules():
    """Build one lifecycle rule per user-upload TTL tier."""
    return [
        {
            "ID": rid,
            "Status": "Enabled",
            "Filter": {
                "And": {
                    "Tags": [
                        {"Key": "origin", "Value": "user-upload"},
                        {"Key": "ttl", "Value": ttl},
                    ]
                }
            },
            "Expiration": {"Days": days},
        }
        for rid, ttl, days in USER_UPLOAD_TIERS
    ]


# Prefix-only filter: does not touch `plugins/{id}/`, `skills/`, `icons/`, etc.
IMPORT_STAGING_RULE = {
    "ID": "claw-import-staging",
    "Status": "Enabled",
    "Filter": {"Prefix": "imports/staging/"},
    "Expiration": {"Days": IMPORT_STAGING_EXPIRE_DAYS},
}

# Zip-task artifacts under users/<uid>/sessions/<sid>/.zip-cache/, tagged
# origin=zip-cache + ttl=1d by the API so they expire together.
ZIP_CACHE_RULE = {
    "ID": "claw-zip-cache-1d",
    "Status": "Enabled",
    "Filter": {
        "And": {
            "Tags": [
                {"Key": "origin", "Value": "zip-cache"},
                {"Key": "ttl", "Value": "1d"},
            ]
        }
    },
    "Expiration": {"Days": 1},
}


def make_client():
    """S3 client with path-style addressing (MinIO) and MinIO-safe checksums."""
    cfg_kwargs = {"s3": {"addressing_style": "path"}, "signature_version": "s3v4"}
    # botocore >= 1.36 defaults to CRC32 request checksums that some MinIO / S3
    # gateways reject on bucket-config PUTs; "when_required" restores the older
    # Content-MD5-only behaviour. Guarded so older botocore (no such kwarg) works.
    try:
        cfg = Config(
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            **cfg_kwargs,
        )
    except TypeError:
        cfg = Config(**cfg_kwargs)
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        region_name=REGION,
        aws_access_key_id=ACCESS_KEY,
        aws_secret_access_key=SECRET_KEY,
        config=cfg,
    )


s3 = make_client()


def apply_lifecycle(bucket, owned_rules):
    """GET existing rules, replace owned rules by ID (preserving others), PUT."""
    print(f'-> Target bucket="{bucket}" endpoint="{ENDPOINT or "aws-default"}"')

    existing = []
    try:
        cur = s3.get_bucket_lifecycle_configuration(Bucket=bucket)
        existing = cur.get("Rules", []) or []
        ids = ", ".join(r.get("ID", "") for r in existing) or "(none)"
        print(f"  existing rules: {ids}")
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "NoSuchLifecycleConfiguration":
            print("  existing rules: (none - bucket has no lifecycle config yet)")
        else:
            print(f"  could not read existing config: {exc}")

    owned_ids = {r["ID"] for r in owned_rules}
    preserved = [r for r in existing if r.get("ID") not in owned_ids]
    merged = preserved + owned_rules

    print("-> Applying rules:")
    for r in merged:
        origin = "(owned)" if r.get("ID") in owned_ids else "(preserved)"
        print(
            f'  - {r.get("ID")} {origin} -> status={r.get("Status")} '
            f'filter={r.get("Filter")} expiration={r.get("Expiration")}'
        )

    s3.put_bucket_lifecycle_configuration(
        Bucket=bucket,
        LifecycleConfiguration={"Rules": merged},
    )
    print(f'OK Lifecycle configuration applied for bucket "{bucket}".')


def main():
    print(f'Lifecycle script: main="{MAIN_BUCKET}" plugins="{PLUGINS_BUCKET}"')
    if MAIN_BUCKET == PLUGINS_BUCKET:
        apply_lifecycle(
            MAIN_BUCKET,
            [IMPORT_STAGING_RULE, ZIP_CACHE_RULE, *user_upload_rules()],
        )
    else:
        apply_lifecycle(MAIN_BUCKET, [ZIP_CACHE_RULE, *user_upload_rules()])
        apply_lifecycle(PLUGINS_BUCKET, [IMPORT_STAGING_RULE])


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - top-level guard for a CLI script
        sys.stderr.write(f"Failed: {exc}\n")
        sys.exit(1)
