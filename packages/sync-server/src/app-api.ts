import express from 'express';
import rateLimit from 'express-rate-limit';

import { getAccountDb, isAdmin } from '#account-db';
import { FileNotFound } from '#app-sync/errors';
import { FilesService } from '#app-sync/services/files-service';
import * as UserService from '#services/user-service';
import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from '#util/middlewares';
import { isValidFileId } from '#util/paths';

import { callMirrorRpc, getMirrorStatus } from './server-access/mirror-manager';
import { SERVER_RPC_METHODS } from './server-access/rpc-methods';

const app = express();
app.use(validateSessionMiddleware);
app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 120,
    legacyHeaders: false,
    standardHeaders: true,
  }),
);

export { app as handlers };

function error(res: express.Response, status: number, reason: string) {
  res.status(status).send({ status: 'error', reason });
}

function accessibleFile(req: express.Request, res: express.Response) {
  const { fileId } = req.params;
  if (typeof fileId !== 'string' || !isValidFileId(fileId)) {
    error(res, 400, 'invalid-file-id');
    return null;
  }
  try {
    const file = new FilesService(getAccountDb()).get(fileId);
    const userId = res.locals.user_id;
    if (
      file.owner !== userId &&
      !isAdmin(userId) &&
      UserService.countUserAccess(file.id, userId) === 0
    ) {
      error(res, 403, 'file-access-not-allowed');
      return null;
    }
    return file;
  } catch (caught) {
    if (caught instanceof FileNotFound) {
      error(res, 404, 'file-not-found');
      return null;
    }
    throw caught;
  }
}

app.get('/files/:fileId/status', async (req, res) => {
  const file = accessibleFile(req, res);
  if (!file) return;
  res.send({
    status: 'ok',
    data: { status: await getMirrorStatus(file) },
  });
});

app.post('/files/:fileId/rpc', async (req, res) => {
  const file = accessibleFile(req, res);
  if (!file) return;
  const { method, args } = req.body || {};
  if (
    typeof method !== 'string' ||
    !SERVER_RPC_METHODS.has(method) ||
    !Array.isArray(args)
  ) {
    error(res, 400, 'invalid-rpc-call');
    return;
  }
  if (!file.serverAccessEnabled) {
    error(res, 503, 'mirror-unavailable');
    return;
  }

  try {
    const data = await callMirrorRpc(file.id, method, args);
    res.send({ status: 'ok', data });
  } catch (caught) {
    if (caught instanceof Error && caught.message === 'mirror-unavailable') {
      error(res, 503, 'mirror-unavailable');
    } else if (
      caught instanceof Error &&
      (caught.message === 'mirror-command-timeout' ||
        caught.message === 'mirror-process-exited')
    ) {
      error(res, 503, 'mirror-unavailable');
    } else {
      error(res, 400, 'rpc-failed');
    }
  }
});

app.use(errorMiddleware);
