import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogTrigger } from 'react-aria-components';
import { ErrorBoundary } from 'react-error-boundary';
import ReactGridLayout from 'react-grid-layout';
import type { Layout } from 'react-grid-layout';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { SvgAdd, SvgCheveronDown } from '@actual-app/components/icons/v1';
import { Menu } from '@actual-app/components/menu';
import type { MenuItem } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type {
  AccountsWidget,
  CustomReportWidget,
  DashboardWidgetEntity,
  MarkdownWidget,
} from '@actual-app/core/types/models';
import { css } from '@emotion/css';

import '../reports/overview.scss';
import { NON_DRAGGABLE_AREA_CLASS_NAME } from '#components/reports/constants';
import { ReportCard } from '#components/reports/ReportCard';
import { AgeOfMoneyCard } from '#components/reports/reports/AgeOfMoneyCard';
import { BalanceForecastCard } from '#components/reports/reports/BalanceForecastCard';
import { BudgetAnalysisCard } from '#components/reports/reports/BudgetAnalysisCard';
import { CalendarCard } from '#components/reports/reports/CalendarCard';
import { CashFlowCard } from '#components/reports/reports/CashFlowCard';
import { CrossoverCard } from '#components/reports/reports/CrossoverCard';
import { CustomReportListCards } from '#components/reports/reports/CustomReportListCards';
import { FormulaCard } from '#components/reports/reports/FormulaCard';
import { MarkdownCard } from '#components/reports/reports/MarkdownCard';
import { MissingReportCard } from '#components/reports/reports/MissingReportCard';
import { NetWorthCard } from '#components/reports/reports/NetWorthCard';
import { SankeyCard } from '#components/reports/reports/SankeyCard';
import { SpendingCard } from '#components/reports/reports/SpendingCard';
import { SummaryCard } from '#components/reports/reports/SummaryCard';
import { useAccounts } from '#hooks/useAccounts';
import {
  useDashboardPages,
  useDashboardPageWidgets,
} from '#hooks/useDashboardPages';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useReports } from '#hooks/useReports';
import { useResizeObserver } from '#hooks/useResizeObserver';
import { useSyncedPref } from '#hooks/useSyncedPref';
import {
  useAddDashboardWidgetMutation,
  useCreateDashboardPageMutation,
  useDeleteDashboardPageMutation,
  useRemoveDashboardWidgetMutation,
  useUpdateDashboardWidgetMutation,
  useUpdateDashboardWidgetsMutation,
} from '#reports/mutations';

import { Accounts } from './Accounts';

const SIDEBAR_DASHBOARD_KIND = 'sidebar-options';
const GRID_COLUMNS = 10;
const ROW_HEIGHT = 18;
const SMALL_ACCOUNT_WIDGET_HEIGHT = 2;
const ACCOUNT_LIST_WIDGET_HEIGHT = 5;
const SWIPE_THRESHOLD = 35;
const palette = {
  page: '#07111C',
  panel: '#102337',
  panelAlt: '#173047',
  panelRaised: '#1B3850',
  line: '#2B4861',
  lineStrong: '#42617B',
  text: '#EAF2FA',
  textMuted: '#A9BAD0',
  month: '#5B6CFF',
  muted: '#7F95AA',
};
const ACCOUNT_WIDGETS = [
  'accounts-all-card',
  'accounts-on-budget-card',
  'accounts-off-budget-card',
  'accounts-add-card',
] as const;

type AccountWidgetType = (typeof ACCOUNT_WIDGETS)[number];

function getSidebarWidgetMinWidth(widget: DashboardWidgetEntity) {
  if (
    widget.type === 'formula-card' ||
    ACCOUNT_WIDGETS.includes(widget.type as AccountWidgetType)
  ) {
    return 1;
  }

  if (widget.type === 'custom-report' || widget.type === 'markdown-card') {
    return 2;
  }

  return 3;
}

function clampGridItem({
  x,
  width,
  minWidth = 1,
}: {
  x: number;
  width: number;
  minWidth?: number;
}) {
  const clampedWidth = Math.min(Math.max(width, minWidth), GRID_COLUMNS);

  return {
    x: Math.min(Math.max(x, 0), GRID_COLUMNS - clampedWidth),
    width: clampedWidth,
  };
}

