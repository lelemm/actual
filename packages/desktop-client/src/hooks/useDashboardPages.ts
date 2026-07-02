import type {
  DashboardPageKind,
  DashboardPageEntity,
  DashboardWidgetEntity,
} from '@actual-app/core/types/models';
import { useQuery } from '@tanstack/react-query';

import { dashboardQueries } from '#reports';

export function useDashboardPages(kind?: DashboardPageKind) {
  return useQuery(dashboardQueries.listDashboardPages(kind));
}

export function useDashboardPageWidgets<W extends DashboardWidgetEntity>(
  dashboardPageId?: DashboardPageEntity['id'] | null,
) {
  return useQuery(
    dashboardQueries.listDashboardPageWidgets<W>(dashboardPageId),
  );
}
