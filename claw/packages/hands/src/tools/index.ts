// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { bash } from "./shell/bash.js";
import { bash_output } from "./shell/bash-output.js";
import { kill_shell } from "./shell/kill-shell.js";
import { wait } from "./shell/wait.js";
import { read } from "./fs/read.js";
import { write } from "./fs/write.js";
import { edit } from "./fs/edit.js";
import { glob } from "./fs/glob.js";
import { grep } from "./fs/grep.js";
import { ls } from "./fs/ls.js";
import { notebookEdit } from "./fs/notebook-edit.js";
import { multiEdit } from "./fs/multi-edit.js";
import { uploadS3 } from "./s3/upload-s3.js";
import { downloadS3 } from "./s3/download-s3.js";
import { logS3UploadManifest } from "./s3/log-s3-upload-manifest.js";

export const tools = [
  bash,
  bash_output,
  kill_shell,
  wait,
  read,
  write,
  edit,
  glob,
  grep,
  ls,
  notebookEdit,
  multiEdit,
  uploadS3,
  downloadS3,
  logS3UploadManifest,
];
