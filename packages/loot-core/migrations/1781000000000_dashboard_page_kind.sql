ALTER TABLE dashboard_pages ADD COLUMN kind TEXT DEFAULT 'reports';
UPDATE dashboard_pages SET kind = 'reports' WHERE kind IS NULL;
