import { beforeEach, describe, expect, it } from 'vitest';

import { runHandler } from '#server/mutators';
import type { DashboardWidgetEntity } from '#types/models';

import { isWidgetType } from './app';
import { app } from './app';

function allWidgetTypes<T extends DashboardWidgetEntity['type'][]>(
  ...types: T &
    (DashboardWidgetEntity['type'] extends T[number] ? unknown : never)
): T {
  return types;
}

const ALL_WIDGET_TYPES = allWidgetTypes(
  'net-worth-card',
  'cash-flow-card',
  'spending-card',
  'crossover-card',
  'budget-analysis-card',
  'markdown-card',
  'summary-card',
  'calendar-card',
  'formula-card',
  'custom-report',
  'sankey-card',
  'balance-forecast-card',
  'age-of-money-card',
  'accounts-all-card',
  'accounts-on-budget-card',
  'accounts-off-budget-card',
  'accounts-add-card',
);

describe('isWidgetType', () => {
  it('all known widget types should be recognized', () => {
    for (const type of ALL_WIDGET_TYPES) {
      expect(isWidgetType(type)).toBe(true);
    }
  });

  it('unknown widget types should be rejected', () => {
    expect(isWidgetType('unknown-card')).toBe(false);
  });
});

describe('dashboard page kind', () => {
  beforeEach(global.emptyDatabase());

  it('keeps reports pages and sidebar options pages in separate lists', async () => {
    await runHandler(app.handlers['dashboard-create'], {
      name: 'Reports page',
      kind: 'reports',
    });
    await runHandler(app.handlers['dashboard-create'], {
      name: 'Sidebar page',
      kind: 'sidebar-options',
    });

    const reportsPages = await runHandler(
      app.handlers['dashboard-list-pages'],
      {
        kind: 'reports',
      },
    );
    const sidebarPages = await runHandler(
      app.handlers['dashboard-list-pages'],
      {
        kind: 'sidebar-options',
      },
    );

    expect(reportsPages.map(page => page.name)).toContain('Reports page');
    expect(reportsPages.map(page => page.name)).not.toContain('Sidebar page');
    expect(sidebarPages.map(page => page.name)).toEqual(['Sidebar page']);
  });

  it('blocks deleting the last page per kind independently', async () => {
    await runHandler(app.handlers['dashboard-create'], {
      name: 'Reports A',
      kind: 'reports',
    });
    const reportB = await runHandler(app.handlers['dashboard-create'], {
      name: 'Reports B',
      kind: 'reports',
    });
    const sidebarA = await runHandler(app.handlers['dashboard-create'], {
      name: 'Sidebar A',
      kind: 'sidebar-options',
    });
    const sidebarB = await runHandler(app.handlers['dashboard-create'], {
      name: 'Sidebar B',
      kind: 'sidebar-options',
    });

    for (const page of await runHandler(app.handlers['dashboard-list-pages'], {
      kind: 'reports',
    })) {
      if (page.id !== reportB) {
        await runHandler(app.handlers['dashboard-delete'], {
          id: page.id,
          kind: 'reports',
        });
      }
    }
    await runHandler(app.handlers['dashboard-delete'], {
      id: sidebarA,
      kind: 'sidebar-options',
    });

    await expect(
      runHandler(app.handlers['dashboard-delete'], {
        id: reportB,
        kind: 'reports',
      }),
    ).rejects.toThrow('Cannot delete the last dashboard page');
    await expect(
      runHandler(app.handlers['dashboard-delete'], {
        id: sidebarB,
        kind: 'sidebar-options',
      }),
    ).rejects.toThrow('Cannot delete the last dashboard page');
  });
});
