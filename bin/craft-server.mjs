#!/usr/bin/env node
import { CRAFT_SERVER_MANIFEST, serverHelp, startHeadlessServer } from "../src/server-entry.js";

const args = process.argv.slice(2);

try {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(serverHelp());
  } else if (args.includes("--manifest")) {
    console.log(JSON.stringify(CRAFT_SERVER_MANIFEST, null, 2));
  } else {
    await startHeadlessServer({ args });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
