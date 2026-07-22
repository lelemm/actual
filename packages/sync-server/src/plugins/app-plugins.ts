import express from 'express';
import type { Request, Response } from 'express';

import { errorMiddleware, requestLoggerMiddleware } from '#util/middlewares';

import { checkAuth, extractUserFromHeaders } from './auth-checker.js';
import type { AuthLevel } from './auth-checker.js';
import { createPluginMiddleware } from './plugin-middleware.js';
import { pluginManager } from './plugins-bootstrap.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLoggerMiddleware);

export { app as handlers };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requirePluginAuth(
  req: Request,
  res: Response,
  authLevel: AuthLevel = 'authenticated',
): Promise<boolean> {
  const user = await extractUserFromHeaders(req.headers);
  const authCheck = checkAuth(user, authLevel);
  if (authCheck.allowed === false) {
    res.status(authCheck.status).json({
      status: 'error',
      error: authCheck.error,
      reason: authCheck.message,
    });
    return false;
  }

  return true;
}

function sendPluginError(res: Response, error: unknown): void {
  res.status(500).json({
    status: 'error',
    reason: getErrorMessage(error),
  });
}

app.get('/list', async (req, res) => {
  if (!(await requirePluginAuth(req, res))) return;

  try {
    res.json({
      status: 'ok',
      data: {
        plugins: pluginManager.getInstalledPluginManifests(),
      },
    });
  } catch (error) {
    sendPluginError(res, error);
  }
});

app.use(createPluginMiddleware(pluginManager));

app.use(errorMiddleware);
