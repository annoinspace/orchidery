#!/usr/bin/env node
import { serve } from "./index.js";

serve({ root: process.env.ORCHIDERY_ROOT ?? process.cwd() }).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
