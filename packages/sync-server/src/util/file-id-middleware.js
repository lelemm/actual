import { getAccountDb } from '../account-db.js';
import { FilesService } from '../app-sync/services/files-service.js';

/**
 * Middleware to extract and validate fileId from request headers or body
 * Adds fileId to req.locals if valid
 */
export function extractFileIdMiddleware(req, res, next) {
  // Try to get fileId from different sources
  const fileId =
    req.headers['x-actual-file-id'] || req.body?.fileId || req.query?.fileId;

  if (!fileId) {
    // For some routes, fileId might not be required (e.g., status endpoints)
    // Set to null and continue
    req.locals = req.locals || {};
    req.locals.fileId = null;
    return next();
  }

  if (typeof fileId !== 'string') {
    return res.status(400).json({
      status: 'error',
      reason: 'invalid-file-id',
      message: 'fileId must be a string',
    });
  }

  // Validate that the file exists and user has access
  try {
    const filesService = new FilesService(getAccountDb());
    const file = filesService.get(fileId);

    // Check if user has access to this file
    if (!file) {
      return res.status(404).json({
        status: 'error',
        reason: 'file-not-found',
        message: 'Budget file not found',
      });
    }

    // Check if current user has access to this file
    const userId = res.locals.user_id;
    if (userId && file.owner !== userId) {
      const usersWithAccess = filesService.findUsersWithAccess(fileId);
      const hasAccess = usersWithAccess.some(
        access => access.userId === userId,
      );

      if (!hasAccess) {
        return res.status(403).json({
          status: 'error',
          reason: 'access-denied',
          message: 'Access denied to this budget file',
        });
      }
    }

    // Add fileId to request locals for use in handlers
    req.locals = req.locals || {};
    req.locals.fileId = fileId;
    req.locals.file = file;

    next();
  } catch (error) {
    console.error('Error validating fileId:', error);
    return res.status(500).json({
      status: 'error',
      reason: 'validation-error',
      message: 'Error validating budget file access',
    });
  }
}
