import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import {
  SvgCheveronDown,
  SvgDotsHorizontalTriple,
} from '@actual-app/components/icons/v1';
import {
  SvgArrowButtonDown1,
  SvgArrowButtonRight1,
  SvgArrowsSynchronize,
  SvgCalendar3,
} from '@actual-app/components/icons/v2';
import { Input } from '@actual-app/components/input';
import { Menu } from '@actual-app/components/menu';
import { Popover } from '@actual-app/components/popover';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import { q } from '@actual-app/core/shared/query';
import type {
  CategoryEntity,
  CategoryGroupEntity,
} from '@actual-app/core/types/models';

import { BalanceWithCarryover } from '#components/budget/BalanceWithCarryover';
import { CoverMenu } from '#components/budget/envelope/CoverMenu';
import { HoldMenu } from '#components/budget/envelope/HoldMenu';
import { TransferMenu } from '#components/budget/envelope/TransferMenu';
import { CategoryAutomationButton } from '#components/budget/goals/CategoryAutomationButton';
import { NotesButton } from '#components/NotesButton';
import { PrivacyFilter } from '#components/PrivacyFilter';
import { CellValue, CellValueText } from '#components/spreadsheet/CellValue';
import { SheetCell } from '#components/table';
import { SchedulesProvider } from '#hooks/useCachedSchedules';
import { useCategoryScheduleGoalTemplateIndicator } from '#hooks/useCategoryScheduleGoalTemplateIndicator';
import { useContextMenu } from '#hooks/useContextMenu';
import { useFeatureFlag } from '#hooks/useFeatureFlag';
import { useFormat } from '#hooks/useFormat';
import type { FormatType } from '#hooks/useFormat';
import { useGlobalPref } from '#hooks/useGlobalPref';
import { useLocale } from '#hooks/useLocale';
import { useLocalPref } from '#hooks/useLocalPref';
import { useNavigate } from '#hooks/useNavigate';
import { useNotes } from '#hooks/useNotes';
import { SheetNameProvider } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import { useUndo } from '#hooks/useUndo';
import type { Binding } from '#spreadsheet';
import { envelopeBudget, trackingBudget } from '#spreadsheet/bindings';

import { useBudgetMonthCount } from './BudgetMonthCountContext';
import type { MonthBounds } from './MonthsContext';
import { findSortDown, findSortUp } from './util';

type MoneyBinding =
  | Binding<'envelope-budget', 'budget'>
  | Binding<'envelope-budget', 'sum-amount'>
  | Binding<'envelope-budget', 'leftover'>;
type CarryoverBinding = Binding<
  'envelope-budget' | 'tracking-budget',
  'carryover'
>;
type BalanceBinding = Binding<
  'envelope-budget' | 'tracking-budget',
  'leftover' | 'sum-amount'
>;
type GoalBinding = Binding<'envelope-budget' | 'tracking-budget', 'goal'>;
type BudgetBinding = Binding<'envelope-budget' | 'tracking-budget', 'budget'>;
type LongGoalBinding = Binding<
  'envelope-budget' | 'tracking-budget',
  'long-goal'
>;

type ModernBudgetPageProps = {
  budgetType: string;
  categoryGroups: CategoryGroupEntity[];
  startMonth: string;
  maxMonths: number;
  summaryCollapsed: boolean;
  monthBounds: MonthBounds;
  onMonthSelect: (month: string, numMonths: number) => void;
  onToggleSummaryCollapse: () => void;
  onBudgetAction: (month: string, action: string, arg: unknown) => void;
  onShowActivity: (id: CategoryEntity['id'], month?: string) => void;
  onSaveCategory: (category: CategoryEntity) => void;
  onDeleteCategory: (id: CategoryEntity['id']) => void;
  onSaveGroup: (group: CategoryGroupEntity) => void;
  onDeleteGroup: (id: CategoryGroupEntity['id']) => void;
  onApplyBudgetTemplatesInGroup: (
    categoryIds: Array<CategoryEntity['id']>,
  ) => void;
  onReorderCategory?: (params: {
    id: CategoryEntity['id'];
    groupId: CategoryGroupEntity['id'];
    targetId: CategoryEntity['id'] | null;
  }) => void;
  onReorderGroup?: (params: {
    id: CategoryGroupEntity['id'];
    targetId: CategoryGroupEntity['id'] | null;
  }) => void;
  onSortCategories?: (
    groupId: CategoryGroupEntity['id'],
    direction: 'asc' | 'desc',
  ) => void;
};

type DragItem =
  | { type: 'group'; id: CategoryGroupEntity['id'] }
  | {
      type: 'category';
      id: CategoryEntity['id'];
      groupId: CategoryGroupEntity['id'];
      isIncome: boolean;
    };
type PanState = {
  pointerId: number;
  x: number;
  y: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
};

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
  cash: '#4FD6A0',
  amber: '#E7B84E',
  danger: '#FF6B7A',
  muted: '#7F95AA',
};

const CATEGORY_WIDTHS = [160, 220, 280];
const MONTH_WIDTH = 460;
const GOAL_WIDTH = 92;
const monthLaneFlex = `1 0 ${MONTH_WIDTH}px`;
const monthValueColumns =
  '24px minmax(132px, 1fr) minmax(112px, 1fr) minmax(112px, 1fr) 24px';
const monthValueColumnsWithoutBalance =
  '24px minmax(132px, 1fr) minmax(112px, 1fr) 24px';

function stickyCategoryColumnStyle(backgroundColor: string, zIndex = 5) {
  return {
    position: 'sticky' as const,
    left: 0,
    zIndex,
    backgroundColor,
    borderRight: '1px solid ' + palette.line,
  };
}

function stickyGoalColumnStyle(backgroundColor: string, zIndex = 5) {
  return {
    position: 'sticky' as const,
    right: 0,
    zIndex,
    backgroundColor,
    borderLeft: '1px solid ' + palette.line,
  };
}

function LaneMetricRow({
  label,
  children,
  emphasized = false,
}: {
  label: ReactNode;
  children: ReactNode;
  emphasized?: boolean;
}) {
  return (
    <View
      style={{
        display: 'grid',
        gridTemplateColumns: '72px minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: 8,
        minHeight: 18,
      }}
    >
      <View
        style={{
          color: emphasized ? palette.textMuted : palette.muted,
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          minWidth: 0,
        }}
      >
        {label}
      </View>
      <View style={{ alignItems: 'flex-end', minWidth: 0 }}>{children}</View>
    </View>
  );
}

function getBindings(budgetType: string) {
  return budgetType === 'tracking' ? trackingBudget : envelopeBudget;
}

export function getVisibleMonths(
  startMonth: string,
  maxMonths: number,
  monthBounds: MonthBounds,
) {
  const availableMonths =
    monthUtils.differenceInCalendarMonths(monthBounds.end, monthBounds.start) +
    1;
  const count = Math.min(Math.max(maxMonths, 1), 6, availableMonths);
  const lastStartMonth = monthUtils.subMonths(monthBounds.end, count - 1);
  const validStartMonth =
    startMonth < monthBounds.start
      ? monthBounds.start
      : startMonth > lastStartMonth
        ? lastStartMonth
        : startMonth;

  return monthUtils.rangeInclusive(
    validStartMonth,
    monthUtils.addMonths(validStartMonth, count - 1),
  );
}

function getDropTargetId<T extends { id: string }>(
  event: DragEvent,
  item: T,
  nextItem: T | undefined,
) {
  const dropPosition = getDropPosition(event);
  return dropPosition === 'bottom' ? (nextItem?.id ?? null) : item.id;
}

function getDropPosition(event: DragEvent): 'top' | 'bottom' {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientY > bounds.top + bounds.height / 2 ? 'bottom' : 'top';
}

function isInteractiveDragTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest('button, a, input, textarea, select, [role="button"]'),
    )
  );
}

