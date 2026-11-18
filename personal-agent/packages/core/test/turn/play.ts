// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { runTurn, type TurnControls } from "../../src/turn/engine/run-turn.js";
import { LIVE_HEADER } from "../../src/turn/live-view.js";
import { detachedCount } from "../../src/turn/task.js";
import { Timeline } from "./timeline.js";
import {
  Bus,
  type BusOptions,
  type Script,
  ScriptedClaw,
  textOf,
  world,
  type World,
  type WorldOptions,
} from "./world.js";

export interface PlayOptions extends WorldOptions {
  readonly bus?: BusOptions;
  readonly hang?: boolean;
  readonly controls?: Partial<TurnControls>;
  /** Changes the world before the turn runs. */
  readonly setUp?: (w: World) => void;
}

export interface Run extends World {
  /** (seconds, text) of the progress edits. */
  readonly progress: Array<readonly [number, string]>;
  /** What the user is left reading. */
  readonly texts: string[];
  readonly final: string;
  readonly sessions: string[];
}

export function setUpWorld(script: Script, options: PlayOptions = {}): World {
  const clock = new Timeline();
  const bus = new Bus(clock, options.bus);
  const claw = new ScriptedClaw(clock, script);
  claw.hang = options.hang ?? false;
  const w = world(clock, bus, claw, options);
  options.setUp?.(w);
  return w;
}

export function runOf(w: World, sessions: string[]): Run {
  const progress = w.bus.updates.filter(([, text]) => text.startsWith(LIVE_HEADER));
  const texts = w.bus.texts;
  return { ...w, progress, texts, final: texts.at(-1) ?? "", sessions };
}

/** Runs one turn against `script` to its end on virtual time, then lets whatever still waits run out. */
export async function play(script: Script, options: PlayOptions = {}): Promise<Run> {
  const w = setUpWorld(script, options);
  const sessions: string[] = [];
  const controls: TurnControls = {
    onSession: (id) => sessions.push(id),
    stopRequested: () => false,
    ...options.controls,
  };
  await w.clock.pump(runTurn(w.ctx, controls));
  await w.clock.drain(); // a flusher that outlived the turn would send here, after the answer
  return runOf(w, sessions);
}

/** Nothing of the turn is still running: no detached work, nobody waiting on the clock. */
export function quiet(w: World): boolean {
  return detachedCount() === 0 && w.clock.waiting === 0;
}

export { textOf };
