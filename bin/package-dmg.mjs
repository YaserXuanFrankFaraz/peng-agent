#!/usr/bin/env node
import { dmgHelp, packageDmg } from "../src/dmg.js";

const args = process.argv.slice(2);

try {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(dmgHelp());
  } else {
    await packageDmg({ args });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