function InlineNameEditor({
  defaultValue,
  placeholder,
  onSave,
  onCancel,
}: {
  defaultValue?: string;
  placeholder: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const committedRef = useRef(false);

  function commit(value: string) {
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;

    const name = value.trim();
    if (name) {
      onSave(name);
    } else {
      onCancel();
    }
  }

  return (
    <Input
      autoFocus
      defaultValue={defaultValue}
      placeholder={placeholder}
      onEnter={(value, event) => {
        commit(value);
        event.currentTarget.blur();
      }}
      onEscape={(_, event) => {
        onCancel();
        event.currentTarget.blur();
      }}
      onUpdate={commit}
      style={{
        width: '100%',
        backgroundColor: palette.panel,
        borderColor: palette.month,
        color: palette.text,
        fontWeight: 700,
      }}
    />
  );
}

function CategoryActionMenu({
  category,
  groupHidden,
  onRename,
  onMoveUp,
  onMoveDown,
  onSave,
  onDelete,
  children,
}: {
  category: CategoryEntity;
  groupHidden?: boolean;
  onRename: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onSave: ModernBudgetPageProps['onSaveCategory'];
  onDelete: ModernBudgetPageProps['onDeleteCategory'];
  children: (props: {
    menuButton: ReactNode;
    triggerRef: RefObject<HTMLDivElement | null>;
    handleContextMenu: (event: MouseEvent<HTMLElement>) => void;
  }) => ReactNode;
}) {
  const { t } = useTranslation();
  const { menuOpen, setMenuOpen, position, handleContextMenu, resetPosition } =
    useContextMenu();
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuButton = (
    <Button
      variant="bare"
      aria-label={t('Category actions')}
      onPress={() => {
        resetPosition();
        setMenuOpen(true);
      }}
      style={{ color: palette.muted, padding: 3 }}
    >
      <SvgCheveronDown width={13} height={13} />
    </Button>
  );

  return (
    <>
      {children({ menuButton, triggerRef, handleContextMenu })}
      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 190, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu
          onMenuSelect={type => {
            if (type === 'rename') {
              onRename();
            } else if (type === 'move-up') {
              onMoveUp?.();
            } else if (type === 'move-down') {
              onMoveDown?.();
            } else if (type === 'toggle-visibility') {
              onSave({ ...category, hidden: !category.hidden });
            } else if (type === 'delete') {
              onDelete(category.id);
            }
            setMenuOpen(false);
          }}
          items={[
            { name: 'rename', text: t('Rename') },
            ...(onMoveUp ? [{ name: 'move-up', text: t('Move up') }] : []),
            ...(onMoveDown
              ? [{ name: 'move-down', text: t('Move down') }]
              : []),
            ...(!groupHidden
              ? [
                  {
                    name: 'toggle-visibility',
                    text: category.hidden ? t('Show') : t('Hide'),
                  },
                ]
              : []),
            { name: 'delete', text: t('Delete') },
          ]}
        />
      </Popover>
    </>
  );
}

function GroupActionMenu({
  group,
  budgetType,
  onRename,
  onAddCategory,
  onMoveUp,
  onMoveDown,
  onSave,
  onDelete,
  onApplyBudgetTemplatesInGroup,
  onSortCategories,
  children,
}: {
  group: CategoryGroupEntity;
  budgetType: string;
  onRename: () => void;
  onAddCategory: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onSave: ModernBudgetPageProps['onSaveGroup'];
  onDelete: ModernBudgetPageProps['onDeleteGroup'];
  onApplyBudgetTemplatesInGroup: ModernBudgetPageProps['onApplyBudgetTemplatesInGroup'];
  onSortCategories: ModernBudgetPageProps['onSortCategories'];
  children: (props: {
    menuButton: ReactNode;
    triggerRef: RefObject<HTMLDivElement | null>;
    handleContextMenu: (event: MouseEvent<HTMLElement>) => void;
  }) => ReactNode;
}) {
  const { t } = useTranslation();
  const { showUndoNotification } = useUndo();
  const goalTemplatesEnabled = useFeatureFlag('goalTemplatesEnabled');
  const { menuOpen, setMenuOpen, position, handleContextMenu, resetPosition } =
    useContextMenu();
  const triggerRef = useRef<HTMLDivElement>(null);
  const canSortCategories =
    !!onSortCategories && (group.categories?.length ?? 0) > 1;
  const canApplyTemplates =
    goalTemplatesEnabled && (budgetType === 'tracking' || !group.is_income);
  type GroupAction =
    | 'rename'
    | 'add-category'
    | 'toggle-visibility'
    | 'delete'
    | 'move-up'
    | 'move-down'
    | 'sort-asc'
    | 'sort-desc'
    | 'apply-templates';
  const items: Array<{ name: GroupAction; text: string }> = [
    { name: 'rename', text: t('Rename') },
    { name: 'add-category', text: t('Add category') },
    ...(onMoveUp ? [{ name: 'move-up' as const, text: t('Move up') }] : []),
    ...(onMoveDown
      ? [{ name: 'move-down' as const, text: t('Move down') }]
      : []),
    ...(!group.is_income
      ? [
          {
            name: 'toggle-visibility' as const,
            text: group.hidden ? t('Show') : t('Hide'),
          },
        ]
      : []),
    ...(!group.is_income
      ? [{ name: 'delete' as const, text: t('Delete') }]
      : []),
    ...(canSortCategories
      ? [
          { name: 'sort-asc' as const, text: t('Sort A to Z') },
          { name: 'sort-desc' as const, text: t('Sort Z to A') },
        ]
      : []),
    ...(canApplyTemplates
      ? [
          {
            name: 'apply-templates' as const,
            text: t('Overwrite with templates'),
          },
        ]
      : []),
  ];
  const menuButton = (
    <Button
      variant="bare"
      aria-label={t('Group actions')}
      onPress={() => {
        resetPosition();
        setMenuOpen(true);
      }}
      style={{ color: palette.muted, padding: 3 }}
    >
      <SvgCheveronDown width={13} height={13} />
    </Button>
  );

  return (
    <>
      {children({ menuButton, triggerRef, handleContextMenu })}
      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 220, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu
          onMenuSelect={type => {
            if (type === 'rename') {
              onRename();
            } else if (type === 'add-category') {
              onAddCategory();
            } else if (type === 'move-up') {
              onMoveUp?.();
            } else if (type === 'move-down') {
              onMoveDown?.();
            } else if (type === 'toggle-visibility') {
              onSave({ ...group, hidden: !group.hidden });
            } else if (type === 'delete' && !group.is_income) {
              onDelete(group.id);
            } else if (type === 'sort-asc') {
              onSortCategories?.(group.id, 'asc');
            } else if (type === 'sort-desc') {
              onSortCategories?.(group.id, 'desc');
            } else if (type === 'apply-templates') {
              onApplyBudgetTemplatesInGroup(
                (group.categories || [])
                  .filter(category => !category.hidden)
                  .map(category => category.id),
              );
            }
            setMenuOpen(false);
          }}
          items={items}
        />
      </Popover>
    </>
  );
}

function ModernCategoryRowActions({
  category,
  month,
}: {
  category: CategoryEntity;
  month: string;
}) {
  const notes = useNotes(category.id) || '';
  const isGoalTemplatesUIEnabled = useFeatureFlag('goalTemplatesUIEnabled');
  const hasAutomations =
    !!category.goal_def?.length || !!category.cleanup_def?.length;

  return (
    <>
      <CategoryAutomationButton
        category={category}
        month={month}
        width={13}
        height={13}
        defaultColor={palette.muted}
        showPlaceholder={!!notes}
        style={{ padding: 3 }}
      />
      <NotesButton
        id={category.id}
        defaultColor={palette.muted}
        showPlaceholder={isGoalTemplatesUIEnabled && hasAutomations}
      />
    </>
  );
}

function CategoryHeaderMenu({
  startMonth,
  maxMonths,
  months,
  monthBounds,
  showHiddenCategories,
  setShowHiddenCategories,
  showProgressBars,
  setShowProgressBars,
  categoryExpandedState,
  summaryCollapsed,
  onToggleSummaryCollapse,
  onCycleCategoryWidth,
  onExpandAllGroups,
  onCollapseAllGroups,
  onMonthCountChange,
  onMonthSelect,
  onAddGroup,
}: {
  startMonth: string;
  maxMonths: number;
  months: string[];
  monthBounds: MonthBounds;
  showHiddenCategories: boolean;
  setShowHiddenCategories: (show: boolean) => void;
  showProgressBars: boolean;
  setShowProgressBars: (show: boolean) => void;
  categoryExpandedState: number;
  summaryCollapsed: boolean;
  onToggleSummaryCollapse: () => void;
  onCycleCategoryWidth: () => void;
  onExpandAllGroups: () => void;
  onCollapseAllGroups: () => void;
  onMonthCountChange: (count: number) => void;
  onMonthSelect: (month: string, numMonths: number) => void;
  onAddGroup: () => void;
}) {
  const { t } = useTranslation();
  const { menuOpen, setMenuOpen, position, handleContextMenu, resetPosition } =
    useContextMenu();
  const triggerRef = useRef(null);
  const availableMonthCount = Math.min(
    6,
    monthUtils.differenceInCalendarMonths(monthBounds.end, monthBounds.start) +
      1,
  );

  function changeMonthCount(requestedCount: number) {
    const count = Math.min(requestedCount, availableMonthCount);
    const end = monthUtils.subMonths(monthBounds.end, count - 1);
    const month =
      startMonth < monthBounds.start
        ? monthBounds.start
        : startMonth > end
          ? end
          : startMonth;

    onMonthCountChange(count);
    onMonthSelect(month, count);
  }

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('Category table actions')}
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{ color: palette.muted, padding: 3 }}
      >
        <SvgDotsHorizontalTriple width={14} height={14} />
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 230, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu
          onMenuSelect={name => {
            if (name === 'add-group') {
              onAddGroup();
            } else if (name === 'toggle-hidden') {
              setShowHiddenCategories(!showHiddenCategories);
            } else if (name === 'toggle-summary') {
              onToggleSummaryCollapse();
            } else if (name === 'toggle-progress') {
              setShowProgressBars(!showProgressBars);
            } else if (name === 'cycle-width') {
              onCycleCategoryWidth();
            } else if (name === 'expand-all') {
              onExpandAllGroups();
            } else if (name === 'collapse-all') {
              onCollapseAllGroups();
            } else if (name.startsWith('months-')) {
              changeMonthCount(Number(name.slice('months-'.length)));
            }
            setMenuOpen(false);
          }}
          items={[
            { name: 'add-group', text: t('Add group') },
            {
              name: 'toggle-hidden',
              text: showHiddenCategories
                ? t('Hide hidden categories')
                : t('Show hidden categories'),
            },
            {
              name: 'toggle-summary',
              text: summaryCollapsed ? t('Show summary') : t('Hide summary'),
            },
            {
              name: 'toggle-progress',
              text: showProgressBars
                ? t('Hide progress bars')
                : t('Show progress bars'),
            },
            {
              name: 'cycle-width',
              text:
                categoryExpandedState === 0
                  ? t('Expand names')
                  : categoryExpandedState === 1
                    ? t('Fully expand names')
                    : t('Collapse names'),
            },
            { name: 'expand-all', text: t('Expand all') },
            { name: 'collapse-all', text: t('Collapse all') },
            ...Array.from({ length: availableMonthCount }, (_, index) => {
              const count = index + 1;
              return {
                name: `months-${count}`,
                text:
                  months.length === count
                    ? t('{{count}} months shown', { count })
                    : t('Show {{count}} months', { count }),
              };
            }),
          ]}
        />
      </Popover>
    </>
  );
}

function BudgetAmountCell({
  category,
  month,
  budgetType,
  editingCell,
  setEditingCell,
  onBudgetAction,
}: {
  category: CategoryEntity;
  month: string;
  budgetType: string;
  editingCell: { id: string; month: string } | null;
  setEditingCell: (cell: { id: string; month: string } | null) => void;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const bindings = getBindings(budgetType);
  const format = useFormat();
  const editing =
    editingCell?.id === category.id && editingCell?.month === month;
  const triggerRef = useRef(null);
  const { menuOpen, setMenuOpen, position, handleContextMenu } =
    useContextMenu();
  const { items, onMenuSelect } = useCategoryBudgetActions({
    category,
    month,
    budgetType,
    onBudgetAction,
    onClose: () => setMenuOpen(false),
  });

  return (
    <View
      ref={triggerRef}
      onClick={() => setEditingCell({ id: category.id, month })}
      onContextMenu={event => {
        if (!editing) {
          handleContextMenu(event);
        }
      }}
      style={{ width: '100%' }}
    >
      <SheetCell
        name="budget"
        exposed={editing}
        focused={editing}
        width="flex"
        textAlign="right"
        onExpose={() => setEditingCell({ id: category.id, month })}
        style={{
          minHeight: 28,
          borderColor: 'transparent',
          backgroundColor: 'transparent',
        }}
        valueStyle={{
          cursor: 'default',
          justifyContent: 'flex-end',
          padding: '0 4px',
          color: palette.text,
          fontWeight: 700,
          ...styles.tnum,
          ':hover': {
            backgroundColor: palette.panelRaised,
            boxShadow: 'inset 0 0 0 1px ' + palette.lineStrong,
          },
        }}
        valueProps={{
          binding: bindings.catBudgeted(category.id) as Binding<
            'envelope-budget',
            'budget'
          >,
          type: 'financial',
          formatExpr: format.forEdit,
          unformatExpr: format.fromEdit,
        }}
        inputProps={{
          onBlur: () => setEditingCell(null),
          style: {
            backgroundColor: palette.panelRaised,
            color: palette.text,
            borderColor: palette.month,
          },
        }}
        onSave={(amount: number | null) => {
          onBudgetAction(month, 'budget-amount', {
            category: category.id,
            amount: amount ?? 0,
          });
        }}
      />
      <Popover
        triggerRef={triggerRef}
        placement="bottom start"
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 220, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu onMenuSelect={onMenuSelect} items={items} />
      </Popover>
    </View>
  );
}

function useCategoryBudgetActions({
  category,
  month,
  budgetType,
  onBudgetAction,
  onClose,
}: {
  category: CategoryEntity;
  month: string;
  budgetType: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showUndoNotification } = useUndo();
  const goalTemplatesEnabled = useFeatureFlag('goalTemplatesEnabled');
  const items: Array<{ name: string; text: string }> = [
    { name: 'copy-single-last', text: t("Copy last month's budget") },
    { name: 'set-single-3-avg', text: t('Set to 3 month average') },
    { name: 'set-single-6-avg', text: t('Set to 6 month average') },
    { name: 'set-single-12-avg', text: t('Set to yearly average') },
    ...(budgetType === 'tracking'
      ? [{ name: 'copy-until-year-end', text: t('Copy until year end') }]
      : []),
    ...(goalTemplatesEnabled
      ? [
          {
            name: 'apply-single-category-template',
            text: t('Overwrite with template'),
          },
        ]
      : []),
  ];

  function onMenuSelect(name: string) {
    onBudgetAction(month, name, { category: category.id });
    if (name === 'copy-single-last') {
      showUndoNotification({
        message: t(`Budget set to last month's budget.`),
      });
    } else if (
      name === 'set-single-3-avg' ||
      name === 'set-single-6-avg' ||
      name === 'set-single-12-avg'
    ) {
      showUndoNotification({
        message: t('Budget set to {{numberOfMonths}}-month average.', {
          numberOfMonths:
            name === 'set-single-3-avg'
              ? 3
              : name === 'set-single-6-avg'
                ? 6
                : 12,
        }),
      });
    } else if (name === 'apply-single-category-template') {
      showUndoNotification({ message: t(`Budget template applied.`) });
    } else if (name === 'copy-until-year-end') {
      showUndoNotification({
        message: t(`Budget copied until year end.`),
      });
    }
    onClose();
  }

  return { items, onMenuSelect };
}

function CategoryBudgetActionMenu({
  category,
  month,
  budgetType,
  onBudgetAction,
}: {
  category: CategoryEntity;
  month: string;
  budgetType: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const {
    menuOpen,
    setMenuOpen,
    position,
    handleContextMenu,
    resetPosition,
    asContextMenu,
  } = useContextMenu();
  const triggerRef = useRef(null);
  const { t } = useTranslation();
  const { items, onMenuSelect } = useCategoryBudgetActions({
    category,
    month,
    budgetType,
    onBudgetAction,
    onClose: () => setMenuOpen(false),
  });

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('Budget actions')}
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{ color: palette.muted, padding: 2, flexShrink: 0 }}
      >
        <SvgCheveronDown width={12} height={12} />
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement={asContextMenu ? 'bottom start' : 'bottom end'}
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 220, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu onMenuSelect={onMenuSelect} items={items} />
      </Popover>
    </>
  );
}

