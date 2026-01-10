import request from 'supertest';

import { handlers as app } from './app-secrets.js';
import { secretsService } from './services/secrets-service.js';
describe('secretsService', () => {
  const testSecretName = 'testSecret';
  const testSecretValue = 'testValue';

  it('should set a secret', () => {
    const result = secretsService.set(testSecretName, testSecretValue);
    expect(result).toBeDefined();
    expect(result.changes).toBe(1);
  });

  it('should get a secret', () => {
    const result = secretsService.get(testSecretName);
    expect(result).toBeDefined();
    expect(result).toBe(testSecretValue);
  });

  it('should check if a secret exists', () => {
    const exists = secretsService.exists(testSecretName);
    expect(exists).toBe(true);

    const nonExistent = secretsService.exists('nonExistentSecret');
    expect(nonExistent).toBe(false);
  });

  it('should update a secret', () => {
    const newValue = 'newValue';
    const setResult = secretsService.set(testSecretName, newValue);
    expect(setResult).toBeDefined();
    expect(setResult.changes).toBe(1);

    const getResult = secretsService.get(testSecretName);
    expect(getResult).toBeDefined();
    expect(getResult).toBe(newValue);
  });

  describe('file-scoped secrets', () => {
    const fileId1 = 'test-file-id-1';
    const fileId2 = 'test-file-id-2';
    const scopedSecretName = 'scopedSecret';
    const scopedSecretValue = 'scopedValue';

    it('should set a file-scoped secret', () => {
      const result = secretsService.set(scopedSecretName, scopedSecretValue, {
        fileId: fileId1,
      });
      expect(result).toBeDefined();
      expect(result.changes).toBe(1);
    });

    it('should get a file-scoped secret', () => {
      secretsService.set(scopedSecretName, scopedSecretValue, {
        fileId: fileId1,
      });
      const result = secretsService.get(scopedSecretName, { fileId: fileId1 });
      expect(result).toBeDefined();
      expect(result).toBe(scopedSecretValue);
    });

    it('should check if a file-scoped secret exists', () => {
      secretsService.set(scopedSecretName, scopedSecretValue, {
        fileId: fileId1,
      });
      const exists = secretsService.exists(scopedSecretName, {
        fileId: fileId1,
      });
      expect(exists).toBe(true);
    });

    it('should NOT fallback to global when file-scoped secret does not exist', () => {
      // Set a global secret
      secretsService.set('fallbackTest', 'globalValue');

      // Try to get it as file-scoped - should not find it
      const result = secretsService.get('fallbackTest', { fileId: fileId1 });
      expect(result).toBeNull();

      // Verify it doesn't exist in file scope
      const exists = secretsService.exists('fallbackTest', { fileId: fileId1 });
      expect(exists).toBe(false);

      // Verify it still exists globally
      const globalExists = secretsService.exists('fallbackTest');
      expect(globalExists).toBe(true);
    });

    it('should keep file-scoped secrets separate per fileId', () => {
      const secretName = 'separateSecret';

      // Set different values for different files
      secretsService.set(secretName, 'valueForFile1', { fileId: fileId1 });
      secretsService.set(secretName, 'valueForFile2', { fileId: fileId2 });

      // Get and verify they're different
      const value1 = secretsService.get(secretName, { fileId: fileId1 });
      const value2 = secretsService.get(secretName, { fileId: fileId2 });

      expect(value1).toBe('valueForFile1');
      expect(value2).toBe('valueForFile2');
    });

    it('should keep global and file-scoped secrets separate', () => {
      const secretName = 'mixedScopeSecret';

      // Set both global and file-scoped with same name
      secretsService.set(secretName, 'globalValue');
      secretsService.set(secretName, 'fileValue', { fileId: fileId1 });

      // Verify they're both stored and independent
      const globalValue = secretsService.get(secretName);
      const fileValue = secretsService.get(secretName, { fileId: fileId1 });

      expect(globalValue).toBe('globalValue');
      expect(fileValue).toBe('fileValue');
    });
  });

  describe('secrets api', () => {
    it('returns 401 if the user is not authenticated', async () => {
      secretsService.set(testSecretName, testSecretValue);
      const res = await request(app).get(`/${testSecretName}`);

      expect(res.statusCode).toEqual(401);
      expect(res.body).toEqual({
        details: 'token-not-found',
        reason: 'unauthorized',
        status: 'error',
      });
    });

    it('returns 404 if secret does not exist', async () => {
      const res = await request(app)
        .get(`/thiskeydoesnotexist`)
        .set('x-actual-token', 'valid-token');

      expect(res.statusCode).toEqual(404);
    });

    it('returns 204 if secret exists', async () => {
      secretsService.set(testSecretName, testSecretValue);
      const res = await request(app)
        .get(`/${testSecretName}`)
        .set('x-actual-token', 'valid-token');

      expect(res.statusCode).toEqual(204);
    });

    it('returns 200 if secret was set', async () => {
      secretsService.set(testSecretName, testSecretValue);
      const res = await request(app)
        .post(`/`)
        .set('x-actual-token', 'valid-token')
        .send({ name: testSecretName, value: testSecretValue });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({
        status: 'ok',
      });
    });

    it('should set file-scoped secret via API', async () => {
      const fileId = 'test-file-api';
      const res = await request(app)
        .post(`/`)
        .set('x-actual-token', 'valid-token')
        .send({ name: 'apiSecret', value: 'apiValue', fileId });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ status: 'ok' });

      // Verify it was stored with file scope
      const value = secretsService.get('apiSecret', { fileId });
      expect(value).toBe('apiValue');
    });

    it('should check file-scoped secret exists via API with query param', async () => {
      const fileId = 'test-file-query';
      secretsService.set('querySecret', 'queryValue', { fileId });

      const res = await request(app)
        .get(`/querySecret?fileId=${fileId}`)
        .set('x-actual-token', 'valid-token');

      expect(res.statusCode).toEqual(204);
    });

    it('should check file-scoped secret exists via API with header', async () => {
      const fileId = 'test-file-header';
      secretsService.set('headerSecret', 'headerValue', { fileId });

      const res = await request(app)
        .get(`/headerSecret`)
        .set('x-actual-token', 'valid-token')
        .set('x-actual-file-id', fileId);

      expect(res.statusCode).toEqual(204);
    });

    it('should return 404 for file-scoped secret that does not exist', async () => {
      const fileId = 'test-file-notfound';

      const res = await request(app)
        .get(`/nonExistentFileSecret?fileId=${fileId}`)
        .set('x-actual-token', 'valid-token');

      expect(res.statusCode).toEqual(404);
    });
  });
});
