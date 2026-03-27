#!/usr/bin/env node
import { runTestStatusCommand } from '../testStatusCommand';

void runTestStatusCommand(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`test-status failed: ${message}`);
  process.exitCode = 1;
});

