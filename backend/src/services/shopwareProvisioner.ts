import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config';
import { logger } from '../logger';
import type { PreparedShopwareInstance, ProgressEventPayload } from '../types/runTest';
import { ensureShopwareBranchExists } from './shopwareBranches';

const execFileAsync = promisify(execFile);
const ACTIVE_WORKSPACE_STATE = 'active-workspace.json';
const WORKSPACE_MARKER = '.browser-agent-shopware-workspace';
const SHOPWARE_REQUIRED_HOST_PORTS = [8000, 5173, 9998, 9999, 3306, 9080, 8025];

export type ProvisionProgressReporter = (event: ProgressEventPayload) => void | Promise<void>;

const sanitizeBranchName = (branch: string): string => branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-');

const getWorkspaceDirectory = (branch: string): string => {
  const suffix = crypto.createHash('sha1').update(branch).digest('hex').slice(0, 8);
  return path.join(config.shopwareWorkspacesDir, `${sanitizeBranchName(branch)}-${suffix}`);
};

const getActiveWorkspaceStatePath = (): string => path.join(config.shopwareWorkspacesDir, ACTIVE_WORKSPACE_STATE);

const buildPreparedInstance = (branch: string, workspaceDir: string): PreparedShopwareInstance => ({
  branch,
  workspaceDir,
  adminUrl: config.shopwareAdminUrl,
  adminUsername: config.shopwareAdminUsername,
  adminPassword: config.shopwareAdminPassword,
});

const runCommand = async (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    allowFailure?: boolean;
  } = {},
): Promise<string> => {
  logger.info({ command, args, cwd: options.cwd }, 'Running shell command');

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
      env: process.env,
    });

    if (stderr.trim()) {
      logger.debug({ stderr }, 'Shell command emitted stderr');
    }

    return stdout;
  } catch (error) {
    if (options.allowFailure) {
      logger.warn({ err: error, command, args }, 'Ignoring failed shell command');
      return '';
    }

    throw error;
  }
};

const reportProgress = async (
  reporter: ProvisionProgressReporter | undefined,
  event: ProgressEventPayload,
): Promise<void> => {
  logger.info(
    {
      stage: event.stage,
      message: event.message,
      detail: event.detail,
    },
    'Shopware provisioning progress',
  );

  await reporter?.(event);
};

