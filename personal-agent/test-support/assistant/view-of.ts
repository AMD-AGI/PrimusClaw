// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The model of a view the test expects to be of one kind: asserted by its name, typed by it. */
import assert from "node:assert/strict";

import type { OutMessage, View, ViewMap } from "@primusclaw/personal-agent";

export function modelOf<K extends keyof ViewMap>(view: View | undefined, name: K): ViewMap[K] {
  assert.ok(view !== undefined && view.name === name, `expected a ${name} view, got ${String(view?.name)}`);
  return view.model as ViewMap[K];
}

/** The views among `messages`, in order. */
export function viewsOf(messages: readonly OutMessage[]): View[] {
  return messages.flatMap((m) => (m.body.type === "view" ? [m.body.view] : []));
}
