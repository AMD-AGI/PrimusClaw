// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The files a prompt carries (`prompt.files`: an image pasted in a chat, a file sent with the message), saved on this
 * machine where the agent can open them, and named in the prompt by their paths: an agent reads a prompt as text, and
 * every agent the connector runs (and a terminal it types into) can open a file by its path.
 *
 * They are kept under the state directory (`uploads/<session>/<message>/<name>`), readable by this user only, and removed
 * when their session is closed, and in any case after UPLOADS_KEEP_MS.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RemotePromptFile } from "./protocol.js";

/** How long saved files are kept once their session no longer needs them. */
export const UPLOADS_KEEP_MS = 7 * 24 * 3600_000;

/** A file saved for a prompt. */
export interface SavedFile {
  path: string;
  media_type: string;
  size: number;
}

/** The folder a session's files go to; `sid` is a Claw session id (a UUID), checked by the caller's lookup. */
function sessionDir(root: string, sid: string): string {
  return path.join(root, sid.replace(/[^A-Za-z0-9-]/g, "_").slice(0, 64));
}

/** Opening a file this way never follows a symbolic link at its last component (0 where the platform has no such flag). */
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Whether `dir` is a folder itself, not a symbolic link to one (nor anything else). */
function plainFolder(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

/** Whether `file` exists as a symbolic link. */
function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Refuses `dir` when it is a symbolic link, or anything but a folder: a file saved through it could land anywhere. */
function ownFolder(dir: string): void {
  if (!plainFolder(dir)) throw new Error(`refused a folder that is not a plain folder: ${dir}`);
}

/**
 * Saves `files` for the prompt `cmdId` of session `sid` under `root`. A name was checked by the wire contract (one path
 * component, no leading dot); it is checked again here, as the path it makes must stay inside the folder. Nothing is
 * written through a symbolic link: the uploads folder, the session's and the prompt's must be plain folders, and a file is opened
 * without following one, so a link put there (by an agent of the session, say) cannot send the bytes elsewhere.
 */
export function savePromptFiles(root: string, sid: string, cmdId: string, files: readonly RemotePromptFile[]): SavedFile[] {
  const session = sessionDir(root, sid);
  const dir = path.join(session, createHash("sha256").update(cmdId).digest("hex").slice(0, 16));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  ownFolder(root); // (each folder before anything is made in it)
  fs.mkdirSync(session, { recursive: true, mode: 0o700 });
  ownFolder(session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ownFolder(dir);
  const saved: SavedFile[] = [];
  for (const f of files) {
    const file = path.join(dir, f.name);
    if (path.dirname(file) !== dir || f.name.startsWith(".")) throw new Error(`refused a file name: ${JSON.stringify(f.name)}`);
    const bytes = Buffer.from(f.data, "base64");
    // (a redelivered prompt finds its files already there: they are the same bytes, written again; a link at the name is
    // refused before the open too, for a platform that has no O_NOFOLLOW)
    if (isLink(file)) throw new Error(`refused a file that is a symbolic link: ${JSON.stringify(f.name)}`);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    saved.push({ path: file, media_type: f.media_type, size: bytes.length });
  }
  return saved;
}

/** `text`, then the lines that say where the files sent with it are. */
export function withSavedFiles(text: string, saved: readonly SavedFile[]): string {
  if (saved.length === 0) return text;
  const lines = saved.map((f) => `- ${f.path} (${f.media_type}, ${f.size} bytes)`);
  return `${text}\n\nFiles sent with this message, saved on this machine (open them by these paths):\n${lines.join("\n")}`;
}

/** `text`, with a line saying the files sent with it could not be saved. */
export function withUnsavedFiles(text: string, count: number, why: string): string {
  return `${text}\n\n(${count} file${count === 1 ? " was" : "s were"} sent with this message but could not be saved on this machine: ${why})`;
}

/** Removes a closed session's files. Best effort; nothing is removed through an uploads folder that is a symbolic link. */
export function dropSessionFiles(root: string, sid: string): void {
  if (!plainFolder(root)) return;
  try { fs.rmSync(sessionDir(root, sid), { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Removes every session folder not written to for `keepMs`. Best effort; nothing is removed through an uploads folder
 * that is a symbolic link (a link inside it is removed as a link, never what it points at).
 */
export function sweepPromptFiles(root: string, now: number, keepMs: number = UPLOADS_KEEP_MS): void {
  if (!plainFolder(root)) return;
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      if (now - fs.statSync(dir).mtimeMs > keepMs) fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}
