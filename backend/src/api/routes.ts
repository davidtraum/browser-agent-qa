import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import {
  clearFinishedTasks,
  getManagedTasks,
  getRunTestStatus,
  getShopwareBranches,
  runTest,
  runTestFromIssue,
  runTestFromIssueStream,
  stopManagedTask,
} from './runTestController';

export const apiRouter = Router();

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true });
});

apiRouter.get('/shopware/branches', asyncHandler(getShopwareBranches));
apiRouter.get('/tasks', asyncHandler(getManagedTasks));
apiRouter.post('/tasks/clear-finished', asyncHandler(clearFinishedTasks));
apiRouter.post('/tasks/:id/stop', asyncHandler(stopManagedTask));
apiRouter.post('/run-test', asyncHandler(runTest));
apiRouter.post('/run-test-from-issue', asyncHandler(runTestFromIssue));
apiRouter.post('/run-test-from-issue/stream', asyncHandler(runTestFromIssueStream));
apiRouter.get('/run-test/:id', asyncHandler(getRunTestStatus));
