#!/usr/bin/env node
import { importYuuMiraResources, parseImportOptions, resourceImportHelp } from "../src/resource-import.js";

try {
  const options = parseImportOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(resourceImportHelp());
    process.exit(0);
  }
  const result = await importYuuMiraResources({ args: process.argv.slice(2) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
