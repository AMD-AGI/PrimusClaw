// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The daily brief's scheduled trigger (the Python worker's `templates/daily-brief.json`). */
export const DAILY_BRIEF = {
  name: "Daily brief",
  defaultTime: "08:30",
  /** Weekdays, as cron's day-of-week field. */
  days: "1-5",
  prompt:
    "Use the daily-brief skill and give me my daily brief. Read only: do not change anything and do not call any tool " +
    "that writes.",
} as const;
