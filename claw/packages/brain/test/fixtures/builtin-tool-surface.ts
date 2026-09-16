// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The complete built-in tool surface `ToolRouter.getToolSchemas()` publishes,
 * as an exact name set and an exact per-tool field set.
 *
 * Shared by the two switch-state test files because the surface differs between
 * them only in `bash`'s property set and the three background names; writing the
 * other eighteen rows twice is how the two copies come to disagree.
 *
 * Description prose is deliberately absent: a whole-description assertion turns
 * every wording improvement into a failure and pins nothing the field sets do
 * not already pin.
 */
import assert from "node:assert/strict";

interface ToolLike {
  name: string;
  input_schema: unknown;
}

interface Expected {
  properties: string[];
  /** Absent where the tool publishes no `required` key at all. */
  required?: string[];
  /** Property name to exact enum array, asserted as equality. */
  enums?: Record<string, string[]>;
  /** Nested object property to its own exact key set. */
  nested?: Record<string, string[]>;
}

/** The eighteen names published in both switch states, in publication order. */
export const CLOSED_STATE_NAMES = [
  "save_memory", "save_skill", "add_skill_file", "update_skill_file", "remove_skill_file",
  "bash", "read", "write", "edit", "glob", "grep", "ls", "notebook_edit", "multi_edit",
  "todo_write", "exit_plan_mode", "a2a_call", "task",
];

/** The same eighteen, with the background trio spliced in after `bash`. */
export const OPEN_STATE_NAMES = CLOSED_STATE_NAMES.flatMap((name) =>
  name === "bash" ? [name, "bash_output", "kill_shell", "wait"] : [name],
);

/** The four background entry points. `wait` is a member, not an afterthought. */
export const BACKGROUND_TOOL_NAMES = ["bash", "bash_output", "kill_shell", "wait"];

const SHARED: Record<string, Expected> = {
  save_memory: {
    properties: ["category", "content", "importance"],
    required: ["category", "content"],
    enums: { category: ["preference", "correction", "env_fact", "tool_quirk", "pattern"] },
  },
  save_skill: {
    properties: ["skill_name", "description", "content"],
    required: ["skill_name", "content", "description"],
  },
  add_skill_file: {
    properties: ["skill_name", "file_path", "content", "is_binary"],
    required: ["skill_name", "file_path", "content"],
  },
  update_skill_file: {
    properties: ["skill_name", "file_path", "content", "is_binary"],
    required: ["skill_name", "file_path", "content"],
  },
  remove_skill_file: {
    properties: ["skill_name", "file_path"],
    required: ["skill_name", "file_path"],
  },
  read: {
    properties: ["path", "offset", "limit", "notebook_cell_index"],
    required: ["path"],
  },
  write: { properties: ["path", "contents"], required: ["path", "contents"] },
  edit: {
    properties: ["path", "old_string", "new_string"],
    required: ["path", "old_string", "new_string"],
  },
  glob: { properties: ["pattern", "directory"], required: ["pattern"] },
  grep: { properties: ["pattern", "path", "context"], required: ["pattern"] },
  ls: { properties: ["path"] },
  notebook_edit: {
    properties: ["path", "cell_index", "old_string", "new_string"],
    required: ["path", "cell_index", "new_string"],
  },
  multi_edit: { properties: ["edits"], required: ["edits"] },
  todo_write: {
    properties: ["todos", "merge"],
    required: ["todos"],
  },
  exit_plan_mode: { properties: ["plan"], required: ["plan"] },
  a2a_call: {
    properties: ["agent", "message", "skill", "mode", "task_id", "metadata"],
    required: ["agent", "message"],
    enums: { mode: ["stream", "fire_and_forget", "discover"] },
    nested: { metadata: ["plugin_id", "workspace_id", "parent_session_id", "team_role"] },
  },
  task: {
    properties: ["description", "prompt", "subagent_type", "tools"],
    required: ["description", "prompt"],
    enums: { subagent_type: ["explore", "readonly", "shell", "generalPurpose"] },
  },
};

const CLOSED_BASH: Expected = { properties: ["command", "timeout"], required: ["command"] };