const toCommandError = (command: string, args: string[], code: number | null, stderr: string): Error => {
  const suffix = stderr.trim() ? `\n${stderr.trim()}` : '';
  return new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}.${suffix}`);
};

const extractCommandFailureOutput = (error: unknown): string => {
  if (error instanceof Error) {
    const details = [error.message];
    const maybeStdout = (error as Error & { stdout?: string }).stdout;
    const maybeStderr = (error as Error & { stderr?: string }).stderr;

    if (typeof maybeStdout === 'string' && maybeStdout.trim()) {
      details.push(maybeStdout.trim());
    }
    if (typeof maybeStderr === 'string' && maybeStderr.trim()) {
      details.push(maybeStderr.trim());
    }

    return details.join('\n');
  }

  return String(error);
};

const shouldUseLegacyAdminOnlySetupFallback = (error: unknown): boolean => {
  const output = extractCommandFailureOutput(error);

  return (
    output.includes('npm ci') &&
    output.includes('package.json and package-lock.json') &&
    (output.includes('npm:storefront') || output.includes('init:js'))
  );
};

const createChunkForwarder = (
  stream: 'stdout' | 'stderr',
  onOutput: ((line: string, stream: 'stdout' | 'stderr') => void | Promise<void>) | undefined,
) => {
  let buffer = '';

  return {
    push: (chunk: Buffer | string) => {
      const combined = buffer + chunk.toString();
      const parts = combined.split(/\r\n|\n|\r/g);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const line = part.trim();
        if (line) {
          void onOutput?.(line, stream);
        }
      }
    },
    flush: () => {
      const line = buffer.trim();
      if (line) {
        void onOutput?.(line, stream);
      }
      buffer = '';
    },
  };
};

const runStreamingCommand = async (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    allowFailure?: boolean;
    onOutput?: (line: string, stream: 'stdout' | 'stderr') => void | Promise<void>;
  } = {},
): Promise<string> => {
  logger.info({ command, args, cwd: options.cwd }, 'Running streaming shell command');

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      handler();
    };

    const stdoutForwarder = createChunkForwarder('stdout', options.onOutput);
    const stderrForwarder = createChunkForwarder('stderr', options.onOutput);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      stdoutForwarder.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      stderrForwarder.push(chunk);
    });

    child.on('error', (error) => {
      finish(() => {
        if (options.allowFailure) {
          logger.warn({ err: error, command, args }, 'Ignoring failed streaming shell command');
          resolve(stdout);
          return;
        }

        reject(error);
      });
    });

    child.on('close', (code) => {
      stdoutForwarder.flush();
      stderrForwarder.flush();

      finish(() => {
        if (code === 0 || options.allowFailure) {
          if (code !== 0) {
            logger.warn({ command, args, code }, 'Ignoring non-zero exit code from streaming shell command');
          }
          resolve(stdout);
          return;
        }

        reject(toCommandError(command, args, code, stderr));
      });
    });

    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
      }, options.timeoutMs);
    }
  });
};

const waitForHttpReady = async (url: string, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok || response.status < 500) {
        return;
      }
    } catch {
      // ignore transient startup errors
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 5000);
    });
  }

  throw new Error(`Timed out waiting for Shopware Administration at ${url}.`);
};

const isAdminReady = async (): Promise<boolean> => {
  try {
    const response = await fetch(config.shopwareAdminUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
};

const stopWorkspace = async (workspaceDir: string): Promise<void> => {
  await runCommand('docker', ['compose', 'down', '--remove-orphans'], {
    cwd: workspaceDir,
    timeoutMs: 5 * 60 * 1000,
    allowFailure: true,
  });
};

const workspaceExists = async (workspaceDir: string): Promise<boolean> => {
  try {
    await fs.access(workspaceDir);
    return true;
  } catch {
    return false;
  }
};

const isWorkspaceDockerStackRunning = async (workspaceDir: string): Promise<boolean> => {
  if (!(await workspaceExists(workspaceDir))) {
    return false;
  }

  const rawServices = await runCommand('docker', ['compose', 'ps', '--services', '--status', 'running'], {
    cwd: workspaceDir,
    timeoutMs: 30 * 1000,
    allowFailure: true,
  });

  const runningServices = rawServices
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return runningServices.includes('web');
};

type RunningComposeContainer = {
  id: string;
  ports: string;
  project: string;
  workingDir: string;
};

const parseRunningComposeContainers = (rawOutput: string): RunningComposeContainer[] =>
  rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = '', ports = '', project = '', workingDir = ''] = line.split('\t');
      return {
        id,
        ports,
        project,
        workingDir,
      };
    })
    .filter((entry) => entry.id && entry.project);

const hasConflictingPublishedPort = (ports: string): boolean =>
  SHOPWARE_REQUIRED_HOST_PORTS.some((port) => ports.includes(`:${port}->`));

const stopConflictingComposeContainers = async (
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  const currentProject = path.basename(workspaceDir);
  const rawContainers = await runCommand(
    'docker',
    [
      'ps',
      '--format',
      '{{.ID}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    {
      timeoutMs: 30 * 1000,
      allowFailure: true,
    },
  );

  const conflictingContainers = parseRunningComposeContainers(rawContainers).filter((container) => {
    if (!hasConflictingPublishedPort(container.ports)) {
      return false;
    }

    if (container.project === currentProject) {
      return false;
    }

    return true;
  });

  if (!conflictingContainers.length) {
    return;
  }

  logger.warn(
    {
      workspaceDir,
      conflicts: conflictingContainers.map((container) => ({
        id: container.id,
        project: container.project,
        ports: container.ports,
        workingDir: container.workingDir,
      })),
    },
    'Stopping conflicting Docker Compose containers before provisioning Shopware',
  );

  await reportProgress(progressReporter, {
    stage: 'docker',
    message: 'Stopping conflicting Docker containers before starting Shopware.',
    detail: conflictingContainers
      .map((container) => `${container.project || 'unknown'} (${container.ports || 'no published ports'})`)
      .join(', '),
  });

  await runCommand(
    'docker',
    ['stop', ...conflictingContainers.map((container) => container.id)],
    {
      timeoutMs: 5 * 60 * 1000,
    },
  );
};

const stopActiveWorkspaceIfNeeded = async (
  nextWorkspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  try {
    const rawState = await fs.readFile(getActiveWorkspaceStatePath(), 'utf8');
    const state = JSON.parse(rawState) as { workspaceDir?: string };
    if (state.workspaceDir && state.workspaceDir !== nextWorkspaceDir) {
      await reportProgress(progressReporter, {
        stage: 'docker',
        message: 'Stopping the previously active Shopware workspace.',
        detail: state.workspaceDir,
      });
      await stopWorkspace(state.workspaceDir);
    }
  } catch {
    // no active workspace state yet
  }
};

const ensureWorkspaceRoot = async (): Promise<void> => {
  await fs.mkdir(config.shopwareWorkspacesDir, { recursive: true });
};

const ensureRepositoryCheckout = async (
  branch: string,
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  const gitDir = path.join(workspaceDir, '.git');

  try {
    await fs.access(gitDir);
    await reportProgress(progressReporter, {
      stage: 'checkout',
      message: 'Updating the existing Shopware checkout.',
      detail: workspaceDir,
    });
    await runCommand('git', ['remote', 'set-url', 'origin', config.shopwareRepoUrl], { cwd: workspaceDir });
    await reportProgress(progressReporter, {
      stage: 'pull',
      message: `Fetching latest changes for branch ${branch}.`,
    });
    await runStreamingCommand('git', ['fetch', '--progress', '--depth=1', 'origin', branch], {
      cwd: workspaceDir,
      timeoutMs: 10 * 60 * 1000,
      onOutput: (line) =>
        reportProgress(progressReporter, {
          stage: 'pull',
          message: `Fetching latest changes for branch ${branch}.`,
          detail: line,
        }),
    });
    await reportProgress(progressReporter, {
      stage: 'checkout',
      message: `Checking out branch ${branch}.`,
    });
    await runCommand('git', ['checkout', '-B', branch, 'FETCH_HEAD'], { cwd: workspaceDir });
    await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: workspaceDir });
    await runCommand('git', ['clean', '-fd'], { cwd: workspaceDir, timeoutMs: 5 * 60 * 1000 });
  } catch {
    await reportProgress(progressReporter, {
      stage: 'checkout',
      message: `Cloning Shopware branch ${branch}.`,
      detail: config.shopwareRepoUrl,
    });
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await runStreamingCommand(
      'git',
      ['clone', '--progress', '--depth=1', '--branch', branch, config.shopwareRepoUrl, workspaceDir],
      {
        timeoutMs: 15 * 60 * 1000,
        onOutput: (line) =>
          reportProgress(progressReporter, {
            stage: 'pull',
            message: `Cloning Shopware branch ${branch}.`,
            detail: line,
          }),
      },
    );
  }

  await fs.writeFile(path.join(workspaceDir, WORKSPACE_MARKER), branch, 'utf8');
};

const ensureDockerServicesRunning = async (
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  await reportProgress(progressReporter, {
    stage: 'docker',
    message: 'Preparing Docker services for Shopware.',
    detail: workspaceDir,
  });
  await stopWorkspace(workspaceDir);
  await stopConflictingComposeContainers(workspaceDir, progressReporter);

  await reportProgress(progressReporter, {
    stage: 'docker',
    message: 'Starting the Shopware Docker stack.',
  });
  await runStreamingCommand('docker', ['compose', 'up', '-d'], {
    cwd: workspaceDir,
    timeoutMs: 10 * 60 * 1000,
    onOutput: (line) =>
      reportProgress(progressReporter, {
        stage: 'docker',
        message: 'Starting the Shopware Docker stack.',
        detail: line,
      }),
  });

  const startedAt = Date.now();
  const timeoutMs = 2 * 60 * 1000;

  await reportProgress(progressReporter, {
    stage: 'docker',
    message: 'Waiting for the Shopware web container to become ready.',
  });

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await runCommand('docker', ['compose', 'exec', '-T', 'web', 'php', '-v'], {
        cwd: workspaceDir,
        timeoutMs: 30 * 1000,
      });
      await reportProgress(progressReporter, {
        stage: 'docker',
        message: 'Shopware web container is ready.',
      });
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 5000);
      });
    }
  }

  throw new Error('Timed out waiting for the Shopware web container to become ready.');
};

const runShopwareSetup = async (
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  const setupTimeoutMs = config.shopwareProvisionTimeoutSeconds * 1000;

  try {
    await reportProgress(progressReporter, {
      stage: 'setup',
      message: 'Running Shopware composer setup.',
    });
    await runStreamingCommand('docker', ['compose', 'exec', '-T', 'web', 'composer', 'setup', '--no-interaction'], {
      cwd: workspaceDir,
      timeoutMs: setupTimeoutMs,
      onOutput: (line) =>
        reportProgress(progressReporter, {
          stage: 'setup',
          message: 'Running Shopware composer setup.',
          detail: line,
        }),
    });
    return;
  } catch (error) {
    if (!shouldUseLegacyAdminOnlySetupFallback(error)) {
      throw error;
    }

    await reportProgress(progressReporter, {
      stage: 'setup',
      message: 'Composer setup hit a legacy storefront npm lockfile issue. Falling back to an admin-only setup path.',
      detail: 'Continuing with system install and administration npm install so QA runs can still start.',
    });

    await runStreamingCommand(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'web',
        'php',
        'bin/console',
        'system:install',
        '--drop-database',
        '--basic-setup',
        '--force',
        '--no-assign-theme',
      ],
      {
        cwd: workspaceDir,
        timeoutMs: setupTimeoutMs,
        onOutput: (line) =>
          reportProgress(progressReporter, {
            stage: 'setup',
            message: 'Running Shopware system install fallback.',
            detail: line,
          }),
      },
    );

    await runStreamingCommand(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'web',
        'sh',
        '-lc',
        'cd src/Administration/Resources/app/administration && npm install --no-audit --prefer-offline',
      ],
      {
        cwd: workspaceDir,
        timeoutMs: setupTimeoutMs,
        onOutput: (line) =>
          reportProgress(progressReporter, {
            stage: 'setup',
            message: 'Installing administration npm dependencies for the fallback setup.',
            detail: line,
          }),
      },
    );
  }
};

const runShopwareDemoData = async (
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  await reportProgress(progressReporter, {
    stage: 'setup',
    message: 'Loading Shopware framework demo data.',
  });
  await runStreamingCommand(
    'docker',
    ['compose', 'exec', '-T', 'web', 'bin/console', 'framework:demodata', '--no-interaction'],
    {
      cwd: workspaceDir,
      timeoutMs: config.shopwareProvisionTimeoutSeconds * 1000,
      onOutput: (line) =>
        reportProgress(progressReporter, {
          stage: 'setup',
          message: 'Loading Shopware framework demo data.',
          detail: line,
        }),
    },
  );
};

const startAdministrationWatcher = async (
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<void> => {
  const existingWatcher = await runCommand(
    'docker',
    ['compose', 'exec', '-T', 'web', 'sh', '-lc', 'ps -ef | grep "[c]omposer watch:admin" >/dev/null && echo running || true'],
    {
      cwd: workspaceDir,
      timeoutMs: 30 * 1000,
      allowFailure: true,
    },
  );

  if (existingWatcher.includes('running')) {
    await reportProgress(progressReporter, {
      stage: 'watch',
      message: 'Shopware Administration watcher is already running.',
    });
    return;
  }

  await reportProgress(progressReporter, {
    stage: 'watch',
    message: 'Starting the Shopware Administration watcher.',
  });
  await runCommand('docker', ['compose', 'exec', '-d', 'web', 'composer', 'watch:admin'], {
    cwd: workspaceDir,
    timeoutMs: 60 * 1000,
  });
};

const persistActiveWorkspace = async (workspaceDir: string, branch: string): Promise<void> => {
  await fs.writeFile(
    getActiveWorkspaceStatePath(),
    JSON.stringify(
      {
        branch,
        workspaceDir,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
};

const reusePreparedWorkspaceIfRunning = async (
  branch: string,
  workspaceDir: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<PreparedShopwareInstance | undefined> => {
  if (!(await isWorkspaceDockerStackRunning(workspaceDir))) {
    return undefined;
  }

  if (!(await isAdminReady())) {
    await reportProgress(progressReporter, {
      stage: 'ready',
      message: `Found a running workspace for branch ${branch}, but the administration is not reachable yet.`,
      detail: workspaceDir,
    });
    return undefined;
  }

  await persistActiveWorkspace(workspaceDir, branch);
  await reportProgress(progressReporter, {
    stage: 'ready',
    message: `Reusing the running Shopware workspace for branch ${branch}.`,
    detail: workspaceDir,
  });

  return buildPreparedInstance(branch, workspaceDir);
};

export const prepareShopwareAdministration = async (
  requestedBranch?: string,
  progressReporter?: ProvisionProgressReporter,
): Promise<PreparedShopwareInstance> => {
  const branch = requestedBranch?.trim() || config.shopwareDefaultBranch;
  await reportProgress(progressReporter, {
    stage: 'branch',
    message: `Validating Shopware branch ${branch}.`,
  });
  await ensureShopwareBranchExists(branch);
  await ensureWorkspaceRoot();

  const workspaceDir = getWorkspaceDirectory(branch);

  const runningWorkspace = await reusePreparedWorkspaceIfRunning(branch, workspaceDir, progressReporter);
  if (runningWorkspace) {
    return runningWorkspace;
  }

  try {
    const rawState = await fs.readFile(getActiveWorkspaceStatePath(), 'utf8');
    const state = JSON.parse(rawState) as { branch?: string; workspaceDir?: string };
    if (state.branch === branch && state.workspaceDir === workspaceDir && (await isAdminReady())) {
      await reportProgress(progressReporter, {
        stage: 'ready',
        message: `Reusing the prepared Shopware workspace for branch ${branch}.`,
        detail: workspaceDir,
      });
      return buildPreparedInstance(branch, workspaceDir);
    }
  } catch {
    // no active workspace state yet
  }

  await reportProgress(progressReporter, {
    stage: 'checkout',
    message: `Preparing workspace for Shopware branch ${branch}.`,
    detail: workspaceDir,
  });
  await stopActiveWorkspaceIfNeeded(workspaceDir, progressReporter);
  await ensureRepositoryCheckout(branch, workspaceDir, progressReporter);
  await ensureDockerServicesRunning(workspaceDir, progressReporter);
  await runShopwareSetup(workspaceDir, progressReporter);
  await runShopwareDemoData(workspaceDir, progressReporter);
  await startAdministrationWatcher(workspaceDir, progressReporter);
  await reportProgress(progressReporter, {
    stage: 'ready',
    message: 'Waiting for the Shopware Administration UI to become reachable.',
    detail: config.shopwareAdminUrl,
  });
  await waitForHttpReady(config.shopwareAdminUrl, config.shopwareProvisionTimeoutSeconds * 1000);
  await persistActiveWorkspace(workspaceDir, branch);
  await reportProgress(progressReporter, {
    stage: 'ready',
    message: 'Shopware Administration is reachable.',
    detail: config.shopwareAdminUrl,
  });

  return buildPreparedInstance(branch, workspaceDir);
};