function getNextSidebarWidgetY(widgets: DashboardWidgetEntity[]) {
  return widgets.reduce(
    (bottom, widget) => Math.max(bottom, widget.y + widget.height),
    0,
  );
}

function getAccountWidgetHeight(type: AccountWidgetType) {
  return type === 'accounts-on-budget-card' ||
    type === 'accounts-off-budget-card'
    ? ACCOUNT_LIST_WIDGET_HEIGHT
    : SMALL_ACCOUNT_WIDGET_HEIGHT;
}

function getDefaultAccountWidgets(dashboardPageId: string) {
  let y = 0;

  return ACCOUNT_WIDGETS.map(type => {
    const height = getAccountWidgetHeight(type);
    const widget = {
      type,
      width: GRID_COLUMNS,
      height,
      x: 0,
      y,
      meta: null,
      dashboard_page_id: dashboardPageId,
    };

    y += height;
    return widget;
  });
}

export function SidebarOptionsDashboard() {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [isHeaderActive, setIsHeaderActive] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const seededRef = useRef(false);
  const pointerRef = useRef<{ id: number; x: number } | null>(null);

  const { data: pages = [], isPending: isPagesPending } = useDashboardPages(
    SIDEBAR_DASHBOARD_KIND,
  );
  const currentPage = pages[Math.min(pageIndex, Math.max(pages.length - 1, 0))];
  const { data: widgets = [] } = useDashboardPageWidgets(currentPage?.id);

  const createPage = useCreateDashboardPageMutation();
  const addWidget = useAddDashboardWidgetMutation();
  const removeWidget = useRemoveDashboardWidgetMutation();
  const deletePage = useDeleteDashboardPageMutation();
  const updateWidgets = useUpdateDashboardWidgetsMutation();
  const updateWidget = useUpdateDashboardWidgetMutation();

  useEffect(() => {
    if (isPagesPending || pages.length > 0 || seededRef.current) {
      return;
    }

    seededRef.current = true;
    createPage.mutate(
      { name: t('Options'), kind: SIDEBAR_DASHBOARD_KIND },
      {
        onSuccess: dashboardPageId => {
          getDefaultAccountWidgets(dashboardPageId).forEach(widget => {
            addWidget.mutate({
              widget,
            });
          });
        },
      },
    );
  }, [addWidget, createPage, isPagesPending, pages.length, t]);

  useEffect(() => {
    setPageIndex(index => Math.min(index, Math.max(pages.length - 1, 0)));
  }, [pages.length]);

  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useResizeObserver<HTMLDivElement>(rect => {
    setContainerWidth(Math.floor(rect.width));
  });
  const gridWidth = Math.max(containerWidth - 12, 0);

  const layout = useMemo(
    () =>
      widgets.map(widget => {
        const minW = Math.min(getSidebarWidgetMinWidth(widget), GRID_COLUMNS);
        const item = clampGridItem({
          x: widget.x,
          width: widget.width,
          minWidth: minW,
        });

        return {
          i: widget.id,
          x: item.x,
          y: widget.y,
          w: item.width,
          h: widget.height,
          minW,
          minH: ACCOUNT_WIDGETS.includes(widget.type as AccountWidgetType)
            ? getAccountWidgetHeight(widget.type as AccountWidgetType)
            : 2,
        };
      }),
    [widgets],
  );
  const widgetMap = useMemo(
    () => new Map(widgets.map(widget => [widget.id, widget])),
    [widgets],
  );

  function onLayoutChange(newLayout: Layout) {
    if (!isEditing) {
      return;
    }

    updateWidgets.mutate({
      widgets: newLayout.map(item => {
        const widget = widgetMap.get(item.i);
        const clamped = clampGridItem({
          x: item.x,
          width: item.w,
          minWidth: widget
            ? Math.min(getSidebarWidgetMinWidth(widget), GRID_COLUMNS)
            : 1,
        });

        return {
          id: item.i,
          width: clamped.width,
          height: item.h,
          x: clamped.x,
          y: item.y,
        };
      }),
    });
  }

  function onAddPage() {
    createPage.mutate(
      { name: t('Options'), kind: SIDEBAR_DASHBOARD_KIND },
      {
        onSuccess: () => setPageIndex(pages.length),
      },
    );
  }

  function onRemoveCurrentPage() {
    if (!currentPage || pages.length <= 1) {
      return;
    }

    deletePage.mutate({ id: currentPage.id, kind: SIDEBAR_DASHBOARD_KIND });
    setPageIndex(index => Math.max(0, Math.min(index, pages.length - 2)));
  }

  function onResetCurrentPage() {
    if (!currentPage) {
      return;
    }

    widgets.forEach(widget => removeWidget.mutate({ id: widget.id }));
    getDefaultAccountWidgets(currentPage.id).forEach(widget => {
      addWidget.mutate({ widget });
    });
  }

  function onAddWidget<T extends DashboardWidgetEntity>(
    type: T['type'],
    meta: T['meta'] = null,
  ) {
    if (!currentPage) {
      return;
    }

    addWidget.mutate({
      widget: {
        type,
        width: GRID_COLUMNS,
        height: ACCOUNT_WIDGETS.includes(type as AccountWidgetType)
          ? getAccountWidgetHeight(type as AccountWidgetType)
          : 3,
        x: 0,
        y: getNextSidebarWidgetY(widgets),
        meta,
        dashboard_page_id: currentPage.id,
      },
    });
  }

  function onMetaChange(
    widget: { i: string },
    newMeta: DashboardWidgetEntity['meta'],
  ) {
    updateWidget.mutate({
      widget: {
        id: widget.i,
        meta: newMeta,
      },
    });
  }

  function movePage(direction: 1 | -1) {
    if (pages.length <= 1) {
      return;
    }

    setPageIndex(index => (index + direction + pages.length) % pages.length);
  }

  function onPointerDown(event: React.PointerEvent) {
    if (isEditing || pages.length <= 1) {
      return;
    }

    if (
      event.target instanceof Element &&
      event.target.closest('a, button, input, select, textarea')
    ) {
      return;
    }

    pointerRef.current = { id: event.pointerId, x: event.clientX };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const pointer = pointerRef.current;

    if (!pointer || pointer.id !== event.pointerId) {
      return;
    }

    setSwipeOffset(
      Math.max(-60, Math.min(60, (event.clientX - pointer.x) * 0.35)),
    );
  }

  function onPointerUp(event: React.PointerEvent) {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    setSwipeOffset(0);

    if (!pointer || pointer.id !== event.pointerId) {
      return;
    }

    const delta = event.clientX - pointer.x;
    if (Math.abs(delta) > SWIPE_THRESHOLD) {
      movePage(delta < 0 ? 1 : -1);
    }
  }

  function onPointerCancel() {
    pointerRef.current = null;
    setSwipeOffset(0);
  }

  return (
    <View
      className={css({
        '& .react-grid-item': {
          transition: 'transform .18s ease, width .18s ease, height .18s ease',
        },
        '& .react-grid-item.react-grid-placeholder': {
          background: palette.month,
          opacity: 0.18,
          borderRadius: 6,
        },
        '& .react-resizable-handle': {
          opacity: isEditing ? 0.9 : 0,
        },
        '& .sidebar-options-report-widget > div > div': {
          borderRadius: '6px !important',
          overflow: 'hidden !important',
        },
      })}
      style={{
        minHeight: 0,
        height: 0,
        flex: '1 1 0',
        flexDirection: 'column',
        overflowX: 'hidden',
        padding: '0 6px 8px',
      }}
    >
      <View
        onMouseEnter={() => setIsHeaderActive(true)}
        onMouseLeave={() => setIsHeaderActive(false)}
        onFocus={() => setIsHeaderActive(true)}
        onBlur={() => setIsHeaderActive(false)}
        style={{
          marginTop: 8,
          marginBottom: 8,
          padding: '8px 10px',
          flexShrink: 0,
          backgroundColor: palette.panel,
          border: '1px solid ' + palette.line,
          borderRadius: 8,
          boxShadow: styles.cardShadow,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            color: palette.text,
            fontSize: 12,
            fontWeight: 800,
            textTransform: 'uppercase',
          }}
        >
          <Trans>Options</Trans>
          <DialogTrigger>
            <Button
              variant="bare"
              className="options-menu-button"
              aria-label={t('Options menu')}
              style={{
                opacity: isEditing || isHeaderActive ? 1 : 0,
                transition: 'opacity .15s',
                padding: 2,
                color: palette.textMuted,
              }}
            >
              <SvgCheveronDown width={11} height={11} />
            </Button>
            <Popover placement="bottom end">
              <Dialog>
                <Menu
                  slot="close"
                  onMenuSelect={item => {
                    if (item === 'edit') {
                      setIsEditing(true);
                    } else if (item === 'reset') {
                      onResetCurrentPage();
                    }
                  }}
                  items={[
                    { name: 'edit', text: t('Edit Options') },
                    { name: 'reset', text: t('Reset to default') },
                  ]}
                />
              </Dialog>
            </Popover>
          </DialogTrigger>
        </View>

        {isEditing && (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: 4,
              paddingTop: 8,
            }}
          >
            <Button onPress={onAddPage} style={{ padding: '3px 6px' }}>
              <Trans>Add page</Trans>
            </Button>
            <Button
              onPress={onRemoveCurrentPage}
              isDisabled={pages.length <= 1}
              style={{ padding: '3px 6px' }}
            >
              <Trans>Remove current page</Trans>
            </Button>
            <AddWidgetButton onAddWidget={onAddWidget} />
            <Button
              variant="primary"
              onPress={() => setIsEditing(false)}
              style={{ padding: '3px 6px' }}
            >
              <Trans>Finish editing</Trans>
            </Button>
          </View>
        )}
      </View>

      <View
        innerRef={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          overflowX: 'hidden',
          backgroundColor: palette.panel,
          border: '1px solid ' + palette.line,
          borderRadius: 8,
          boxShadow: styles.cardShadow,
          padding: 6,
          touchAction: isEditing ? undefined : 'pan-y',
          userSelect: isEditing || swipeOffset !== 0 ? 'none' : undefined,
          scrollbarColor: `${palette.muted} ${palette.panelAlt}`,
          '::-webkit-scrollbar': {
            width: 10,
            backgroundColor: palette.panelAlt,
          },
          '::-webkit-scrollbar-thumb': {
            backgroundColor: palette.muted,
            border: '2px solid ' + palette.panelAlt,
            backgroundClip: 'padding-box',
          },
        }}
      >
        <View
          style={{
            minHeight: 80,
            height: '100%',
            overflow: 'auto',
            scrollbarColor: `${palette.muted} ${palette.panelAlt}`,
            '::-webkit-scrollbar': {
              width: 10,
              backgroundColor: palette.panelAlt,
            },
            '::-webkit-scrollbar-thumb': {
              backgroundColor: palette.muted,
              border: '2px solid ' + palette.panelAlt,
              backgroundClip: 'padding-box',
            },
          }}
        >
          {gridWidth > 0 && currentPage && (
            <View
              style={{
                display: 'block',
                transform: `translateX(${swipeOffset}px)`,
                transition: swipeOffset === 0 ? 'transform .18s ease' : 'none',
              }}
            >
              <ReactGridLayout
                width={gridWidth}
                layout={layout}
                gridConfig={{ cols: GRID_COLUMNS, rowHeight: ROW_HEIGHT }}
                dragConfig={{
                  enabled: isEditing,
                  cancel: `.${NON_DRAGGABLE_AREA_CLASS_NAME}`,
                }}
                resizeConfig={{ enabled: isEditing }}
                onLayoutChange={onLayoutChange}
              >
                {layout.map(item => {
                  const widget = widgetMap.get(item.i);
                  if (!widget) {
                    return null;
                  }

                  const isAccountWidget = ACCOUNT_WIDGETS.includes(
                    widget.type as AccountWidgetType,
                  );

                  return (
                    <div
                      key={item.i}
                      className={
                        isAccountWidget
                          ? undefined
                          : 'sidebar-options-report-widget'
                      }
                    >
                      <ErrorBoundary
                        fallbackRender={() => (
                          <MissingReportCard
                            isEditing={isEditing}
                            onRemove={() => removeWidget.mutate({ id: item.i })}
                          >
                            <Trans>This widget has failed to load.</Trans>
                          </MissingReportCard>
                        )}
                      >
                        <SidebarWidget
                          widget={widget}
                          item={item}
                          isEditing={isEditing}
                          onRemove={() => removeWidget.mutate({ id: item.i })}
                          onMetaChange={onMetaChange}
                        />
                      </ErrorBoundary>
                    </div>
                  );
                })}
              </ReactGridLayout>
            </View>
          )}
        </View>
      </View>

      {pages.length > 1 && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 5,
            padding: '8px 0 12px',
            flexShrink: 0,
          }}
        >
          {pages.map((page, index) => (
            <Button
              key={page.id}
              variant="bare"
              aria-label={t('Show options page {{number}}', {
                number: index + 1,
              })}
              onPress={() => setPageIndex(index)}
              style={{
                width: index === pageIndex ? 18 : 8,
                height: 8,
                padding: 0,
                borderRadius: 4,
                backgroundColor:
                  index === pageIndex ? palette.month : palette.lineStrong,
                transition: 'width .18s ease, background-color .18s ease',
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function AddWidgetButton({
  onAddWidget,
}: {
  onAddWidget: <T extends DashboardWidgetEntity>(
    type: T['type'],
    meta?: T['meta'],
  ) => void;
}) {
  const { t } = useTranslation();
  const { data: customReports = [] } = useReports();
  const ageOfMoneyReportEnabled = useFeatureFlag('ageOfMoneyReport');
  const budgetAnalysisReportEnabled = useFeatureFlag('budgetAnalysisReport');
  const balanceForecastReportEnabled = useFeatureFlag('balanceForecastReport');
  const formulaMode = useFeatureFlag('formulaMode');
  const sankeyFeatureFlag = useFeatureFlag('sankeyReport');
  const items: MenuItem<string>[] = [
    { name: 'accounts-all-card', text: t('All accounts') },
    { name: 'accounts-on-budget-card', text: t('On budget accounts') },
    { name: 'accounts-off-budget-card', text: t('Off budget accounts') },
    { name: 'accounts-add-card', text: t('Add account') },
    Menu.line,
    { name: 'cash-flow-card', text: t('Cash flow graph') },
    { name: 'net-worth-card', text: t('Net worth graph') },
    { name: 'crossover-card', text: t('Crossover point') },
  ];

  if (ageOfMoneyReportEnabled) {
    items.push({ name: 'age-of-money-card', text: t('Age of Money') });
  }

  items.push({ name: 'spending-card', text: t('Spending analysis') });

  if (budgetAnalysisReportEnabled) {
    items.push({ name: 'budget-analysis-card', text: t('Budget analysis') });
  }

  if (balanceForecastReportEnabled) {
    items.push({ name: 'balance-forecast-card', text: t('Balance forecast') });
  }

  items.push(
    { name: 'markdown-card', text: t('Text widget') },
    { name: 'summary-card', text: t('Summary card') },
    { name: 'calendar-card', text: t('Calendar card') },
  );

  if (formulaMode) {
    items.push({ name: 'formula-card', text: t('Formula card') });
  }

  if (sankeyFeatureFlag) {
    items.push({ name: 'sankey-card', text: t('Sankey card') });
  }

  if (customReports.length) {
    items.push(Menu.line);
    items.push(
      ...customReports.map(report => ({
        name: `custom-report-${report.id}`,
        text: report.name,
      })),
    );
  }

  return (
    <DialogTrigger>
      <Button style={{ padding: '3px 6px' }}>
        <SvgAdd width={9} height={9} />
        <Trans>Add new widget</Trans>
      </Button>
      <Popover placement="bottom start">
        <Dialog>
          <Menu
            slot="close"
            onMenuSelect={item => {
              if (ACCOUNT_WIDGETS.includes(item as AccountWidgetType)) {
                onAddWidget<AccountsWidget>(item as AccountWidgetType);
                return;
              }

              if (item === 'markdown-card') {
                onAddWidget<MarkdownWidget>('markdown-card', {
                  content: `### ${t('Text Widget')}\n\n${t('Edit this widget to change the **markdown** content.')}`,
                });
                return;
              }

              if (item.startsWith('custom-report-')) {
                const [, reportId] = item.split('custom-report-');
                onAddWidget<CustomReportWidget>('custom-report', {
                  id: reportId,
                });
                return;
              }

              onAddWidget(item as DashboardWidgetEntity['type']);
            }}
            items={items}
          />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function SidebarWidget({
  widget,
  item,
  isEditing,
  onRemove,
  onMetaChange,
}: {
  widget: DashboardWidgetEntity;
  item: { i: string };
  isEditing: boolean;
  onRemove: () => void;
  onMetaChange: (
    widget: { i: string },
    newMeta: DashboardWidgetEntity['meta'],
  ) => void;
}) {
  const { t } = useTranslation();
  const { data: accounts = [] } = useAccounts();
  const { data: customReports = [] } = useReports();
  const [_firstDayOfWeekIdx] = useSyncedPref('firstDayOfWeekIdx');
  const firstDayOfWeekIdx = _firstDayOfWeekIdx || '0';
  const ageOfMoneyReportEnabled = useFeatureFlag('ageOfMoneyReport');
  const budgetAnalysisReportEnabled = useFeatureFlag('budgetAnalysisReport');
  const balanceForecastReportEnabled = useFeatureFlag('balanceForecastReport');
  const formulaMode = useFeatureFlag('formulaMode');
  const sankeyFeatureFlag = useFeatureFlag('sankeyReport');
  const customReportMap = useMemo(
    () => new Map(customReports.map(report => [report.id, report])),
    [customReports],
  );
  const onCopy = () => {};
  const isSmallAccountWidget =
    widget.type === 'accounts-all-card' || widget.type === 'accounts-add-card';

  if (ACCOUNT_WIDGETS.includes(widget.type as AccountWidgetType)) {
    return (
      <ReportCard
        isEditing={isEditing}
        menuItems={[{ name: 'remove', text: t('Remove') }]}
        onMenuSelect={item => {
          if (item === 'remove') {
            onRemove();
          }
        }}
        style={{
          backgroundColor: palette.panelAlt,
          border: '1px solid ' + palette.line,
          borderRadius: 6,
          boxShadow: 'none',
          overflow: 'auto',
          padding: 3,
          justifyContent: isSmallAccountWidget ? 'center' : undefined,
        }}
      >
        <Accounts
          showDivider={false}
          compact
          sections={
            widget.type === 'accounts-all-card'
              ? ['all']
              : widget.type === 'accounts-on-budget-card'
                ? ['on-budget']
                : widget.type === 'accounts-off-budget-card'
                  ? ['off-budget']
                  : widget.type === 'accounts-add-card'
                    ? ['add']
                    : []
          }
          disableAccountReorder={isEditing}
        />
      </ReportCard>
    );
  }

  return widget.type === 'net-worth-card' ? (
    <NetWorthCard
      widgetId={item.i}
      isEditing={isEditing}
      accounts={accounts}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'crossover-card' ? (
    <CrossoverCard
      widgetId={item.i}
      isEditing={isEditing}
      accounts={accounts}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'age-of-money-card' && ageOfMoneyReportEnabled ? (
    <AgeOfMoneyCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'cash-flow-card' ? (
    <CashFlowCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'spending-card' ? (
    <SpendingCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'budget-analysis-card' && budgetAnalysisReportEnabled ? (
    <BudgetAnalysisCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'balance-forecast-card' &&
    balanceForecastReportEnabled ? (
    <BalanceForecastCard
      widgetId={item.i}
      isEditing={isEditing}
      accounts={accounts}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'markdown-card' ? (
    <MarkdownCard
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'custom-report' ? (
    <CustomReportListCards
      isEditing={isEditing}
      report={customReportMap.get(widget.meta.id)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'summary-card' ? (
    <SummaryCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'calendar-card' ? (
    <CalendarCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      firstDayOfWeekIdx={firstDayOfWeekIdx}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'formula-card' && formulaMode ? (
    <FormulaCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : widget.type === 'sankey-card' && sankeyFeatureFlag ? (
    <SankeyCard
      widgetId={item.i}
      isEditing={isEditing}
      meta={widget.meta}
      onMetaChange={newMeta => onMetaChange(item, newMeta)}
      onRemove={onRemove}
      onCopy={onCopy}
    />
  ) : null;
}
