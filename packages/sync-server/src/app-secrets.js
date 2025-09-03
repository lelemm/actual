import express from 'express';

import { getAccountDb, isAdmin } from './account-db.js';
import { secretsService } from './services/secrets-service.js';
import { extractFileIdMiddleware } from './util/file-id-middleware.js';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares.js';

const app = express();

export { app as handlers };
app.use(express.json());
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);
app.use(extractFileIdMiddleware);

app.get('/', async (req, res) => {
  try {
    const fileId = req.locals.fileId;
    const secrets = secretsService.list(fileId);
    res.status(200).json({ status: 'ok', data: secrets });
  } catch (error) {
    console.error('Failed to list secrets:', error);
    res.status(500).send({
      status: 'error',
      reason: 'database-error',
      details: 'Failed to list secrets',
    });
  }
});

app.post('/', async (req, res) => {
  let method;
  try {
    const result = getAccountDb().first(
      'SELECT method FROM auth WHERE active = 1',
    );
    method = result?.method;
  } catch (error) {
    console.error('Failed to fetch auth method:', error);
    return res.status(500).send({
      status: 'error',
      reason: 'database-error',
      details: 'Failed to validate authentication method',
    });
  }
  const { name, value } = req.body || {};

  if (method === 'openid') {
    const canSaveSecrets = isAdmin(res.locals.user_id);

    if (!canSaveSecrets) {
      res.status(403).send({
        status: 'error',
        reason: 'not-admin',
        details: 'You have to be admin to set secrets',
      });
      return;
    }
  }

  const fileId = req.locals.fileId;
  secretsService.set(name, value, fileId);

  res.status(200).send({ status: 'ok' });
});

app.get('/:name', async (req, res) => {
  const name = req.params.name;
  const fileId = req.locals.fileId;
  const keyExists = secretsService.exists(name, fileId);
  if (keyExists) {
    res.sendStatus(204);
  } else {
    res.status(404).send('key not found');
  }
});

app.delete('/:name', async (req, res) => {
  let method;
  try {
    const result = getAccountDb().first(
      'SELECT method FROM auth WHERE active = 1',
    );
    method = result?.method;
  } catch (error) {
    console.error('Failed to fetch auth method:', error);
    return res.status(500).send({
      status: 'error',
      reason: 'database-error',
      details: 'Failed to validate authentication method',
    });
  }

  console.log('method', method);
  if (method === 'openid') {
    const canSaveSecrets = isAdmin(res.locals.user_id);

    console.log('canSaveSecrets', canSaveSecrets);

    if (!canSaveSecrets) {
      res.status(403).send({
        status: 'error',
        reason: 'not-admin',
        details: 'You have to be admin to delete secrets',
      });
      return;
    }
  }

  const name = req.params.name;
  const fileId = req.locals.fileId;
  console.log('name', req.params.name);
  console.log('fileId', fileId);

  try {
    secretsService.delete(name, fileId);
    console.log('secretsService.delete', name, fileId);
    res.status(200).send({ status: 'ok' });
  } catch (error) {
    console.error('Failed to delete secret:', error);
    res.status(500).send({
      status: 'error',
      reason: 'database-error',
      details: 'Failed to delete secret',
    });
  }
});
