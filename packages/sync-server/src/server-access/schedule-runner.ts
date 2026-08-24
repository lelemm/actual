import { getAccountDb } from '#account-db';
import { FilesService, FileUpdate } from '#app-sync/services/files-service';
import type { RawFile } from '#app-sync/services/files-service';

import { runMirrorSchedules } from './mirror-manager';

const running = new Set<string>();

export function dayInTimeZone(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function runDueScheduleAutomation(now = new Date()) {
  const filesService = new FilesService(getAccountDb());
  const rows = getAccountDb().all(
    `SELECT * FROM files
     WHERE deleted = 0
       AND server_access_enabled = 1
       AND automation_timezone IS NOT NULL`,
  ) as RawFile[];

  await Promise.all(
    rows.map(async row => {
      const file = filesService.validate(row);
      if (!file.automationTimeZone || running.has(file.id)) return;
      const day = dayInTimeZone(now, file.automationTimeZone);
      if (file.automationLastRun === day) return;

      running.add(file.id);
      try {
        await runMirrorSchedules(file.id);
        filesService.update(
          file.id,
          new FileUpdate({ automationLastRun: day }),
        );
      } catch {
        // Leave the day unrecorded so the next tick retries safely.
      } finally {
        running.delete(file.id);
      }
    }),
  );
}

export function startScheduleAutomation() {
  void runDueScheduleAutomation();
  const timer = setInterval(() => void runDueScheduleAutomation(), 60_000);
  timer.unref();
}
