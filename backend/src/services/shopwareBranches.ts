import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config';
import type { ShopwareBranchInfo } from '../types/runTest';

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5 * 60 * 1000;

let branchCache: {
  expiresAt: number;
  branches: ShopwareBranchInfo[];
} | null = null;

const parseLsRemoteOutput = (stdout: string): ShopwareBranchInfo[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commitSha, ref] = line.split('\t');
      const name = ref.replace('refs/heads/', '');
      return {
        name,
        commitSha,
      };
    })
    .sort((left, right) => {
      if (left.name === config.shopwareDefaultBranch) {
        return -1;
      }

      if (right.name === config.shopwareDefaultBranch) {
        return 1;
      }

      return left.name.localeCompare(right.name);
    });

const loadBranchesFromRemote = async (): Promise<ShopwareBranchInfo[]> => {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-remote', '--heads', config.shopwareRepoUrl],
    {
      maxBuffer: 1024 * 1024 * 8,
    },
  );

  return parseLsRemoteOutput(stdout);
};

const getAllShopwareBranches = async (): Promise<ShopwareBranchInfo[]> => {
  if (branchCache && branchCache.expiresAt > Date.now()) {
    return branchCache.branches;
  }

  const branches = await loadBranchesFromRemote();
  branchCache = {
    branches,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  return branches;
};

export const listShopwareBranches = async (query?: string, limit = 50): Promise<ShopwareBranchInfo[]> => {
  const normalizedQuery = query?.trim().toLowerCase();
  const branches = await getAllShopwareBranches();

  if (!normalizedQuery) {
    return branches.slice(0, limit);
  }

  return branches
    .filter((branch) => branch.name.toLowerCase().includes(normalizedQuery))
    .slice(0, limit);
};

export const ensureShopwareBranchExists = async (branchName: string): Promise<ShopwareBranchInfo> => {
  const normalizedName = branchName.trim();
  const branches = await getAllShopwareBranches();
  const exact = branches.find((branch) => branch.name === normalizedName);

  if (!exact) {
    throw new Error(`Shopware branch "${normalizedName}" does not exist.`);
  }

  return exact;
};

