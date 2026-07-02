import { send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import type {
  CustomReportEntity,
  DashboardPageKind,
  DashboardPageEntity,
  DashboardWidgetEntity,
} from '@actual-app/core/types/models';
import { queryOptions } from '@tanstack/react-query';

import { aqlQuery } from '#queries/aqlQuery';

export const reportQueries = {
  all: () => ['reports'],
  lists: () => [...reportQueries.all(), 'lists'],
  list: () =>
    queryOptions<CustomReportEntity[]>({
      queryKey: [...reportQueries.lists()],
      queryFn: async () => {
        return await send('report/get');
      },
    }),
};

export const dashboardQueries = {
  all: () => ['dashboards'],
  lists: () => [...dashboardQueries.all(), 'lists'],
  listDashboardWidgets: <T extends DashboardWidgetEntity>() =>
    queryOptions<T[]>({
      queryKey: [...dashboardQueries.lists(), 'widgets'],
      queryFn: async () => {
        const { data }: { data: T[] } = await aqlQuery(
          q('dashboard').select('*'),
        );
        return data;
      },
    }),
  listDashboardPageWidgets: <T extends DashboardWidgetEntity>(
    dashboardPageId?: DashboardPageEntity['id'] | null,
  ) =>
    queryOptions<T[]>({
      ...dashboardQueries.listDashboardWidgets<T>(),
      select: widgets =>
        widgets.filter(w => w.dashboard_page_id === dashboardPageId),
      enabled: !!dashboardPageId,
    }),
  listDashboardPages: (kind: DashboardPageKind = 'reports') =>
    queryOptions<DashboardPageEntity[]>({
      queryKey: [...dashboardQueries.lists(), 'pages', kind],
      queryFn: async () => {
        const data: DashboardPageEntity[] = await send('dashboard-list-pages', {
          kind,
        });
        return data.map(page => ({
          ...page,
          kind: page.kind ?? 'reports',
          name: page.name ?? '',
        }));
      },
    }),
};
