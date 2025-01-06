// @ts-strict-ignore
import { useEffect, useState } from 'react';

import { type ThemeDefinition } from '../../../plugins-shared/src';
import { useActualPlugins } from '../components/ActualPluginsProvider';
import { useGlobalPref } from '../hooks/useGlobalPref';
import { themes } from 'actual-components/src/style';
import * as developmentTheme from 'actual-components/src/style/themes/development';
import { isNonProductionEnvironment } from 'loot-core/shared/environment';

const themesComplete = {
  ...themes,
  ...(isNonProductionEnvironment() && {
    development: { name: 'Development', colors: developmentTheme },
  }),
};

export * from 'actual-components/src/style';

export function useTheme() {
  const [theme = 'auto', setThemePref] = useGlobalPref('theme');
  const [customTheme, setCustomTheme] = useGlobalPref('customTheme');
  return [theme, setThemePref, customTheme, setCustomTheme] as const;
}

export function usePreferredDarkTheme() {
  const [darkTheme = 'dark', setDarkTheme] =
    useGlobalPref('preferredDarkTheme');
  return [darkTheme, setDarkTheme] as const;
}

export function ThemeStyle() {
  const [theme, , customTheme] = useTheme();
  const [themesExtended, setThemesExtended] = useState(themesComplete);

  const [darkThemePreference] = usePreferredDarkTheme();
  const [themeColors, setThemeColors] = useState<ThemeDefinition | undefined>(
    undefined,
  );

  const { plugins: loadedPlugins } = useActualPlugins();

  useEffect(() => {
    const customThemes =
      loadedPlugins?.reduce((acc, plugin) => {
        if (plugin.availableThemes?.()?.length) {
          plugin.availableThemes().forEach(theme => {
            acc[theme] = {
              name: theme,
              colors: plugin.getThemeSchema(theme),
            };
          });
        }
        return acc;
      }, {}) ?? {};

    setThemesExtended({ ...themesComplete, ...customThemes });
  }, [loadedPlugins]);

  useEffect(() => {
    if (customTheme) {
      setThemeColors(JSON.parse(customTheme).colors);
      return;
    }

    if (theme === 'auto') {
      const darkTheme = themesExtended[darkThemePreference];

      function darkThemeMediaQueryListener(event: MediaQueryListEvent) {
        if (event.matches) {
          setThemeColors(darkTheme.colors);
        } else {
          setThemeColors(themesExtended['light'].colors);
        }
      }
      const darkThemeMediaQuery = window.matchMedia(
        '(prefers-color-scheme: dark)',
      );

      darkThemeMediaQuery.addEventListener(
        'change',
        darkThemeMediaQueryListener,
      );

      if (darkThemeMediaQuery.matches) {
        setThemeColors(darkTheme.colors);
      } else {
        setThemeColors(themesExtended['light'].colors);
      }

      return () => {
        darkThemeMediaQuery.removeEventListener(
          'change',
          darkThemeMediaQueryListener,
        );
      };
    } else {
      setThemeColors(themesExtended[theme].colors);
    }
  }, [theme, darkThemePreference, themesExtended, customTheme]);

  if (!themeColors) return null;

  const css = Object.keys(themeColors)
    .map(key => `  --color-${key}: ${themeColors[key]};`)
    .join('\n');
  return <style>{`:root {\n${css}}`}</style>;
}
