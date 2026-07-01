// @ts-strict-ignore
import React from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { CategoryGroupEntity } from '@actual-app/core/types/models';

import { Row } from '#components/table';
import { useLocalPref } from '#hooks/useLocalPref';

import { GoalColumnSpacer } from './BudgetProgress';
import { RenderMonths } from './RenderMonths';
import { SidebarGroup } from './SidebarGroup';

import { useBudgetComponents } from '.';

type IncomeGroupProps = {
  group: CategoryGroupEntity;
  isLast?: boolean;
  editingCell: { id: CategoryGroupEntity['id']; cell: string } | null;
  collapsed: boolean;
  onEditName: (id: CategoryGroupEntity['id']) => void;
  onSave: (group: CategoryGroupEntity) => void;
  onSortCategories?: (
    groupId: CategoryGroupEntity['id'],
    direction: 'asc' | 'desc',
  ) => void;
  onToggleCollapse: (id: CategoryGroupEntity['id']) => void;
  onShowNewCategory: (groupId: CategoryGroupEntity['id']) => void;
};

export function IncomeGroup({
  group,
  isLast,
  editingCell,
  collapsed,
  onEditName,
  onSave,
  onSortCategories,
  onToggleCollapse,
  onShowNewCategory,
}: IncomeGroupProps) {
  const { IncomeGroupComponent: MonthComponent } = useBudgetComponents();
  const [showProgressBars] = useLocalPref('budget.showProgressBars');

  return (
    <Row
      collapsed
      style={{
        fontWeight: 600,
        backgroundColor: theme.budgetHeaderCurrentMonth, //use budget color
      }}
    >
      <SidebarGroup
        group={group}
        collapsed={collapsed}
        editing={
          editingCell &&
          editingCell.cell === 'name' &&
          editingCell.id === group.id
        }
        onEdit={onEditName}
        onSave={onSave}
        onSortCategories={onSortCategories}
        onToggleCollapse={onToggleCollapse}
        onShowNewCategory={onShowNewCategory}
      />
      <View
        style={
          isLast && showProgressBars
            ? {
                flex: 1,
                flexDirection: 'row',
                borderBottomRightRadius: 4,
                overflow: 'hidden',
              }
            : { flex: 1, flexDirection: 'row' }
        }
      >
        <RenderMonths>
          {({ month }) => <MonthComponent month={month} group={group} />}
        </RenderMonths>
      </View>
      {showProgressBars && <GoalColumnSpacer invisible />}
    </Row>
  );
}
