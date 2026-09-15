// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Meter the session tree before config.ts is read.
 *
 * The ceiling is read at import, so a plain assignment in the test file does
 * not work: ESM hoists every import above it. A module imported first is
 * evaluated first, which is the only ordering hook available.
 *
 * Three nodes -- a root and two children -- so a tree can be seeded one node
 * below the ceiling and one node at it in the same file.
 */

process.env.ADMIT_TREE_MAX_NODES = "3";
// And a run ceiling below anything the fleet could be holding, so a create that
// starts no run proves it is not metered against runs at all. An operator who
// lowers this must not stop teams being built.
process.env.ADMIT_HARD_RUNS = "1";
