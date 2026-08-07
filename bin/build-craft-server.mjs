#!/usr/bin/env node
import { buildCraftServer, buildHelp } from "../src/server-build.js";

const args = process.argv.slice(2);

try {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(buildHelp());
  } else {
    await buildCraftServer({ args });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
