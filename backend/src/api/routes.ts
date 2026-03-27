import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { getRunTestStatus, runTest, runTestFromIssue } from './runTestController';

export const apiRouter = Router();

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true });
});

apiRouter.post('/run-test', asyncHandler(runTest));
apiRouter.post('/run-test-from-issue', asyncHandler(runTestFromIssue));
apiRouter.get('/run-test/:id', asyncHandler(getRunTestStatus));
