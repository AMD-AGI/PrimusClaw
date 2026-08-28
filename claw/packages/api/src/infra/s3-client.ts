// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { S3Client } from "@aws-sdk/client-s3";

import {
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, S3_API_ENDPOINT,
} from "../config.js";

let _s3: S3Client | null = null;

/**
 * Connections this process may hold open to the object store at once.
 *
 * Explicit because one shared client is also one shared connection pool, and the
 * SDK's default is fifty for it. The connection timeout below starts counting
 * when the request is created rather than when it is given a socket, so a
 * request waiting its turn behind a saturated pool is failed as a TimeoutError
 * while the endpoint is answering everything else normally -- and merging every
 * caller onto one default-sized pool would trade "hangs for ever when the peer
 * goes quiet" for "fails in five seconds whenever the process is busy".
 *
 * Sized well above the one caller that has a ceiling of its own: the upload
 * sweep runs under a leader lock, so its sixteen concurrent deletes plus its
 * listing and HEAD walk are a fixed cost for the whole process. Everything else
 * grows with the requests being served -- a session teardown deletes sixteen at
 * a time but there can be one teardown per request, a multipart upload holds up
 * to four sockets per call, and a file listing, download or zip pack holds one.
 * Those are also the callers that notice a queued socket as latency, which is
 * what the rest of the headroom is for.
 */
const MAX_SOCKETS = 256;

/**
 * The object store, for the paths that have to be able to end.
 *
 * One factory rather than one per caller, because the timeouts are the reason it
 * exists and a second copy of the construction is a second copy without them.
 * Without them a call has no upper bound at all: an endpoint that accepts the
 * connection and then stops answering leaves the request pending for the life of
 * the process. The upload sweep runs under a leader lock, so one stuck replica
 * holds the advisory lock while every other replica skips it and the only symptom
 * is a log line that stops appearing. A session delete runs inside a request
 * handler and walks two prefixes, so the same silence is a request that never
 * answers about a session whose files are half gone.
 *
 * throwOnRequestTimeout is not optional here. requestTimeout on its own only logs
 * a warning when it is breached, for backwards compatibility with the years it
 * was applied as a socket idle timeout -- the call goes on hanging, which is the
 * thing being bounded.
 *
 * Shared instance because the SDK client is a connection pool and a set of
 * resolved credentials, not per-call state; the callers here differ only in which
 * commands they send. Every caller in this package goes through it -- the
 * background sweeps, the session teardown and the request handlers alike -- so
 * the pool it holds is sized for all of them; see MAX_SOCKETS.
 */
export function getS3Client(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      // The fallback is not cosmetic. `S3_REGION` set to an empty string reaches
      // here as "", and the SDK rejects that while the client is being
      // constructed -- so `_s3` stays null and every S3 path in the process
      // rethrows "Region is missing", not just the caller that happened to ask
      // first. S3-compatible stores ignore the value; it has to be some value.
      region: S3_REGION || "us-east-1",
      endpoint: S3_API_ENDPOINT || undefined,
      forcePathStyle: true,
      // Both, because half a key pair is not a credential: with only the id set,
      // this signs requests with an empty secret instead of falling back to the
      // default provider chain -- the instance role or the shared config file
      // that a deployment setting neither variable is relying on.
      credentials: S3_ACCESS_KEY && S3_SECRET_KEY
        ? { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
        : undefined,
      requestHandler: {
        connectionTimeout: 5_000,
        requestTimeout: 30_000,
        throwOnRequestTimeout: true,
        httpAgent: { maxSockets: MAX_SOCKETS },
        httpsAgent: { maxSockets: MAX_SOCKETS },
      },
    });
  }
  return _s3;
}
