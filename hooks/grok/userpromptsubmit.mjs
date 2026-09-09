#!/usr/bin/env node
import "./platform.mjs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const hookDir = dirname(fileURLToPath(import.meta.url));
const shared = resolve(hookDir, "..", "userpromptsubmit.mjs");
const child = spawn(process.execPath, [shared], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
