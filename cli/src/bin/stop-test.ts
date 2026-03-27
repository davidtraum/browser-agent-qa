#!/usr/bin/env node

import { runStopTestCommand } from '../stopTestCommand';

void runStopTestCommand(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