const OPEN_ONLY: Record<string, Expected> = {
  bash: {
    properties: ["command", "timeout", "run_in_background", "shell_id", "background_kind"],
    required: ["command"],
    enums: { background_kind: ["background", "monitor"] },
  },
  bash_output: { properties: ["shell_id", "filter"], required: ["shell_id"] },
  kill_shell: { properties: ["shell_id"], required: ["shell_id"] },
  wait: { properties: ["shell_id", "timeout_sec"], required: ["shell_id"] },
};

/** The whole expected surface for one switch state. */
export function expectedSurface(bgShellEnabled: boolean): Record<string, Expected> {
  return bgShellEnabled
    ? { ...SHARED, ...OPEN_ONLY }
    : { ...SHARED, bash: CLOSED_BASH };
}

function propertiesOf(tool: ToolLike): Record<string, Record<string, unknown>> {
  return (tool.input_schema as { properties: Record<string, Record<string, unknown>> }).properties;
}

/**
 * Assert the published surface equals the table exactly: the name set, and for
 * every name the property key set, the `required` array, each pinned enum, and
 * each pinned nested object's own key set.
 *
 * `todo_write.todos[].status` is pinned through the array item rather than the
 * top-level property, being the one enum that does not sit at the first level.
 */
export function assertSurfaceMatches(schemas: ToolLike[], bgShellEnabled: boolean): void {
  const expected = expectedSurface(bgShellEnabled);
  const names = bgShellEnabled ? OPEN_STATE_NAMES : CLOSED_STATE_NAMES;

  assert.deepEqual(schemas.map((s) => s.name), names);

  for (const tool of schemas) {
    const row = expected[tool.name];
    assert.ok(row, `${tool.name} is published but not pinned`);
    const props = propertiesOf(tool);
    assert.deepEqual(
      Object.keys(props).sort(), [...row.properties].sort(),
      `${tool.name} input_schema property set`,
    );
    const required = (tool.input_schema as { required?: string[] }).required;
    assert.deepEqual(required, row.required, `${tool.name} required`);

    for (const [prop, values] of Object.entries(row.enums ?? {})) {
      assert.deepEqual(props[prop].enum, values, `${tool.name}.${prop} enum`);
    }
    for (const [prop, keys] of Object.entries(row.nested ?? {})) {
      const nested = props[prop].properties as Record<string, unknown>;
      assert.deepEqual(Object.keys(nested).sort(), [...keys].sort(), `${tool.name}.${prop} keys`);
      assert.equal(
        (props[prop] as { additionalProperties?: unknown }).additionalProperties, undefined,
        `${tool.name}.${prop} places no additionalProperties restriction`,
      );
    }
  }

  const todos = propertiesOf(schemas.find((s) => s.name === "todo_write")!).todos;
  const item = (todos as { items: { properties: Record<string, { enum?: string[] }>; required?: string[] } }).items;
  assert.deepEqual(Object.keys(item.properties).sort(), ["content", "id", "status"]);
  assert.deepEqual(item.properties.status.enum, ["pending", "in_progress", "completed", "cancelled"]);
  assert.equal(item.required, undefined, "todo items carry no item-level required");

  const edits = propertiesOf(schemas.find((s) => s.name === "multi_edit")!).edits;
  const editItem = (edits as { items: { properties: Record<string, unknown>; required: string[] } }).items;
  assert.deepEqual(Object.keys(editItem.properties).sort(), ["new_string", "old_string", "path"]);
  assert.deepEqual(editItem.required, ["path", "old_string", "new_string"]);
}

/** The background-tool-scoped, higher-resolution pin of C-1.1–C-1.2. */
export function assertBackgroundSurface(schemas: ToolLike[], bgShellEnabled: boolean): void {
  const present = schemas
    .map((s) => s.name)
    .filter((name) => BACKGROUND_TOOL_NAMES.includes(name));
  assert.deepEqual(
    present.sort(),
    (bgShellEnabled ? BACKGROUND_TOOL_NAMES : ["bash"]).slice().sort(),
  );
  const expected = expectedSurface(bgShellEnabled);
  for (const name of present) {
    const tool = schemas.find((s) => s.name === name)!;
    assert.deepEqual(Object.keys(propertiesOf(tool)).sort(), [...expected[name].properties].sort());
    assert.deepEqual((tool.input_schema as { required?: string[] }).required, expected[name].required);
  }
}