function ScheduleIndicator({
  category,
  month,
}: {
  category: CategoryEntity;
  month: string;
}) {
  const navigate = useNavigate();
  const { schedule, scheduleStatus, isScheduleRecurring, description } =
    useCategoryScheduleGoalTemplateIndicator({ category, month });

  if (!schedule || !scheduleStatus) {
    return null;
  }

  const color =
    scheduleStatus === 'missed'
      ? palette.danger
      : scheduleStatus === 'due'
        ? palette.amber
        : palette.textMuted;
  const Icon = isScheduleRecurring ? SvgArrowsSynchronize : SvgCalendar3;

  return (
    <View title={description}>
      <Button
        variant="bare"
        aria-label={description}
        onPress={() =>
          schedule._account
            ? navigate(`/accounts/${schedule._account}`)
            : navigate('/accounts')
        }
        style={{
          color,
          padding: 1,
          flexShrink: 0,
        }}
      >
        <Icon width={12} height={12} />
      </Button>
    </View>
  );
}

function MoneyValue({
  binding,
  tone,
}: {
  binding: MoneyBinding;
  tone?: 'default' | 'subdued' | 'balance';
}) {
  return (
    <CellValue
      binding={binding as Binding<'envelope-budget', 'budget'>}
      type="financial"
    >
      {props => (
        <CellValueText
          {...props}
          type="financial"
          style={{
            color:
              tone === 'subdued'
                ? palette.muted
                : tone === 'balance' && Number(props.value) < 0
                  ? palette.danger
                  : palette.text,
            fontWeight: tone === 'balance' ? 700 : 600,
            ...styles.tnum,
          }}
        />
      )}
    </CellValue>
  );
}

function SummaryValue({
  binding,
  tone = 'default',
}: {
  binding: Binding<'envelope-budget', 'budget'>;
  tone?:
    | 'default'
    | 'strong'
    | 'strong-negative-aware'
    | 'negative'
    | 'projected';
}) {
  const format = useFormat();
  const value = Number(useSheetValue(binding) ?? 0);

  return (
    <Text
      style={{
        color:
          tone === 'negative' && value < 0
            ? palette.danger
            : tone === 'strong-negative-aware' && value < 0
              ? palette.danger
              : tone === 'projected'
                ? palette.amber
                : tone === 'strong'
                  ? palette.text
                  : tone === 'strong-negative-aware'
                    ? palette.cash
                    : palette.muted,
        fontWeight:
          tone === 'strong' ||
          tone === 'strong-negative-aware' ||
          tone === 'projected'
            ? 800
            : 700,
        ...styles.tnum,
      }}
    >
      <PrivacyFilter>{format(value, 'financial')}</PrivacyFilter>
    </Text>
  );
}

function TrackingTargetSummaryValue({
  current,
  target,
  tone = 'default',
}: {
  current: Binding<'tracking-budget', 'total-income' | 'total-spent'>;
  target: Binding<'tracking-budget', 'total-budget-income' | 'total-budgeted'>;
  tone?: 'default' | 'negative';
}) {
  const format = useFormat();
  const currentValue = Number(useSheetValue(current) ?? 0);
  const targetValue = Number(useSheetValue(target) ?? 0);

  return (
    <Text
      style={{
        color:
          tone === 'negative' && currentValue < 0
            ? palette.danger
            : palette.muted,
        fontWeight: 700,
        ...styles.tnum,
      }}
    >
      <PrivacyFilter>
        <Trans
          i18nKey="{{current}} of {{target}}"
          values={{
            current: format(currentValue, 'financial'),
            target: format(targetValue, 'financial'),
          }}
        />
      </PrivacyFilter>
    </Text>
  );
}

function MonthActionMenu({
  month,
  budgetType,
  onBudgetAction,
}: {
  month: string;
  budgetType: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { showUndoNotification } = useUndo();
  const displayMonth = monthUtils.format(month, 'MMMM', locale);
  const goalTemplatesEnabled = useFeatureFlag('goalTemplatesEnabled');
  const {
    menuOpen,
    setMenuOpen,
    position,
    handleContextMenu,
    resetPosition,
    asContextMenu,
  } = useContextMenu();
  const triggerRef = useRef(null);
  const items: Array<{ name: string; text: string }> = [
    { name: 'copy-last', text: t("Copy last month's budget") },
    { name: 'set-zero', text: t('Set budgets to zero') },
    { name: 'set-3-avg', text: t('Set budgets to 3 month average') },
    { name: 'set-6-avg', text: t('Set budgets to 6 month average') },
    { name: 'set-12-avg', text: t('Set budgets to 12 month average') },
    ...(goalTemplatesEnabled
      ? [
          { name: 'check-templates', text: t('Check templates') },
          { name: 'apply-goal-template', text: t('Apply budget template') },
          {
            name: 'overwrite-goal-template',
            text: t('Overwrite with budget template'),
          },
          ...(budgetType === 'envelope'
            ? [
                {
                  name: 'cleanup-goal-template',
                  text: t('End of month cleanup'),
                },
              ]
            : []),
        ]
      : []),
  ];

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('Month actions')}
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{ color: palette.muted, padding: 3 }}
      >
        <SvgDotsHorizontalTriple width={14} height={14} />
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement={asContextMenu ? 'bottom start' : 'bottom end'}
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 250, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu
          onMenuSelect={name => {
            onBudgetAction(month, name, null);
            if (name === 'copy-last') {
              showUndoNotification({
                message: t(
                  "{{displayMonth}} budgets have all been set to last month's budgeted amounts.",
                  { displayMonth },
                ),
              });
            } else if (name === 'set-zero') {
              showUndoNotification({
                message: t(
                  '{{displayMonth}} budgets have all been set to zero.',
                  { displayMonth },
                ),
              });
            } else if (
              name === 'set-3-avg' ||
              name === 'set-6-avg' ||
              name === 'set-12-avg'
            ) {
              const numberOfMonths =
                name === 'set-3-avg' ? 3 : name === 'set-6-avg' ? 6 : 12;
              showUndoNotification({
                message:
                  numberOfMonths === 12
                    ? t(
                        '{{displayMonth}} budgets have all been set to yearly average.',
                        { displayMonth },
                      )
                    : t(
                        '{{displayMonth}} budgets have all been set to {{numberOfMonths}} month average.',
                        { displayMonth, numberOfMonths },
                      ),
              });
            } else if (name === 'apply-goal-template') {
              showUndoNotification({
                message: t(
                  '{{displayMonth}} budget templates have been applied.',
                  { displayMonth },
                ),
              });
            } else if (name === 'overwrite-goal-template') {
              showUndoNotification({
                message: t(
                  '{{displayMonth}} budget templates have been overwritten.',
                  { displayMonth },
                ),
              });
            } else if (name === 'cleanup-goal-template') {
              showUndoNotification({
                message: t(
                  '{{displayMonth}} end-of-month cleanup templates have been applied.',
                  { displayMonth },
                ),
              });
            }
            setMenuOpen(false);
          }}
          items={items}
        />
      </Popover>
    </>
  );
}

