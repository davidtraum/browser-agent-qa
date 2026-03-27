#!/usr/bin/env node
import { runRunTestCommand } from '../runTestCommand';

void runRunTestCommand(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`run-test failed: ${message}`);
  process.exitCode = 1;
});

