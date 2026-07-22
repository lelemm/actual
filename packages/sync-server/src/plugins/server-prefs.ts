import { getServerPrefs, setServerPrefs } from '#account-db';

export const PLUGINS_FLAG_PREF = 'flags.plugins';

export function arePluginsEnabled(): boolean {
  return getServerPrefs()[PLUGINS_FLAG_PREF] === 'true';
}

export function setPluginsEnabled(enabled: boolean): void {
  setServerPrefs({
    [PLUGINS_FLAG_PREF]: enabled ? 'true' : 'false',
  });
}
