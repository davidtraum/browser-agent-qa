#!/usr/bin/env node

import { runListTasksCommand } from '../listTasksCommand';

void runListTasksCommand(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
