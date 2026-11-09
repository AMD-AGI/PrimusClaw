// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The turn's cards (W4b): a delivered file, and what a session changed. Inputs are the Python catalog's. */
import { turn } from "@primusclaw/personal-agent";

import { changesCard, deliveryCard } from "../../packages/teams/src/views/turn/index.js";
import { BASE, entries, SID } from "./catalog.js";

function changes(): turn.Changes {
  const files: turn.FileChange[] = [
    { path: "teams/teams_agent/render.py", status: "M", additions: 120, deletions: 48, binary: false },
    { path: "teams/teams_agent/cards.py", status: "A", additions: 210, deletions: 0, binary: false },
    { path: "teams/tests/test_card_snapshots.py", status: "A", additions: 95, deletions: 0, binary: false },
    { path: "teams/app/color.png", status: "M", additions: undefined, deletions: undefined, binary: true },
  ];
  const repo: turn.RepoChanges = {
    path: "/workspace/PrimusClaw",
    branch: "teams/card-style",
    head: "1a2b3c4",
    truncated: false,
    files,
    totalFiles: 4,
    additions: 425,
    deletions: 48,
  };
  return { repos: [repo], truncated: false };
}

const delivery: turn.Delivery = {
  id: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
  name: "safe-node-report.xlsx",
  size: 48213,
  contentType: "application/vnd.ms-excel",
  caption: "本周节点故障明细",
  image: "",
};

export const TURN = entries(
  ["changes", () => changesCard({ changes: changes(), sessionId: SID, publicBaseUrl: BASE })],
  ["delivery", () => deliveryCard({ delivery, url: `${BASE}/x` })],
);