function MonthSummaryLane({
  month,
  selectedMonth,
  budgetType,
  collapsed,
  onBudgetAction,
}: {
  month: string;
  selectedMonth: string;
  budgetType: string;
  collapsed: boolean;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const prevMonthName = monthUtils.format(monthUtils.prevMonth(month), 'MMM');
  const isTracking = budgetType === 'tracking';
  const isProjectedTrackingMonth =
    isTracking && month >= monthUtils.currentMonth();

  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
      <View
        data-testid="month-summary-lane"
        data-month={month}
        style={{
          flex: monthLaneFlex,
          borderLeft: '1px solid ' + palette.line,
          backgroundColor: month === selectedMonth ? '#122B44' : palette.panel,
          padding: '8px 10px 9px',
          gap: 6,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ color: palette.text, fontWeight: 850 }}>
            {monthUtils.format(month, 'MMM yyyy', locale)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <NotesButton
              id={`budget-${month}`}
              width={14}
              height={14}
              defaultColor={palette.muted}
            />
            <MonthActionMenu
              month={month}
              budgetType={budgetType}
              onBudgetAction={onBudgetAction}
            />
          </View>
        </View>

        {collapsed ? (
          isTracking ? (
            <LaneMetricRow
              label={
                isProjectedTrackingMonth ? (
                  <Trans>Projected</Trans>
                ) : (
                  <Trans>Saved</Trans>
                )
              }
              emphasized
            >
              <SummaryValue
                binding={
                  (isProjectedTrackingMonth
                    ? trackingBudget.totalBudgetedSaved
                    : trackingBudget.totalSaved) as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
                tone={
                  isProjectedTrackingMonth
                    ? 'projected'
                    : 'strong-negative-aware'
                }
              />
            </LaneMetricRow>
          ) : (
            <LaneMetricRow label={<Trans>To budget</Trans>} emphasized>
              <ToBudgetSummaryValue
                month={month}
                onBudgetAction={onBudgetAction}
              />
            </LaneMetricRow>
          )
        ) : isTracking ? (
          <>
            <LaneMetricRow label={<Trans>Income</Trans>}>
              <TrackingTargetSummaryValue
                current={trackingBudget.totalIncome}
                target={trackingBudget.totalBudgetedIncome}
              />
            </LaneMetricRow>
            <LaneMetricRow label={<Trans>Expenses</Trans>}>
              <TrackingTargetSummaryValue
                current={trackingBudget.totalSpent}
                target={trackingBudget.totalBudgetedExpense}
                tone="negative"
              />
            </LaneMetricRow>
            <LaneMetricRow
              label={
                isProjectedTrackingMonth ? (
                  <Trans>Projected</Trans>
                ) : (
                  <Trans>Saved</Trans>
                )
              }
              emphasized
            >
              <SummaryValue
                binding={
                  (isProjectedTrackingMonth
                    ? trackingBudget.totalBudgetedSaved
                    : trackingBudget.totalSaved) as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
                tone={
                  isProjectedTrackingMonth
                    ? 'projected'
                    : 'strong-negative-aware'
                }
              />
            </LaneMetricRow>
          </>
        ) : (
          <>
            <LaneMetricRow label={<Trans>Available funds</Trans>}>
              <SummaryValue
                binding={
                  envelopeBudget.incomeAvailable as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
              />
            </LaneMetricRow>
            <LaneMetricRow
              label={<Trans>Overspent in {{ prevMonthName }}</Trans>}
            >
              <SummaryValue
                binding={
                  envelopeBudget.lastMonthOverspent as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
                tone="negative"
              />
            </LaneMetricRow>
            <LaneMetricRow label={<Trans>Budgeted</Trans>}>
              <SummaryValue
                binding={
                  envelopeBudget.totalBudgeted as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
              />
            </LaneMetricRow>
            <LaneMetricRow label={<Trans>For next month</Trans>}>
              <SummaryValue
                binding={
                  envelopeBudget.forNextMonth as Binding<
                    'envelope-budget',
                    'budget'
                  >
                }
              />
            </LaneMetricRow>
            <LaneMetricRow label={<Trans>To budget</Trans>} emphasized>
              <ToBudgetSummaryValue
                month={month}
                onBudgetAction={onBudgetAction}
              />
            </LaneMetricRow>
          </>
        )}
      </View>
    </SheetNameProvider>
  );
}

function ToBudgetSummaryValue({
  month,
  onBudgetAction,
}: {
  month: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const {
    menuOpen,
    setMenuOpen,
    position,
    handleContextMenu,
    resetPosition,
    asContextMenu,
  } = useContextMenu();
  const [pickerMode, setPickerMode] = useState<
    'actions' | 'transfer' | 'cover' | 'hold'
  >('actions');
  const triggerRef = useRef(null);
  const popoverFocusRef = useRef<HTMLSpanElement>(null);
  function setPickerModeAndFocus(
    mode: 'actions' | 'transfer' | 'cover' | 'hold',
  ) {
    popoverFocusRef.current?.focus();
    setPickerMode(mode);
  }
  const toBudget = Number(
    useSheetValue(
      envelopeBudget.toBudget as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const forNextMonth = Number(
    useSheetValue(
      envelopeBudget.forNextMonth as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const manualBuffered = Number(
    useSheetValue(
      envelopeBudget.manualBuffered as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const autoBuffered = Number(
    useSheetValue(
      envelopeBudget.autoBuffered as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const items = [
    ...(toBudget > 0
      ? [{ name: 'transfer', text: t('Move to a category') }]
      : []),
    ...(toBudget < 0
      ? [{ name: 'cover', text: t('Cover from a category') }]
      : []),
    ...(autoBuffered === 0 && toBudget > 0
      ? [{ name: 'buffer', text: t('Hold for next month') }]
      : []),
    ...(forNextMonth > 0 && manualBuffered === 0
      ? [{ name: 'disable-auto-buffer', text: t('Disable current auto hold') }]
      : []),
    ...(forNextMonth > 0 && manualBuffered !== 0
      ? [{ name: 'reset-buffer', text: t("Reset next month's buffer") }]
      : []),
  ];

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{
          justifyContent: 'flex-end',
          padding: 0,
          width: '100%',
          color: toBudget < 0 ? palette.danger : palette.text,
          fontWeight: 800,
          ...styles.tnum,
        }}
      >
        <PrivacyFilter>{format(toBudget, 'financial')}</PrivacyFilter>
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement={asContextMenu ? 'bottom start' : 'bottom end'}
        isOpen={menuOpen}
        onOpenChange={() => {
          setMenuOpen(false);
          setPickerMode('actions');
        }}
        style={{ width: 280, margin: 1 }}
        isNonModal
        {...position}
      >
        <span tabIndex={-1} ref={popoverFocusRef}>
          {pickerMode === 'actions' ? (
            <Menu
              onMenuSelect={name => {
                if (name === 'transfer' || name === 'cover') {
                  setPickerModeAndFocus(name);
                  return;
                }
                if (name === 'buffer') {
                  onBudgetAction(month, 'reset-income-carryover', {});
                  setPickerModeAndFocus('hold');
                  return;
                } else if (name === 'reset-buffer') {
                  onBudgetAction(month, 'reset-hold', null);
                } else if (name === 'disable-auto-buffer') {
                  onBudgetAction(month, 'reset-income-carryover', {});
                }
                setMenuOpen(false);
              }}
              items={
                items.length > 0
                  ? items
                  : [
                      {
                        name: 'none',
                        text: t('No actions available'),
                        disabled: true,
                      },
                    ]
              }
            />
          ) : pickerMode === 'hold' ? (
            <HoldMenu
              onClose={() => {
                setMenuOpen(false);
                setPickerMode('actions');
              }}
              onSubmit={amount => {
                onBudgetAction(month, 'hold', {
                  amount,
                });
              }}
            />
          ) : pickerMode === 'transfer' ? (
            <TransferMenu
              initialAmount={toBudget}
              onClose={() => {
                setMenuOpen(false);
                setPickerMode('actions');
              }}
              onSubmit={(amount, categoryId) => {
                onBudgetAction(month, 'transfer-available', {
                  amount,
                  category: categoryId,
                });
              }}
            />
          ) : (
            <CoverMenu
              showToBeBudgeted={false}
              initialAmount={toBudget}
              onClose={() => {
                setMenuOpen(false);
                setPickerMode('actions');
              }}
              onSubmit={(amount, categoryId) => {
                onBudgetAction(month, 'cover-overbudgeted', {
                  amount,
                  category: categoryId,
                  currencyCode: format.currency.code,
                });
              }}
            />
          )}
        </span>
      </Popover>
    </>
  );
}

function MonthSummaryStrip({
  months,
  selectedMonth,
  budgetType,
  categoryWidth,
  showProgressBars,
  collapsed,
  onToggleCollapse,
  onBudgetAction,
}: {
  months: string[];
  selectedMonth: string;
  budgetType: string;
  categoryWidth: number;
  showProgressBars: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const { t } = useTranslation();
  const CollapseIcon = collapsed ? SvgArrowButtonDown1 : SvgArrowButtonRight1;

  return (
    <View
      data-testid="budget-summary"
      style={{
        flexDirection: 'row',
        backgroundColor: palette.panel,
        border: '1px solid ' + palette.line,
        borderRadius: 8,
        boxShadow: styles.cardShadow,
      }}
    >
      <View
        style={{
          ...stickyCategoryColumnStyle(palette.panelAlt, 8),
          width: categoryWidth,
          flexShrink: 0,
          padding: '10px 14px',
          flexDirection: 'row',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <Text
          style={{
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: 800,
            textTransform: 'uppercase',
          }}
        >
          <Trans>Month controls</Trans>
        </Text>
        <Button
          variant="bare"
          aria-label={
            collapsed ? t('Expand month summary') : t('Collapse month summary')
          }
          onPress={onToggleCollapse}
          style={{ color: palette.textMuted, padding: 2 }}
        >
          <CollapseIcon width={12} height={12} />
        </Button>
      </View>
      {months.map(month => (
        <MonthSummaryLane
          key={month}
          month={month}
          selectedMonth={selectedMonth}
          budgetType={budgetType}
          collapsed={collapsed}
          onBudgetAction={onBudgetAction}
        />
      ))}
      {showProgressBars && (
        <View
          style={{
            ...stickyGoalColumnStyle(palette.panelAlt, 8),
            width: GOAL_WIDTH,
            flexShrink: 0,
          }}
        />
      )}
    </View>
  );
}

function ModernBudgetTotalsHooks({
  month,
  budgetType,
}: {
  month: string;
  budgetType: string;
}) {
  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
      <ModernBudgetTotalsValues budgetType={budgetType} />
    </SheetNameProvider>
  );
}

function ModernBudgetTotalsValues({ budgetType }: { budgetType: string }) {
  const format = useFormat();
  const isTracking = budgetType === 'tracking';
  const totalBudgeted = Number(
    useSheetValue(
      (isTracking
        ? trackingBudget.totalBudgetedExpense
        : envelopeBudget.totalBudgeted) as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const totalSpent = Number(
    useSheetValue(
      (isTracking
        ? trackingBudget.totalSpent
        : envelopeBudget.totalSpent) as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );
  const totalLeftover = Number(
    useSheetValue(
      (isTracking
        ? trackingBudget.totalLeftover
        : envelopeBudget.totalBalance) as Binding<'envelope-budget', 'budget'>,
    ) ?? 0,
  );

  return (
    <View
      style={{
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
        clipPath: 'inset(50%)',
      }}
    >
      <Text data-testid="total-budgeted">
        {format(isTracking ? totalBudgeted : -totalBudgeted, 'financial')}
      </Text>
      <Text data-testid="total-spent">{format(totalSpent, 'financial')}</Text>
      <Text data-testid="total-leftover">
        {format(totalLeftover, 'financial')}
      </Text>
    </View>
  );
}

function ModernBalanceValue({
  category,
  month,
  budgetType,
  onBudgetAction,
}: {
  category: CategoryEntity;
  month: string;
  budgetType: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
}) {
  const { t } = useTranslation();
  const bindings = getBindings(budgetType);
  const {
    menuOpen,
    setMenuOpen,
    position,
    handleContextMenu,
    resetPosition,
    asContextMenu,
  } = useContextMenu();
  const [pickerMode, setPickerMode] = useState<
    'actions' | 'transfer' | 'cover'
  >('actions');
  const triggerRef = useRef(null);
  const isEnvelope = budgetType === 'envelope';
  const balance = Number(
    useSheetValue(
      bindings.catBalance(category.id) as Binding<
        'envelope-budget',
        'leftover'
      >,
    ) ?? 0,
  );
  const carryover = Boolean(
    useSheetValue(
      bindings.catCarryover(category.id) as Binding<
        'envelope-budget',
        'carryover'
      >,
    ),
  );

  return (
    <>
      <Button
        ref={triggerRef}
        data-testid="balance"
        variant="bare"
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{
          justifyContent: 'flex-end',
          padding: 0,
          width: '100%',
          color: palette.text,
        }}
      >
        <View data-testid={`budget-balance-${category.id}-${month}`}>
          <BalanceWithCarryover
            carryover={bindings.catCarryover(category.id) as CarryoverBinding}
            balance={bindings.catBalance(category.id) as BalanceBinding}
            goal={bindings.catGoal(category.id) as GoalBinding}
            budgeted={bindings.catBudgeted(category.id) as BudgetBinding}
            longGoal={bindings.catLongGoal(category.id) as LongGoalBinding}
            tooltipDisabled={menuOpen}
          >
            {props => <ModernBalanceText {...props} />}
          </BalanceWithCarryover>
        </View>
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement={asContextMenu ? 'bottom start' : 'bottom end'}
        isOpen={menuOpen}
        onOpenChange={() => {
          setMenuOpen(false);
          setPickerMode('actions');
        }}
        style={{ width: 280, margin: 1 }}
        {...position}
      >
        {pickerMode === 'actions' ? (
          <Menu
            onMenuSelect={type => {
              if (type === 'transfer' || type === 'cover') {
                setPickerMode(type);
                return;
              }
              if (type === 'carryover') {
                onBudgetAction(month, 'carryover', {
                  category: category.id,
                  flag: !carryover,
                });
              }
              setMenuOpen(false);
            }}
            items={[
              ...(isEnvelope && balance > 0
                ? [{ name: 'transfer', text: t('Move balance') }]
                : []),
              ...(isEnvelope && balance < 0
                ? [{ name: 'cover', text: t('Cover overspending') }]
                : []),
              {
                name: 'carryover',
                text: carryover
                  ? t('Remove overspending rollover')
                  : t('Rollover overspending'),
              },
            ]}
          />
        ) : (
          <ModernBalanceMovementMenu
            mode={pickerMode}
            category={category}
            month={month}
            balance={balance}
            onBudgetAction={onBudgetAction}
            onClose={() => {
              setMenuOpen(false);
              setPickerMode('actions');
            }}
          />
        )}
      </Popover>
    </>
  );
}

function ModernBalanceMovementMenu({
  mode,
  category,
  month,
  balance,
  onBudgetAction,
  onClose,
}: {
  mode: 'transfer' | 'cover';
  category: CategoryEntity;
  month: string;
  balance: number;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
  onClose: () => void;
}) {
  const format = useFormat();

  return mode === 'transfer' ? (
    <TransferMenu
      categoryId={category.id}
      initialAmount={balance}
      showToBeBudgeted
      onClose={onClose}
      onSubmit={(amount, toCategoryId) => {
        onBudgetAction(month, 'transfer-category', {
          amount,
          from: category.id,
          to: toCategoryId,
          currencyCode: format.currency.code,
        });
      }}
    />
  ) : (
    <CoverMenu
      categoryId={category.id}
      initialAmount={balance}
      onClose={onClose}
      onSubmit={(amount, fromCategoryId) => {
        onBudgetAction(month, 'cover-overspending', {
          amount,
          from: fromCategoryId,
          to: category.id,
          currencyCode: format.currency.code,
        });
      }}
    />
  );
}

function ModernIncomeBalanceValue({
  category,
  month,
  budgetType,
  onBudgetAction,
  onShowActivity,
}: {
  category: CategoryEntity;
  month: string;
  budgetType: string;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
  onShowActivity: ModernBudgetPageProps['onShowActivity'];
}) {
  const { t } = useTranslation();
  const bindings = getBindings(budgetType);
  const {
    menuOpen,
    setMenuOpen,
    position,
    handleContextMenu,
    resetPosition,
    asContextMenu,
  } = useContextMenu();
  const triggerRef = useRef(null);
  const carryover = Boolean(
    useSheetValue(
      bindings.catCarryover(category.id) as Binding<
        'envelope-budget',
        'carryover'
      >,
    ),
  );

  return (
    <>
      <Button
        ref={triggerRef}
        data-testid="balance"
        variant="bare"
        onPress={() => {
          resetPosition();
          setMenuOpen(true);
        }}
        onContextMenu={handleContextMenu}
        style={{
          justifyContent: 'flex-end',
          padding: 0,
          width: '100%',
          color: palette.text,
        }}
      >
        <BalanceWithCarryover
          carryover={bindings.catCarryover(category.id) as CarryoverBinding}
          balance={bindings.catSumAmount(category.id) as BalanceBinding}
          goal={bindings.catGoal(category.id) as GoalBinding}
          budgeted={bindings.catBudgeted(category.id) as BudgetBinding}
          longGoal={bindings.catLongGoal(category.id) as LongGoalBinding}
          tooltipDisabled={menuOpen}
        >
          {props => <ModernBalanceText {...props} />}
        </BalanceWithCarryover>
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement={asContextMenu ? 'bottom start' : 'bottom end'}
        isOpen={menuOpen}
        onOpenChange={() => setMenuOpen(false)}
        style={{ width: 190, margin: 1 }}
        isNonModal
        {...position}
      >
        <Menu
          onMenuSelect={type => {
            if (type === 'carryover') {
              if (!carryover) {
                onBudgetAction(month, 'reset-hold', null);
              }
              onBudgetAction(month, 'carryover', {
                category: category.id,
                flag: !carryover,
              });
            } else if (type === 'view') {
              onShowActivity(category.id, month);
            }
            setMenuOpen(false);
          }}
          items={[
            {
              name: 'carryover',
              text: carryover ? t('Disable auto hold') : t('Enable auto hold'),
            },
            { name: 'view', text: t('View transactions') },
          ]}
        />
      </Popover>
    </>
  );
}

function SpendingProgressDashes({
  budgetedBinding,
  spentBinding,
}: {
  budgetedBinding: BudgetBinding;
  spentBinding: MoneyBinding;
}) {
  const budgeted = Number(
    useSheetValue(budgetedBinding as Binding<'envelope-budget', 'budget'>) ?? 0,
  );
  const spent = Number(
    useSheetValue(spentBinding as Binding<'envelope-budget', 'sum-amount'>) ??
      0,
  );
  const spentAmount = Math.max(0, -spent);
  const budgetAmount = Math.max(0, budgeted);

  if (budgetAmount <= 0) {
    return null;
  }

  const dashCount = 10;
  const percent = spentAmount / budgetAmount;
  const normalFilled = Math.min(Math.ceil(percent * dashCount), dashCount);
  const overflowPercent = Math.max(
    (spentAmount - budgetAmount) / budgetAmount,
    0,
  );
  const overflowLines = Array.from(
    { length: Math.min(Math.ceil(overflowPercent), 4) },
    (_, index) =>
      Math.min(Math.ceil((overflowPercent - index) * dashCount), dashCount),
  );
  const isOverflowing = overflowLines.length > 0;
  const dashHeight = isOverflowing ? 6 : 14;
  const meterHeight = isOverflowing
    ? 6 * (1 + overflowLines.length) + 2 * overflowLines.length
    : 18;

  function renderDashes(filled: number, color: string, height: number) {
    return Array.from({ length: dashCount }, (_, index) => (
      <View
        key={index}
        data-testid="usage-dash"
        style={{
          width: 3,
          height,
          borderRadius: 1,
          backgroundColor: index < filled ? color : palette.lineStrong,
          opacity: index < filled ? 1 : 0.22,
        }}
      />
    ));
  }

  return (
    <View
      title={`${Math.round(percent * 100)}%`}
      style={{
        gap: isOverflowing ? 2 : 0,
        height: meterHeight,
        justifyContent: 'center',
        alignItems: 'flex-end',
      }}
    >
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {renderDashes(normalFilled, palette.month, dashHeight)}
      </View>
      {isOverflowing && (
        <>
          {overflowLines.map((filled, index) => (
            <View key={index} style={{ flexDirection: 'row', gap: 3 }}>
              {renderDashes(filled, palette.danger, 6)}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

function ModernBalanceText({
  type,
  name,
  value,
  className,
}: {
  type?: FormatType;
  name: string;
  value: number;
  className: string;
}) {
  return (
    <CellValueText
      type={type}
      name={name}
      value={value}
      className={className}
      style={{
        color: value < 0 ? palette.danger : palette.text,
        fontWeight: 800,
        ...styles.tnum,
      }}
    />
  );
}

function GoalStrip({
  category,
  months,
  budgetType,
}: {
  category: CategoryEntity;
  months: string[];
  budgetType: string;
}) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const triggerRef = useRef(null);
  const snapshotMonth = months[months.length - 1];

  return (
    <>
      <Button
        ref={triggerRef}
        variant="bare"
        aria-label={t('Goal details')}
        onPress={() => setPopoverOpen(true)}
        style={{
          ...stickyGoalColumnStyle(palette.panel),
          width: GOAL_WIDTH,
          flexShrink: 0,
          padding: 0,
        }}
      >
        <View
          style={{
            flex: 1,
            alignSelf: 'stretch',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {snapshotMonth && (
            <SheetNameProvider name={monthUtils.sheetForMonth(snapshotMonth)}>
              <GoalStripMonth category={category} budgetType={budgetType} />
            </SheetNameProvider>
          )}
        </View>
      </Button>
      <Popover
        triggerRef={triggerRef}
        placement="bottom end"
        isOpen={popoverOpen}
        onOpenChange={setPopoverOpen}
        style={{ width: 260, margin: 1, padding: 10 }}
      >
        <View style={{ gap: 8 }}>
          <Text style={{ color: palette.text, fontWeight: 850 }}>
            {category.name}
          </Text>
          {months.map(month => (
            <SheetNameProvider
              key={month}
              name={monthUtils.sheetForMonth(month)}
            >
              <GoalPopoverMonth
                month={month}
                category={category}
                budgetType={budgetType}
              />
            </SheetNameProvider>
          ))}
        </View>
      </Popover>
    </>
  );
}

function GoalStripMonth({
  category,
  budgetType,
}: {
  category: CategoryEntity;
  budgetType: string;
}) {
  const bindings = getBindings(budgetType);
  const balance = Number(
    useSheetValue(
      bindings.catBalance(category.id) as Binding<
        'envelope-budget',
        'leftover'
      >,
    ),
  );
  const goal = Number(
    useSheetValue(
      bindings.catGoal(category.id) as Binding<'envelope-budget', 'goal'>,
    ),
  );
  const isLongGoal =
    Number(
      useSheetValue(
        bindings.catLongGoal(category.id) as Binding<
          'envelope-budget',
          'long-goal'
        >,
      ),
    ) === 1;
  const percent = goal > 0 && isLongGoal ? Math.min(balance / goal, 1) : 0;
  const dashCount = 10;
  const filled = Math.min(Math.ceil(percent * dashCount), dashCount);
  const color = percent >= 1 ? palette.cash : palette.amber;

  if (goal <= 0 || !isLongGoal) {
    return <View style={{ flex: 1, minWidth: 0 }} />;
  }

  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
      }}
    >
      <View style={{ flexDirection: 'row', gap: 3 }}>
        {Array.from({ length: dashCount }, (_, index) => (
          <View
            key={index}
            data-testid="goal-dash"
            style={{
              width: 3,
              height: 14,
              borderRadius: 2,
              backgroundColor: index < filled ? color : palette.lineStrong,
              opacity: index < filled ? 1 : 0.25,
            }}
          />
        ))}
      </View>
    </View>
  );
}

function GoalPopoverMonth({
  month,
  category,
  budgetType,
}: {
  month: string;
  category: CategoryEntity;
  budgetType: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const format = useFormat();
  const bindings = getBindings(budgetType);
  const balance = Number(
    useSheetValue(
      bindings.catBalance(category.id) as Binding<
        'envelope-budget',
        'leftover'
      >,
    ) ?? 0,
  );
  const goal = Number(
    useSheetValue(
      bindings.catGoal(category.id) as Binding<'envelope-budget', 'goal'>,
    ) ?? 0,
  );
  const isLongGoal =
    Number(
      useSheetValue(
        bindings.catLongGoal(category.id) as Binding<
          'envelope-budget',
          'long-goal'
        >,
      ) ?? 0,
    ) === 1;
  const percent = goal > 0 && isLongGoal ? Math.min(balance / goal, 1) : 0;

  return (
    <View style={{ gap: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text style={{ color: palette.muted, fontWeight: 700 }}>
          {monthUtils.format(month, 'MMM', locale)}
        </Text>
        <Text
          style={{
            color:
              goal > 0 && isLongGoal
                ? percent >= 1
                  ? palette.cash
                  : palette.amber
                : palette.muted,
            fontWeight: 800,
            ...styles.tnum,
          }}
        >
          <PrivacyFilter>
            {goal > 0 && isLongGoal
              ? `${format(balance, 'financial')} of ${format(goal, 'financial')}`
              : format(balance, 'financial')}
          </PrivacyFilter>
        </Text>
      </View>
      <View style={{ height: 4, backgroundColor: palette.line }}>
        {balance > 0 && (
          <View
            style={{
              height: 4,
              width:
                goal > 0 && isLongGoal
                  ? `${Math.max(percent * 100, 2)}%`
                  : '100%',
              backgroundColor:
                goal > 0 && isLongGoal
                  ? percent >= 1
                    ? palette.cash
                    : palette.amber
                  : palette.muted,
            }}
          />
        )}
      </View>
    </View>
  );
}

function MonthCategoryCell({
  category,
  month,
  selectedMonth,
  budgetType,
  showProgressBars,
  categoryGroups,
  editingCell,
  setEditingCell,
  onBudgetAction,
  onShowActivity,
}: {
  category: CategoryEntity;
  month: string;
  selectedMonth: string;
  budgetType: string;
  showProgressBars: boolean;
  categoryGroups: CategoryGroupEntity[];
  editingCell: { id: string; month: string } | null;
  setEditingCell: (cell: { id: string; month: string } | null) => void;
  onBudgetAction: ModernBudgetPageProps['onBudgetAction'];
  onShowActivity: ModernBudgetPageProps['onShowActivity'];
}) {
  const bindings = getBindings(budgetType);
  const isEnvelopeIncome = budgetType === 'envelope' && category.is_income;
  const isTrackingIncome = budgetType === 'tracking' && category.is_income;
  const showBalance = budgetType === 'envelope' || !category.is_income;
  const showProgress = showProgressBars && !category.is_income;
  const showThirdColumn = showProgress || showBalance;
  const monthNoteId = `${category.id}-${month}`;
  const hasMonthNote = (useNotes(monthNoteId) || '') !== '';

  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
      <View
        style={{
          flex: monthLaneFlex,
          borderLeft: '1px solid ' + palette.line,
          backgroundColor: month === selectedMonth ? '#122B44' : palette.panel,
        }}
      >
        <View
          style={{
            minHeight: isEnvelopeIncome ? 30 : 42,
            padding: isEnvelopeIncome ? '3px 10px' : '4px 8px 3px',
            justifyContent: 'center',
            ':hover .month-cell-hover-action, :focus-within .month-cell-hover-action':
              {
                opacity: 1,
              },
          }}
        >
          {isEnvelopeIncome ? (
            <LaneMetricRow label={<Trans>Received</Trans>} emphasized>
              <ModernIncomeBalanceValue
                category={category}
                month={month}
                budgetType={budgetType}
                onBudgetAction={onBudgetAction}
                onShowActivity={onShowActivity}
              />
            </LaneMetricRow>
          ) : (
            <View
              style={{
                display: 'grid',
                gridTemplateColumns: showThirdColumn
                  ? monthValueColumns
                  : monthValueColumnsWithoutBalance,
                alignItems: 'center',
                columnGap: 8,
              }}
            >
              <View
                className={hasMonthNote ? undefined : 'month-cell-hover-action'}
                style={{
                  minWidth: 0,
                  alignItems: 'center',
                  opacity: hasMonthNote ? 1 : 0,
                }}
              >
                <NotesButton
                  id={monthNoteId}
                  defaultColor={palette.muted}
                  showPlaceholder
                />
              </View>
              <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                {isTrackingIncome && (
                  <Text
                    style={{
                      color: palette.textMuted,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    <Trans>Budgeted</Trans>
                  </Text>
                )}
                <BudgetAmountCell
                  category={category}
                  month={month}
                  budgetType={budgetType}
                  editingCell={editingCell}
                  setEditingCell={setEditingCell}
                  onBudgetAction={onBudgetAction}
                />
              </View>
              <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                {isTrackingIncome && (
                  <Text
                    style={{
                      color: palette.textMuted,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    <Trans>Received</Trans>
                  </Text>
                )}
                <View
                  style={{
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 4,
                  }}
                >
                  <ScheduleIndicator category={category} month={month} />
                  <Button
                    data-testid="category-month-spent"
                    variant="bare"
                    onPress={() => onShowActivity(category.id, month)}
                    style={{
                      justifyContent: 'flex-end',
                      padding: 0,
                      color: palette.text,
                      fontWeight: 600,
                      ...styles.tnum,
                    }}
                  >
                    <MoneyValue
                      binding={
                        bindings.catSumAmount(category.id) as Binding<
                          'envelope-budget',
                          'sum-amount'
                        >
                      }
                      tone="subdued"
                    />
                  </Button>
                </View>
              </View>
              {showThirdColumn && (
                <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                  {showProgress ? (
                    <View
                      style={{
                        width: '100%',
                        display: 'grid',
                        gridTemplateColumns: '1fr',
                        alignItems: 'center',
                        ':hover .month-cell-usage-action, :focus-within .month-cell-usage-action':
                          {
                            opacity: 0,
                          },
                        ':hover .month-cell-balance-action, :focus-within .month-cell-balance-action':
                          {
                            opacity: 1,
                          },
                      }}
                    >
                      <View
                        className="month-cell-usage-action"
                        style={{
                          gridArea: '1 / 1',
                          alignItems: 'flex-end',
                          opacity: 1,
                        }}
                      >
                        <SpendingProgressDashes
                          budgetedBinding={
                            bindings.catBudgeted(category.id) as BudgetBinding
                          }
                          spentBinding={
                            bindings.catSumAmount(category.id) as MoneyBinding
                          }
                        />
                      </View>
                      <View
                        data-testid="balance"
                        className="month-cell-balance-action"
                        style={{
                          gridArea: '1 / 1',
                          alignItems: 'flex-end',
                          opacity: 0,
                        }}
                      >
                        <ModernBalanceValue
                          category={category}
                          month={month}
                          budgetType={budgetType}
                          onBudgetAction={onBudgetAction}
                        />
                      </View>
                    </View>
                  ) : (
                    <View data-testid="balance" style={{ width: '100%' }}>
                      <ModernBalanceValue
                        category={category}
                        month={month}
                        budgetType={budgetType}
                        onBudgetAction={onBudgetAction}
                      />
                    </View>
                  )}
                </View>
              )}
              <View
                className="month-cell-hover-action"
                style={{ minWidth: 0, alignItems: 'center', opacity: 0 }}
              >
                <CategoryBudgetActionMenu
                  category={category}
                  month={month}
                  budgetType={budgetType}
                  onBudgetAction={onBudgetAction}
                />
              </View>
            </View>
          )}
        </View>
      </View>
    </SheetNameProvider>
  );
}

function MonthGroupCell({
  group,
  month,
  budgetType,
  showProgressBars,
}: {
  group: CategoryGroupEntity;
  month: string;
  budgetType: string;
  showProgressBars: boolean;
}) {
  const bindings = getBindings(budgetType);
  const isEnvelopeIncome = budgetType === 'envelope' && group.is_income;
  const isTrackingIncome = budgetType === 'tracking' && group.is_income;
  const showBalance = budgetType === 'envelope' || !group.is_income;
  const showProgress = showProgressBars && !group.is_income;
  const showThirdColumn = showProgress || showBalance;

  return (
    <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
      <View
        data-testid="group-month-cell"
        style={{
          flex: monthLaneFlex,
          borderLeft: '1px solid ' + palette.line,
          backgroundColor: palette.panelRaised,
        }}
      >
        <View
          style={{
            minHeight: isEnvelopeIncome ? 30 : 36,
            padding: isEnvelopeIncome ? '3px 10px' : '4px 8px',
            justifyContent: 'center',
          }}
        >
          {isEnvelopeIncome ? (
            <LaneMetricRow label={<Trans>Received</Trans>} emphasized>
              <MoneyValue
                binding={
                  envelopeBudget.groupIncomeReceived as Binding<
                    'envelope-budget',
                    'sum-amount'
                  >
                }
              />
            </LaneMetricRow>
          ) : (
            <View
              style={{
                display: 'grid',
                gridTemplateColumns: showThirdColumn
                  ? monthValueColumns
                  : monthValueColumnsWithoutBalance,
                alignItems: 'center',
                columnGap: 8,
              }}
            >
              <View />
              <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                {isTrackingIncome && (
                  <Text
                    style={{
                      color: palette.textMuted,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    <Trans>Budgeted</Trans>
                  </Text>
                )}
                <MoneyValue
                  binding={
                    bindings.groupBudgeted(group.id) as Binding<
                      'envelope-budget',
                      'budget'
                    >
                  }
                />
              </View>
              <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                {isTrackingIncome && (
                  <Text
                    style={{
                      color: palette.textMuted,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                    }}
                  >
                    <Trans>Received</Trans>
                  </Text>
                )}
                <MoneyValue
                  binding={
                    bindings.groupSumAmount(group.id) as Binding<
                      'envelope-budget',
                      'sum-amount'
                    >
                  }
                />
              </View>
              {showThirdColumn && (
                <View style={{ minWidth: 0, alignItems: 'flex-end' }}>
                  {showProgress ? (
                    <SpendingProgressDashes
                      budgetedBinding={
                        bindings.groupBudgeted(group.id) as BudgetBinding
                      }
                      spentBinding={
                        bindings.groupSumAmount(group.id) as MoneyBinding
                      }
                    />
                  ) : (
                    <MoneyValue
                      binding={
                        bindings.groupBalance(group.id) as Binding<
                          'envelope-budget',
                          'leftover'
                        >
                      }
                      tone="balance"
                    />
                  )}
                </View>
              )}
              <View />
            </View>
          )}
        </View>
      </View>
    </SheetNameProvider>
  );
}

function ModernHeader({
  budgetType,
  startMonth,
  months,
  monthBounds,
  onMonthSelect,
}: {
  budgetType: string;
  startMonth: string;
  months: string[];
  monthBounds: MonthBounds;
  onMonthSelect: (month: string, numMonths: number) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  function selectMonth(month: string, monthCount = months.length) {
    const end = monthUtils.subMonths(monthBounds.end, monthCount - 1);

    if (month < monthBounds.start) {
      onMonthSelect(monthBounds.start, monthCount);
    } else if (month > end) {
      onMonthSelect(end, monthCount);
    } else {
      onMonthSelect(month, monthCount);
    }
  }
  useHotkeys(
    'left',
    () => selectMonth(monthUtils.prevMonth(startMonth)),
    { preventDefault: true, scopes: ['app'] },
    [monthBounds, months.length, onMonthSelect, startMonth],
  );
  useHotkeys(
    'right',
    () => selectMonth(monthUtils.nextMonth(startMonth)),
    { preventDefault: true, scopes: ['app'] },
    [monthBounds, months.length, onMonthSelect, startMonth],
  );
  useHotkeys(
    '0',
    () =>
      selectMonth(
        monthUtils.subMonths(
          monthUtils.currentMonth(),
          budgetType === 'envelope'
            ? Math.floor((months.length - 1) / 2)
            : months.length === 2
              ? 1
              : Math.max(months.length - 2, 0),
        ),
      ),
    { preventDefault: true, scopes: ['app'] },
    [budgetType, monthBounds, months.length, onMonthSelect],
  );

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: 10,
        flexShrink: 0,
      }}
    >
      <View
        style={{
          width: 250,
          padding: '12px 14px',
          backgroundColor: palette.panel,
          border: '1px solid ' + palette.line,
          borderRadius: 8,
          boxShadow: styles.cardShadow,
        }}
      >
        <Text
          style={{
            color: palette.textMuted,
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
          }}
        >
          <Trans>Budget</Trans>
        </Text>
        <Text
          style={{
            color: palette.text,
            fontSize: 24,
            fontWeight: 800,
            lineHeight: 1.12,
            marginTop: 4,
          }}
        >
          {monthUtils.format(startMonth, 'MMMM yyyy', locale)}
        </Text>
        <Text style={{ color: palette.muted, fontSize: 12, marginTop: 6 }}>
          <PrivacyFilter>{budgetType}</PrivacyFilter>
        </Text>
      </View>

      <View
        style={{
          flex: 1,
          minWidth: 0,
          padding: '12px 14px',
          backgroundColor: palette.panel,
          border: '1px solid ' + palette.line,
          borderRadius: 8,
          boxShadow: styles.cardShadow,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Text
            style={{
              color: palette.textMuted,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
            }}
          >
            <Trans>Month runway</Trans>
          </Text>
          <Button
            variant="bare"
            aria-label={t('Today')}
            onPress={() => selectMonth(monthUtils.currentMonth())}
            style={{ color: palette.textMuted, padding: 2 }}
          >
            <SvgCalendar3 width={14} height={14} />
          </Button>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'stretch',
            gap: 4,
            height: 30,
          }}
        >
          <View title={t('Previous month')}>
            <Button
              variant="bare"
              onPress={() => selectMonth(monthUtils.prevMonth(startMonth))}
              style={{ color: palette.text, padding: '2px 8px' }}
            >
              <Trans>Prev</Trans>
            </Button>
          </View>
          {months.map(month => {
            const isCurrent = monthUtils.isCurrentMonth(month);
            const displayMonth = monthUtils.format(month, 'MMM/yy', locale);

            return (
              <Button
                key={month}
                variant="bare"
                data-testid={
                  month === startMonth ? 'selected-budget-month' : undefined
                }
                data-month={month === startMonth ? month : undefined}
                aria-label={monthUtils.format(month, 'MMMM yyyy', locale)}
                onPress={() => selectMonth(month)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  borderRadius: 6,
                  backgroundColor: isCurrent ? palette.month : palette.panelAlt,
                  border:
                    '1px solid ' + (isCurrent ? palette.month : palette.line),
                }}
              >
                <Text
                  style={{
                    color: isCurrent ? 'white' : palette.text,
                    fontSize: 12,
                    fontWeight: 800,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {displayMonth}
                </Text>
              </Button>
            );
          })}
          <View title={t('Next month')}>
            <Button
              variant="bare"
              onPress={() => selectMonth(monthUtils.nextMonth(startMonth))}
              style={{ color: palette.text, padding: '2px 8px' }}
            >
              <Trans>Next</Trans>
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

export function ModernBudgetPage({
  budgetType,
  categoryGroups,
  startMonth,
  maxMonths,
  summaryCollapsed,
  monthBounds,
  onMonthSelect,
  onToggleSummaryCollapse,
  onBudgetAction,
  onShowActivity,
  onSaveCategory,
  onDeleteCategory,
  onSaveGroup,
  onDeleteGroup,
  onApplyBudgetTemplatesInGroup,
  onReorderCategory,
  onReorderGroup,
  onSortCategories,
}: ModernBudgetPageProps) {
  const { t } = useTranslation();
  const { setDisplayMax } = useBudgetMonthCount();
  const months = getVisibleMonths(startMonth, maxMonths, monthBounds);
  const visibleStartMonth = months[0] ?? startMonth;
  const isGoalTemplatesEnabled = useFeatureFlag('goalTemplatesEnabled');
  const [, setMaxMonthsPref] = useGlobalPref('maxMonths');
  const [categoryExpandedStatePref, setCategoryExpandedStatePref] =
    useGlobalPref('categoryExpandedState');
  const categoryExpandedState = categoryExpandedStatePref ?? 0;
  const categoryWidth =
    CATEGORY_WIDTHS[categoryExpandedState] ?? CATEGORY_WIDTHS[0];
  const [collapsedGroupIds = [], setCollapsedGroupIdsPref] =
    useLocalPref('budget.collapsed');
  const [showHiddenCategories = false, setShowHiddenCategories] = useLocalPref(
    'budget.showHiddenCategories',
  );
  const [showProgressBars = true, setShowProgressBars] = useLocalPref(
    'budget.showProgressBars',
  );
  const [editingCell, setEditingCell] = useState<{
    id: string;
    month: string;
  } | null>(null);
  const [editingName, setEditingName] = useState<{
    type: 'group' | 'category';
    id: string;
  } | null>(null);
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newCategoryForGroup, setNewCategoryForGroup] = useState<string | null>(
    null,
  );
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [isPanningBudget, setIsPanningBudget] = useState(false);
  const summaryScrollRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dragItemRef = useRef<DragItem | null>(null);
  const panStateRef = useRef<PanState | null>(null);
  const longHoverGroupRef = useRef<{
    id: CategoryGroupEntity['id'];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const blockClickUntilRef = useRef(0);
  const bodyUserSelectRef = useRef<string | null>(null);
  const schedulesQuery = useMemo(() => q('schedules').select('*'), []);
  const scrollbarWidth = styles.scrollbarWidth ?? 0;

  useLayoutEffect(() => {
    const savedScrollPosition = sessionStorage.getItem(
      'budget-scroll-position',
    );
    if (savedScrollPosition != null && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = Number(savedScrollPosition);
      sessionStorage.removeItem('budget-scroll-position');
    }
  }, []);

  useEffect(() => {
    setDisplayMax(months.length);
  }, [months.length, setDisplayMax]);
  useHotkeys(
    'shift+t',
    () => {
      onBudgetAction(visibleStartMonth, 'overwrite-goal-template', null);
    },
    {
      preventDefault: true,
      scopes: ['app'],
      enabled: isGoalTemplatesEnabled,
    },
    [onBudgetAction, visibleStartMonth, isGoalTemplatesEnabled],
  );

  useEffect(() => {
    return () => {
      if (longHoverGroupRef.current) {
        clearTimeout(longHoverGroupRef.current.timer);
      }
      if (bodyUserSelectRef.current != null) {
        document.body.style.userSelect = bodyUserSelectRef.current;
      }
    };
  }, []);

  const toggleGroup = (id: CategoryGroupEntity['id']) => {
    setCollapsedGroupIdsPref(
      collapsedGroupIds.includes(id)
        ? collapsedGroupIds.filter(groupId => groupId !== id)
        : [...collapsedGroupIds, id],
    );
  };
  const clearLongHoverGroup = () => {
    if (!longHoverGroupRef.current) {
      return;
    }

    clearTimeout(longHoverGroupRef.current.timer);
    longHoverGroupRef.current = null;
  };
  const startLongHoverGroup = (group: CategoryGroupEntity) => {
    if (longHoverGroupRef.current?.id === group.id) {
      return;
    }

    clearLongHoverGroup();
    longHoverGroupRef.current = {
      id: group.id,
      timer: setTimeout(() => {
        setCollapsedGroupIdsPref(
          collapsedGroupIds.filter(groupId => groupId !== group.id),
        );
        longHoverGroupRef.current = null;
      }, 650),
    };
  };
  const cycleCategoryWidth = () => {
    setCategoryExpandedStatePref((categoryExpandedState + 1) % 3);
  };
  const expandAllGroups = () => {
    setCollapsedGroupIdsPref([]);
  };
  const collapseAllGroups = () => {
    setCollapsedGroupIdsPref(categoryGroups.map(group => group.id));
  };

  const showActivity = (categoryId: CategoryEntity['id'], month?: string) => {
    if (scrollContainerRef.current) {
      sessionStorage.setItem(
        'budget-scroll-position',
        String(scrollContainerRef.current.scrollTop),
      );
    }
    onShowActivity(categoryId, month);
  };

  const visibleGroups = categoryGroups.filter(
    group => group.is_income || showHiddenCategories || !group.hidden,
  );
  const sortableGroups = visibleGroups.filter(group => !group.is_income);

  function saveNewCategory(group: CategoryGroupEntity, name: string) {
    onSaveCategory({
      id: 'new',
      name,
      group: group.id,
      is_income: group.is_income,
    });
    setNewCategoryForGroup(null);
  }

  function moveEditingCell(dir: 1 | -1) {
    if (!editingCell) {
      return;
    }

    const flattened = visibleGroups.flatMap(group => {
      if (collapsedGroupIds.includes(group.id)) {
        return [];
      }

      return (group.categories || []).filter(
        category => showHiddenCategories || !category.hidden,
      );
    });
    const currentIndex = flattened.findIndex(
      category => category.id === editingCell.id,
    );

    for (
      let index = currentIndex + dir;
      index >= 0 && index < flattened.length;
      index += dir
    ) {
      const category = flattened[index];
      if (budgetType === 'tracking' || !category.is_income) {
        setEditingCell({ id: category.id, month: editingCell.month });
        return;
      }
    }
  }

  function onTableKeyDown(event: KeyboardEvent) {
    if (!editingCell || (event.key !== 'Enter' && event.key !== 'Tab')) {
      return;
    }

    event.preventDefault();
    moveEditingCell(event.shiftKey ? -1 : 1);
  }

  function syncSummaryScroll() {
    if (summaryScrollRef.current && scrollContainerRef.current) {
      summaryScrollRef.current.scrollLeft =
        scrollContainerRef.current.scrollLeft;
    }
  }

  function restorePanTextSelection() {
    if (bodyUserSelectRef.current != null) {
      document.body.style.userSelect = bodyUserSelectRef.current;
      bodyUserSelectRef.current = null;
    }
  }

  function finishBudgetPan(event: PointerEvent<HTMLDivElement>) {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) {
      return;
    }

    if (panState.moved) {
      blockClickUntilRef.current = Date.now() + 250;
      window.getSelection()?.removeAllRanges();
      event.preventDefault();
    }

    event.currentTarget.releasePointerCapture(event.pointerId);
    panStateRef.current = null;
    restorePanTextSelection();
    setIsPanningBudget(false);
  }

  function onBudgetPanStart(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !scrollContainerRef.current) {
      return;
    }

    const bounds = scrollContainerRef.current.getBoundingClientRect();
    const isStickyCategory = event.clientX <= bounds.left + categoryWidth;
    const isStickyGoal =
      showProgressBars && event.clientX >= bounds.right - GOAL_WIDTH;
    const target = event.target as Element;

    if (
      isStickyCategory ||
      isStickyGoal ||
      target.closest(
        'button, a, input, textarea, select, [role="button"], [contenteditable="true"], [data-testid="budget"]',
      )
    ) {
      return;
    }

    panStateRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scrollContainerRef.current.scrollLeft,
      scrollTop: scrollContainerRef.current.scrollTop,
      moved: false,
    };
    bodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onBudgetPanMove(event: PointerEvent<HTMLDivElement>) {
    const panState = panStateRef.current;
    if (
      !panState ||
      panState.pointerId !== event.pointerId ||
      !scrollContainerRef.current
    ) {
      return;
    }

    const dx = event.clientX - panState.x;
    const dy = event.clientY - panState.y;
    if (!panState.moved && Math.abs(dx) + Math.abs(dy) < 4) {
      return;
    }

    panState.moved = true;
    setIsPanningBudget(true);
    scrollContainerRef.current.scrollLeft = panState.scrollLeft - dx;
    scrollContainerRef.current.scrollTop = panState.scrollTop - dy;
    event.preventDefault();
  }

  return (
    <View
      data-testid="budget-table"
      style={{
        ...styles.page,
        padding: 12,
        overflow: 'hidden',
        backgroundColor: palette.page,
      }}
    >
      <View style={{ flex: 1, minHeight: 0, gap: 10 }}>
        <ModernHeader
          budgetType={budgetType}
          startMonth={visibleStartMonth}
          months={months}
          monthBounds={monthBounds}
          onMonthSelect={onMonthSelect}
        />

        <SchedulesProvider query={schedulesQuery}>
          <View
            ref={summaryScrollRef}
            style={{
              position: 'relative',
              zIndex: 8,
              overflow: 'hidden',
              flexShrink: 0,
              width: `calc(100% - ${scrollbarWidth}px)`,
            }}
          >
            <View
              style={{
                minWidth:
                  categoryWidth +
                  MONTH_WIDTH * months.length +
                  (showProgressBars ? GOAL_WIDTH : 0),
              }}
            >
              <MonthSummaryStrip
                months={months}
                selectedMonth={visibleStartMonth}
                budgetType={budgetType}
                categoryWidth={categoryWidth}
                showProgressBars={showProgressBars}
                collapsed={summaryCollapsed}
                onToggleCollapse={onToggleSummaryCollapse}
                onBudgetAction={onBudgetAction}
              />
            </View>
          </View>

          <View
            ref={scrollContainerRef}
            data-testid="budget-table-scroll-container"
            onScroll={syncSummaryScroll}
            onPointerDown={onBudgetPanStart}
            onPointerMove={onBudgetPanMove}
            onPointerUp={finishBudgetPan}
            onPointerCancel={finishBudgetPan}
            onSelectCapture={event => {
              if (panStateRef.current) {
                event.preventDefault();
              }
            }}
            onClickCapture={event => {
              if (Date.now() < blockClickUntilRef.current) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            style={{
              flex: 1,
              minHeight: 0,
              backgroundColor: palette.panel,
              border: '1px solid ' + palette.line,
              borderRadius: 8,
              overflow: 'auto',
              boxShadow: styles.cardShadow,
              cursor: isPanningBudget ? 'grabbing' : 'grab',
              userSelect: 'none',
              scrollbarColor: `${palette.muted} ${palette.panelAlt}`,
              '::-webkit-scrollbar': {
                width: 12,
                height: 12,
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
              onKeyDown={onTableKeyDown}
              style={{
                minWidth:
                  categoryWidth +
                  MONTH_WIDTH * months.length +
                  (showProgressBars ? GOAL_WIDTH : 0),
              }}
            >
              <View
                data-testid="budget-totals"
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  flexShrink: 0,
                  flexDirection: 'row',
                  minHeight: 64,
                  backgroundColor: palette.panelAlt,
                  borderBottom: '1px solid ' + palette.lineStrong,
                }}
              >
                <ModernBudgetTotalsHooks
                  month={visibleStartMonth}
                  budgetType={budgetType}
                />
                <View
                  style={{
                    ...stickyCategoryColumnStyle(palette.panelAlt, 11),
                    width: categoryWidth,
                    flexShrink: 0,
                    justifyContent: 'center',
                    padding: '0 14px',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Text
                    style={{
                      color: palette.textMuted,
                      fontWeight: 800,
                      flex: 1,
                    }}
                  >
                    <Trans>Category</Trans>
                  </Text>
                  <CategoryHeaderMenu
                    startMonth={visibleStartMonth}
                    maxMonths={maxMonths}
                    months={months}
                    monthBounds={monthBounds}
                    showHiddenCategories={showHiddenCategories}
                    setShowHiddenCategories={setShowHiddenCategories}
                    showProgressBars={showProgressBars}
                    setShowProgressBars={setShowProgressBars}
                    categoryExpandedState={categoryExpandedState}
                    summaryCollapsed={summaryCollapsed}
                    onToggleSummaryCollapse={onToggleSummaryCollapse}
                    onCycleCategoryWidth={cycleCategoryWidth}
                    onExpandAllGroups={expandAllGroups}
                    onCollapseAllGroups={collapseAllGroups}
                    onMonthCountChange={setMaxMonthsPref}
                    onMonthSelect={onMonthSelect}
                    onAddGroup={() => setIsAddingGroup(true)}
                  />
                </View>
                {months.map(month => (
                  <View
                    key={month}
                    style={{
                      flex: monthLaneFlex,
                      borderLeft: '1px solid ' + palette.line,
                      padding: '7px 8px',
                      gap: 6,
                    }}
                  >
                    <Text style={{ color: palette.text, fontWeight: 800 }}>
                      {monthUtils.format(month, 'MMM yyyy')}
                    </Text>
                    <View
                      style={{
                        display: 'grid',
                        gridTemplateColumns: monthValueColumns,
                        columnGap: 8,
                      }}
                    >
                      <View />
                      {[
                        <Trans>Budgeted</Trans>,
                        <Trans>Spent</Trans>,
                        showProgressBars ? (
                          <Trans>Usage</Trans>
                        ) : (
                          <Trans>Balance</Trans>
                        ),
                      ].map((label, index) => (
                        <Text
                          key={index}
                          style={{
                            color: palette.textMuted,
                            fontSize: 11,
                            fontWeight: 700,
                            textAlign: 'right',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {label}
                        </Text>
                      ))}
                      <View />
                    </View>
                  </View>
                ))}
                {showProgressBars && (
                  <View
                    style={{
                      ...stickyGoalColumnStyle(palette.panelAlt, 11),
                      width: GOAL_WIDTH,
                      flexShrink: 0,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: palette.textMuted, fontWeight: 800 }}>
                      <Trans>Goal</Trans>
                    </Text>
                  </View>
                )}
              </View>

              {isAddingGroup && (
                <View
                  style={{
                    flexDirection: 'row',
                    flexShrink: 0,
                    minHeight: 54,
                    backgroundColor: palette.panelRaised,
                    borderBottom: '1px solid ' + palette.line,
                  }}
                >
                  <View
                    style={{
                      ...stickyCategoryColumnStyle(palette.panelRaised),
                      width: categoryWidth,
                      flexShrink: 0,
                      justifyContent: 'center',
                      padding: '0 14px',
                    }}
                  >
                    <InlineNameEditor
                      placeholder={t('New group name')}
                      onCancel={() => setIsAddingGroup(false)}
                      onSave={name => {
                        onSaveGroup({ id: 'new', name });
                        setIsAddingGroup(false);
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }} />
                </View>
              )}

              {visibleGroups.map(group => {
                const categories = (group.categories || []).filter(
                  category => showHiddenCategories || !category.hidden,
                );
                const isCollapsed = collapsedGroupIds.includes(group.id);
                const groupIndex = sortableGroups.findIndex(
                  item => item.id === group.id,
                );
                const previousGroup = sortableGroups[groupIndex - 1];
                const nextGroup = sortableGroups[groupIndex + 1];
                const afterNextGroup = sortableGroups[groupIndex + 2];
                const groupDragKey = `group:${group.id}`;
                const startGroupDrag = (event: DragEvent) => {
                  if (
                    group.is_income ||
                    isInteractiveDragTarget(event.target)
                  ) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', group.id);
                  const item: DragItem = { type: 'group', id: group.id };
                  dragItemRef.current = item;
                };

                return (
                  <View key={group.id} style={{ flexShrink: 0 }}>
                    <View
                      onDragEnd={() => {
                        clearLongHoverGroup();
                        dragItemRef.current = null;
                        setDragTarget(null);
                      }}
                      onDragOver={event => {
                        const activeDragItem = dragItemRef.current;
                        if (
                          !activeDragItem ||
                          (activeDragItem.type === 'group' &&
                            group.is_income) ||
                          (activeDragItem.type === 'category' &&
                            activeDragItem.isIncome !== group.is_income)
                        ) {
                          return;
                        }
                        event.preventDefault();
                        setDragTarget(groupDragKey);
                        if (
                          isCollapsed &&
                          activeDragItem.type === 'category' &&
                          activeDragItem.groupId !== group.id
                        ) {
                          startLongHoverGroup(group);
                        }
                      }}
                      onDragLeave={event => {
                        if (
                          event.relatedTarget instanceof Node &&
                          event.currentTarget.contains(event.relatedTarget)
                        ) {
                          return;
                        }

                        clearLongHoverGroup();
                      }}
                      onDrop={event => {
                        event.preventDefault();
                        clearLongHoverGroup();
                        setDragTarget(null);
                        const activeDragItem = dragItemRef.current;

                        if (activeDragItem?.type === 'group') {
                          const { targetId } = findSortDown(
                            sortableGroups,
                            getDropPosition(event),
                            group.id,
                          );
                          if (activeDragItem.id !== group.id) {
                            onReorderGroup?.({
                              id: activeDragItem.id,
                              targetId,
                            });
                          }
                        } else if (
                          activeDragItem?.type === 'category' &&
                          activeDragItem.isIncome === group.is_income
                        ) {
                          const dropPosition = getDropPosition(event);
                          const { targetId: groupId } = findSortUp(
                            visibleGroups,
                            dropPosition,
                            group.id,
                          );
                          const targetGroup = visibleGroups.find(
                            group => group.id === groupId,
                          );

                          if (targetGroup) {
                            const targetCategories =
                              targetGroup.categories || [];
                            onReorderCategory?.({
                              id: activeDragItem.id,
                              groupId: targetGroup.id,
                              targetId:
                                targetCategories.length === 0 ||
                                dropPosition === 'top'
                                  ? null
                                  : targetCategories[0].id,
                            });
                            if (isCollapsed) {
                              toggleGroup(group.id);
                            }
                          }
                        }
                      }}
                      style={{
                        flexDirection: 'row',
                        flexShrink: 0,
                        minHeight: group.is_income ? 36 : 36,
                        backgroundColor: palette.panelRaised,
                        borderTop:
                          dragTarget === groupDragKey
                            ? '2px solid ' + palette.month
                            : '0 solid transparent',
                        borderBottom: '1px solid ' + palette.line,
                        cursor: 'default',
                        opacity: group.hidden ? 0.5 : 1,
                      }}
                      data-testid="row"
                    >
                      <GroupActionMenu
                        group={group}
                        budgetType={budgetType}
                        onRename={() =>
                          setEditingName({ type: 'group', id: group.id })
                        }
                        onMoveUp={
                          onReorderGroup && previousGroup
                            ? () =>
                                onReorderGroup({
                                  id: group.id,
                                  targetId: previousGroup.id,
                                })
                            : undefined
                        }
                        onMoveDown={
                          onReorderGroup && nextGroup
                            ? () =>
                                onReorderGroup({
                                  id: group.id,
                                  targetId: afterNextGroup?.id ?? null,
                                })
                            : undefined
                        }
                        onAddCategory={() => {
                          setNewCategoryForGroup(group.id);
                          if (isCollapsed) {
                            toggleGroup(group.id);
                          }
                        }}
                        onSave={onSaveGroup}
                        onDelete={onDeleteGroup}
                        onApplyBudgetTemplatesInGroup={
                          onApplyBudgetTemplatesInGroup
                        }
                        onSortCategories={onSortCategories}
                      >
                        {({ menuButton, triggerRef, handleContextMenu }) => (
                          <View
                            innerRef={triggerRef}
                            data-testid="group-header"
                            draggable={!group.is_income}
                            onDragStart={startGroupDrag}
                            onContextMenu={handleContextMenu}
                            style={{
                              ...stickyCategoryColumnStyle(palette.panelRaised),
                              width: categoryWidth,
                              flexShrink: 0,
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 6,
                              padding: '0 14px',
                              color: palette.text,
                              cursor: group.is_income ? 'default' : 'grab',
                              userSelect: 'none',
                            }}
                          >
                            <Button
                              variant="bare"
                              aria-label={
                                isCollapsed ? t('Expand') : t('Collapse')
                              }
                              onPress={() => toggleGroup(group.id)}
                              style={{
                                color: palette.text,
                                padding: 2,
                                flexShrink: 0,
                              }}
                            >
                              {isCollapsed ? (
                                <SvgArrowButtonRight1
                                  style={{ width: 10, height: 10 }}
                                />
                              ) : (
                                <SvgArrowButtonDown1
                                  style={{ width: 10, height: 10 }}
                                />
                              )}
                            </Button>
                            <View style={{ flex: 1, minWidth: 0 }}>
                              {editingName?.type === 'group' &&
                              editingName.id === group.id ? (
                                <InlineNameEditor
                                  defaultValue={group.name}
                                  placeholder={t('Group name')}
                                  onCancel={() => setEditingName(null)}
                                  onSave={name => {
                                    onSaveGroup({ ...group, name });
                                    setEditingName(null);
                                  }}
                                />
                              ) : (
                                <Text
                                  data-testid="category-name"
                                  onClick={() => toggleGroup(group.id)}
                                  style={{
                                    color: palette.text,
                                    fontWeight: 800,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                  }}
                                >
                                  {group.name}
                                </Text>
                              )}
                            </View>
                            {menuButton}
                            <NotesButton
                              id={group.id}
                              defaultColor={palette.muted}
                              showPlaceholder
                            />
                          </View>
                        )}
                      </GroupActionMenu>
                      {months.map(month => (
                        <MonthGroupCell
                          key={month}
                          group={group}
                          month={month}
                          budgetType={budgetType}
                          showProgressBars={showProgressBars}
                        />
                      ))}
                      {showProgressBars && (
                        <View
                          style={{
                            ...stickyGoalColumnStyle(palette.panelRaised),
                            width: GOAL_WIDTH,
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </View>

                    {newCategoryForGroup === group.id && (
                      <View
                        style={{
                          flexDirection: 'row',
                          flexShrink: 0,
                          minHeight: 54,
                          borderBottom: '1px solid ' + palette.line,
                        }}
                      >
                        <View
                          style={{
                            ...stickyCategoryColumnStyle(palette.panel),
                            width: categoryWidth,
                            flexShrink: 0,
                            justifyContent: 'center',
                            padding: '0 14px 0 36px',
                          }}
                        >
                          <InlineNameEditor
                            placeholder={t('New category name')}
                            onCancel={() => setNewCategoryForGroup(null)}
                            onSave={name => saveNewCategory(group, name)}
                          />
                        </View>
                        <View style={{ flex: 1 }} />
                      </View>
                    )}

                    {!isCollapsed &&
                      categories.map((category, categoryIndex) => {
                        const previousCategory = categories[categoryIndex - 1];
                        const nextCategory = categories[categoryIndex + 1];
                        const afterNextCategory = categories[categoryIndex + 2];
                        const categoryDragKey = `category:${category.id}`;

                        return (
                          <View
                            key={category.id}
                            onDragEnd={() => {
                              dragItemRef.current = null;
                              setDragTarget(null);
                            }}
                            onDragOver={event => {
                              const activeDragItem = dragItemRef.current;
                              if (
                                activeDragItem?.type !== 'category' ||
                                activeDragItem.isIncome !== category.is_income
                              ) {
                                return;
                              }
                              event.preventDefault();
                              setDragTarget(categoryDragKey);
                            }}
                            onDrop={event => {
                              event.preventDefault();
                              setDragTarget(null);
                              const activeDragItem = dragItemRef.current;
                              if (
                                activeDragItem?.type !== 'category' ||
                                activeDragItem.isIncome !== category.is_income
                              ) {
                                return;
                              }

                              const targetId = getDropTargetId(
                                event,
                                category,
                                nextCategory,
                              );
                              if (
                                activeDragItem.id !== category.id ||
                                activeDragItem.groupId !== group.id
                              ) {
                                onReorderCategory?.({
                                  id: activeDragItem.id,
                                  groupId: group.id,
                                  targetId,
                                });
                              }
                            }}
                            style={{
                              flexDirection: 'row',
                              flexShrink: 0,
                              minHeight: category.is_income ? 36 : 42,
                              borderTop:
                                dragTarget === categoryDragKey
                                  ? '2px solid ' + palette.month
                                  : '0 solid transparent',
                              borderBottom: '1px solid ' + palette.line,
                              cursor: 'default',
                              opacity:
                                category.hidden || group.hidden ? 0.5 : 1,
                            }}
                            data-testid="row"
                          >
                            <CategoryActionMenu
                              category={category}
                              groupHidden={group.hidden}
                              onRename={() =>
                                setEditingName({
                                  type: 'category',
                                  id: category.id,
                                })
                              }
                              onMoveUp={
                                onReorderCategory && previousCategory
                                  ? () =>
                                      onReorderCategory({
                                        id: category.id,
                                        groupId: group.id,
                                        targetId: previousCategory.id,
                                      })
                                  : undefined
                              }
                              onMoveDown={
                                onReorderCategory && nextCategory
                                  ? () =>
                                      onReorderCategory({
                                        id: category.id,
                                        groupId: group.id,
                                        targetId: afterNextCategory?.id ?? null,
                                      })
                                  : undefined
                              }
                              onSave={onSaveCategory}
                              onDelete={onDeleteCategory}
                            >
                              {({
                                menuButton,
                                triggerRef,
                                handleContextMenu,
                              }) => (
                                <View
                                  innerRef={triggerRef}
                                  data-testid="category-header"
                                  draggable
                                  onDragStart={event => {
                                    if (isInteractiveDragTarget(event.target)) {
                                      event.preventDefault();
                                      return;
                                    }
                                    event.dataTransfer.effectAllowed = 'move';
                                    event.dataTransfer.setData(
                                      'text/plain',
                                      category.id,
                                    );
                                    const item: DragItem = {
                                      type: 'category',
                                      id: category.id,
                                      groupId: group.id,
                                      isIncome: Boolean(category.is_income),
                                    };
                                    dragItemRef.current = item;
                                  }}
                                  onContextMenu={handleContextMenu}
                                  style={{
                                    ...stickyCategoryColumnStyle(palette.panel),
                                    width: categoryWidth,
                                    flexShrink: 0,
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '0 14px',
                                    cursor: 'grab',
                                    userSelect: 'none',
                                  }}
                                >
                                  <View style={{ flex: 1, minWidth: 0 }}>
                                    {editingName?.type === 'category' &&
                                    editingName.id === category.id ? (
                                      <InlineNameEditor
                                        defaultValue={category.name}
                                        placeholder={t('Category name')}
                                        onCancel={() => setEditingName(null)}
                                        onSave={name => {
                                          onSaveCategory({
                                            ...category,
                                            name,
                                          });
                                          setEditingName(null);
                                        }}
                                      />
                                    ) : (
                                      <Text
                                        data-testid="category-name"
                                        style={{
                                          color: palette.text,
                                          fontWeight: 650,
                                          whiteSpace: 'nowrap',
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                        }}
                                      >
                                        {category.name}
                                      </Text>
                                    )}
                                  </View>
                                  {menuButton}
                                  <ModernCategoryRowActions
                                    category={category}
                                    month={months[0]}
                                  />
                                </View>
                              )}
                            </CategoryActionMenu>
                            {months.map(month => (
                              <MonthCategoryCell
                                key={month}
                                category={category}
                                month={month}
                                selectedMonth={visibleStartMonth}
                                budgetType={budgetType}
                                showProgressBars={showProgressBars}
                                categoryGroups={categoryGroups}
                                editingCell={editingCell}
                                setEditingCell={setEditingCell}
                                onBudgetAction={onBudgetAction}
                                onShowActivity={showActivity}
                              />
                            ))}
                            {showProgressBars &&
                              (!category.is_income ? (
                                <GoalStrip
                                  category={category}
                                  months={months}
                                  budgetType={budgetType}
                                />
                              ) : (
                                <View
                                  style={{
                                    ...stickyGoalColumnStyle(palette.panel),
                                    width: GOAL_WIDTH,
                                    flexShrink: 0,
                                  }}
                                />
                              ))}
                          </View>
                        );
                      })}
                  </View>
                );
              })}
            </View>
          </View>
        </SchedulesProvider>
      </View>
    </View>
  );
}
