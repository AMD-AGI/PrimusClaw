// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIpAddress } from "../../src/index.js";

// Every expectation below is what Python 3.14's `str(ipaddress.ip_address(given))` printed (None: ValueError).
const PYTHON: ReadonlyArray<readonly [string, string | null]> = [
  ["::ffff:52.96.0.1", "::ffff:52.96.0.1"],
  ["::ffff:3460:1", "::ffff:52.96.0.1"],
  ["1:0:2:3:4:5:6:7", "1:0:2:3:4:5:6:7"],
  ["1:0:0:2:0:0:3:4", "1::2:0:0:3:4"],
  ["0:0:0:0:0:0:0:0", "::"],
  ["::", "::"],
  ["FD00:0:0:0:0:0:0:1", "fd00::1"],
  ["::1.2.3.4", "::102:304"],
  ["1::", "1::"],
  ["1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:102:304"],
  ["::ffff:0:1.2.3.4", "::ffff:0:102:304"],
  ["64:ff9b::1.2.3.4", "64:ff9b::102:304"],
  ["1:2:3:4:5:6:7::", "1:2:3:4:5:6:7:0"],
  ["::2:3:4:5:6:7:8", "0:2:3:4:5:6:7:8"],
  ["0001:00ab::", "1:ab::"],
  ["203.0.113.7", "203.0.113.7"],
  ["0.0.0.0", "0.0.0.0"],
  ["01.2.3.4", null],
  ["1.2.3", null],
  ["1.2.3.256", null],
  ["1::2::3", null],
  ["1:2:3:4:5:6:7:8:9", null],
  ["12345::", null],
  ["::ffff:1.2.3.04", null],
  [":1:2:3:4:5:6:7", null],
  ["1:2:3:4:5:6:7:", null],
  [":1::2", null],
  ["1::2:", null],
  ["1:2:3:4:5:6:7:8::", null],
  ["1:2", null],
  ["1:2:3:4:5:6:7", null],
  ["1:2:3:4:5:6:7:1.2.3.4", null],
  ["::1.2.3", null],
  ["1:2:3:4:5:6:7:8:9:10:11", null],
  ["", null],
  ["1".repeat(46), null],
];

describe("parseIpAddress", () => {
  it("reads and writes addresses as Python's ipaddress does", () => {
    for (const [given, written] of PYTHON) {
      assert.equal(parseIpAddress(given)?.address ?? null, written, given);
    }
  });

  it("says which IPv4 address a mapped address maps", () => {
    assert.equal(parseIpAddress("::ffff:52.96.0.1")?.mappedV4, "52.96.0.1");
    assert.equal(parseIpAddress("2001:db8::1")?.mappedV4, null);
    assert.equal(parseIpAddress("52.96.0.1")?.mappedV4, null);
  });
});
