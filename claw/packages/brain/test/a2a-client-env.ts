// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Imported first by the tests that exercise a2a_call: A2A_CLIENT_ENABLED is read once, when
// config.ts loads, and the tool is off unless it is set. Import order is what makes this a
// statement about the process rather than about one test.
process.env.A2A_CLIENT_ENABLED = "true";
