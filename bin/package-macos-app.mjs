#!/usr/bin/env node
import { bundleHelp, packageMacosApp } from "../src/macos-bundle.js";

const args = process.argv.slice(2);

try {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(bundleHelp());
  } else {
    await packageMacosApp({ args });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
