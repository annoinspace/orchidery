#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
