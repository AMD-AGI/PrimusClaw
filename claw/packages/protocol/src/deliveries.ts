// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A file the agent handed to the user with `deliver_file`.
 *
 * Brain copies the file out of the sandbox to `<session prefix>.deliveries/<id>/<name>`
 * and says so on the tool's terminal `toolUsed` event (`delivery`); the API serves
 * it at `GET /v1/sessions/:id/deliveries/:id` to the signed-in owner. The copy is
 * the file as it was when it was delivered: the workspace file may change or go
 * afterwards, and the link still gives what the user was told they got.
 *
 * One definition because the writer is Brain and the reader is the API, and the
 * directory name decides what the sync leaves alone on both sides.
 */

/** The directory under the session prefix that holds delivered copies. */
export const DELIVERY_DIR = ".deliveries";

/** What the terminal `toolUsed` event of a `deliver_file` call carries. */
export interface Delivery {
  /** Random UUID; the second half of the download route. */
  id: string;
  /** The file's base name, as delivered. */
  name: string;
  /** Bytes. */
  size: number;
  /** Decided from the name (`deliveryContentType`): the store keeps no type of its own. */
  content_type: string;
  /** One line the agent wrote to go with the file; absent when it wrote none. */
  caption?: string;
}

/** A delivery id is a v4-shaped UUID and nothing else: it becomes part of an object key. */
export const DELIVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<session prefix>` + this + `<name>` is the object a delivery is stored as. */
export function deliveryKeyPrefix(sessionPrefix: string, id: string): string {
  return `${sessionPrefix}${DELIVERY_DIR}/${id}/`;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The media type a delivered file is served as, from its extension; anything unknown is a plain download. */
export function deliveryContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
