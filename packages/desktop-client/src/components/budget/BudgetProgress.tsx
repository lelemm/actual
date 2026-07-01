// @ts-strict-ignore
import React, { useContext, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { Tooltip } from '@actual-app/components/tooltip';
import { View } from '@actual-app/components/view';
import * as monthUtils from '@actual-app/core/shared/months';
import type { CategoryEntity } from '@actual-app/core/types/models';

import { PrivacyFilter } from '#components/PrivacyFilter';
import { ROW_HEIGHT } from '#components/table';
import { useFormat } from '#hooks/useFormat';
import { useLocale } from '#hooks/useLocale';
import { SheetNameProvider } from '#hooks/useSheetName';
import { useSheetValue } from '#hooks/useSheetValue';
import { useSpreadsheet } from '#hooks/useSpreadsheet';
import { useSyncedPref } from '#hooks/useSyncedPref';
import type { Binding } from '#spreadsheet';
import { envelopeBudget, trackingBudget } from '#spreadsheet/bindings';

import {
  getLongGoalState,
  getSpendingBarState,
  GOAL_COLUMN_WIDTH,
  hasLongGoalTemplate,
  SPENDING_FULL_WIDTH,
} from './BudgetProgressHelpers';
import { MonthsContext } from './MonthsContext';

export { GOAL_COLUMN_WIDTH } from './BudgetProgressHelpers';

const FUTURE_GOAL_HORIZON_MONTHS = 12;

function useBudgetBindings() {
  const [budgetType = 'envelope'] = useSyncedPref('budgetType');
  return budgetType === 'tracking' ? trackingBudget : envelopeBudget;
}

function getGoalStatusColor(balance: number, goal: number) {
  return balance >= goal
    ? theme.templateNumberFunded
    : theme.templateNumberUnderFunded;
}

export function MonthlySpendingProgressBar({
  category,
  placement = 'balance',
}: {
  category: CategoryEntity;
  placement?: 'balance' | 'category';
}) {
  const bindings = useBudgetBindings();
  const format = useFormat();
  const budgeted = Number(
    useSheetValue(
      bindings.catBudgeted(category.id) as Binding<'envelope-budget', 'budget'>,
    ),
  );
  const spent = Number(
    useSheetValue(
      bindings.catSumAmount(category.id) as Binding<
        'envelope-budget',
        'sum-amount'
      >,
    ),
  );
  const spentAmount = Math.max(0, -spent);
  const { greenWidth, redWidth } = getSpendingBarState(budgeted, spent);
  const trackWidth = redWidth > 0 ? greenWidth + redWidth : SPENDING_FULL_WIDTH;
  const remainingAmount = Math.max(budgeted - spentAmount, 0);
  const remainingWidth =
    redWidth === 0 ? Math.max(trackWidth - greenWidth, 0) : 0;

  if (greenWidth === 0 && redWidth === 0) {
    return null;
  }

  const fill = (
    <>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${trackWidth}%`,
          backgroundColor: theme.tableBorder,
        }}
      />
      {greenWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${greenWidth}%`,
            backgroundColor: theme.budgetNumberPositive,
          }}
        />
      )}
      {redWidth > 0 && (
        <View
          style={{
            position: 'absolute',
            left: `${greenWidth}%`,
            top: 0,
            bottom: 0,
            width: `${redWidth}%`,
            backgroundColor: theme.buttonPrimaryBackground,
          }}
        />
      )}
    </>
  );

  if (placement === 'category') {
    const minimumLabelWidth = 5;
    const overflowAmount = Math.max(spentAmount - Math.max(budgeted, 0), 0);
    const showOverflowValue = overflowAmount > 0;
    const normalAmount = showOverflowValue
      ? Math.max(budgeted, 0)
      : spentAmount;
    const normalTrackWidth =
      redWidth > 0 && greenWidth < SPENDING_FULL_WIDTH
        ? `${greenWidth}%`
        : `min(${SPENDING_FULL_WIDTH}%, calc(100% - 44px))`;
    const normalFillWidth =
      redWidth > 0 ? '100%' : `${(greenWidth / SPENDING_FULL_WIDTH) * 100}%`;

    return (
      <View
        className={redWidth > 0 ? 'category-progressbar-overflow' : undefined}
        style={{
          position: 'relative',
          width: '100%',
          height: 10,
          overflow: 'visible',
        }}
      >
        <View
          className="category-progressbar-inner"
          style={{
            position: 'absolute',
            left: 0,
            right: 4,
            bottom: 3,
            height: 3,
            opacity: 0.6,
            transition: 'height .15s ease, opacity .12s ease',
            '&:hover': {
              opacity: 1,
            },
          }}
        >
          <View
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              width: normalTrackWidth,
              height: 'inherit',
              overflow: 'hidden',
              backgroundColor: theme.tableBorder,
            }}
          >
            {greenWidth > 0 && (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: normalFillWidth,
                  backgroundColor: theme.budgetNumberPositive,
                }}
              />
            )}
          </View>
          {redWidth > 0 && (
            <View
              style={{
                position: 'absolute',
                left: normalTrackWidth,
                top: 0,
                bottom: 0,
                width: `${redWidth}%`,
                backgroundColor: theme.buttonPrimaryBackground,
              }}
            />
          )}
          <View
            className="category-progressbar-values"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 1,
            }}
          >
            <PrivacyFilter>
              {greenWidth >= minimumLabelWidth && (
                <Text
                  style={{
                    position: 'absolute',
                    left: 0,
                    width: redWidth > 0 ? normalTrackWidth : `${greenWidth}%`,
                    color: theme.budgetCurrentMonth,
                    fontSize: 9,
                    fontWeight: 600,
                    lineHeight: '13px',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {format(normalAmount, 'financial')}
                </Text>
              )}
              {remainingAmount > 0 && remainingWidth >= minimumLabelWidth && (
                <Text
                  style={{
                    position: 'absolute',
                    left: redWidth > 0 ? normalTrackWidth : `${greenWidth}%`,
                    width: `${remainingWidth}%`,
                    color: theme.tableHeaderText,
                    fontSize: 9,
                    fontWeight: 600,
                    lineHeight: '13px',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {format(remainingAmount, 'financial')}
                </Text>
              )}
              {showOverflowValue && redWidth >= minimumLabelWidth && (
                <Text
                  style={{
                    position: 'absolute',
                    left: normalTrackWidth,
                    width: `${redWidth}%`,
                    color: theme.buttonPrimaryText,
                    fontSize: 9,
                    fontWeight: 600,
                    lineHeight: '13px',
                    textAlign: 'center',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {format(overflowAmount, 'financial')}
                </Text>
              )}
            </PrivacyFilter>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      aria-hidden
      style={{
        position: 'absolute',
        left: 8,
        right: styles.monthRightPadding,
        bottom: 2,
        height: 3,
        overflow: 'hidden',
        opacity: 0.8,
      }}
    >
      {fill}
    </View>
  );
}

export function GoalColumnHeader() {
  return (
    <View
      style={{
        width: GOAL_COLUMN_WIDTH,
        flexShrink: 0,
        backgroundColor: theme.pageBackground,
        borderTopRightRadius: 4,
      }}
    ></View>
  );
}

export function GoalColumnSpacer({
  backgroundColor,
  invisible = false,
  roundedBottomRight = false,
}: {
  backgroundColor?: string;
  invisible?: boolean;
  roundedBottomRight?: boolean;
}) {
  if (invisible) {
    return (
      <View
        style={{
          width: GOAL_COLUMN_WIDTH,
          flexShrink: 0,
          boxSizing: 'border-box',
          backgroundColor: theme.pageBackground,
        }}
      />
    );
  }

  return (
    <View
      style={{
        width: GOAL_COLUMN_WIDTH,
        flexShrink: 0,
        boxSizing: 'border-box',
        borderLeft: '1px solid ' + theme.tableBorder,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.tableBorder,
        backgroundColor,
        ...(roundedBottomRight && { borderBottomRightRadius: 4 }),
      }}
    />
  );
}

export function LongGoalColumnCell({
  category,
  roundedBottomRight = false,
}: {
  category: CategoryEntity;
  roundedBottomRight?: boolean;
}) {
  const { months } = useContext(MonthsContext);
  const month = months[months.length - 1];

  return (
    <View
      style={{
        width: GOAL_COLUMN_WIDTH,
        flexShrink: 0,
        boxSizing: 'border-box',
        borderLeft: '1px solid ' + theme.tableBorder,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.tableBorder,
        backgroundColor: theme.budgetCurrentMonth,
        overflow: 'hidden',
        ...(roundedBottomRight && { borderBottomRightRadius: 4 }),
      }}
    >
      <SheetNameProvider name={monthUtils.sheetForMonth(month)}>
        <LongGoalColumnCellValue category={category} months={months} />
      </SheetNameProvider>
    </View>
  );
}

function LongGoalColumnCellValue({
  category,
  months,
}: {
  category: CategoryEntity;
  months: string[];
}) {
  const bindings = useBudgetBindings();
  const { t } = useTranslation();
  const format = useFormat();
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
  const goalState = getLongGoalState({ balance, goal, isLongGoal });
  const goalStatusColor = getGoalStatusColor(balance, goal);
  const goalStatusLabel =
    balance === goal
      ? t('Fully funded')
      : balance > goal
        ? t('Overfunded')
        : t('Underfunded');

  const graph = (
    <View
      aria-label={
        goalState ? `${category.name} goal ${goalState.percent}%` : undefined
      }
      style={{
        width: GOAL_COLUMN_WIDTH,
        height: ROW_HEIGHT,
        flexDirection: 'row',
        boxSizing: 'border-box',
      }}
    >
      {months.map((month, index) => (
        <SheetNameProvider key={month} name={monthUtils.sheetForMonth(month)}>
          <LongGoalColumnMonthBar
            category={category}
            month={month}
            isFirst={index === 0}
          />
        </SheetNameProvider>
      ))}
    </View>
  );

  return (
    <Tooltip
      content={
        <View style={{ gap: 7, padding: 4, minWidth: 170 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Text style={{ flex: 1, fontWeight: 600 }}>{category.name}</Text>
            {goalState && (
              <Text style={{ color: goalStatusColor, fontWeight: 600 }}>
                {goalStatusLabel}
              </Text>
            )}
          </View>
          {goalState && (
            <PrivacyFilter>
              <Text style={{ color: goalStatusColor, fontWeight: 600 }}>
                {goalState.percent}% - {format(balance, 'financial')} of{' '}
                {format(goal, 'financial')}
              </Text>
            </PrivacyFilter>
          )}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 5,
              height: 78,
              marginTop: 2,
            }}
          >
            {months.map(month => (
              <SheetNameProvider
                key={month}
                name={monthUtils.sheetForMonth(month)}
              >
                <LongGoalHistoryBar category={category} month={month} />
              </SheetNameProvider>
            ))}
          </View>
        </View>
      }
    >
      {graph}
    </Tooltip>
  );
}

function LongGoalProgressGraph({
  goalState,
  showMutedLeftover,
  style,
}: {
  goalState: ReturnType<typeof getLongGoalState>;
  showMutedLeftover: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <View
      style={{
        overflow: 'hidden',
        position: 'relative',
        ...style,
      }}
    >
      {goalState ? (
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            width: '100%',
            height: `${goalState.cappedPercent}%`,
            backgroundColor: goalState.isFunded
              ? theme.templateNumberFunded
              : theme.templateNumberUnderFunded,
          }}
        />
      ) : (
        showMutedLeftover && (
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              width: '100%',
              height: '100%',
              backgroundColor: theme.tableTextSubdued,
            }}
          />
        )
      )}
    </View>
  );
}

function useHasFutureLongGoal({
  category,
  month,
  enabled,
}: {
  category: CategoryEntity;
  month: string;
  enabled: boolean;
}) {
  const spreadsheet = useSpreadsheet();
  const [hasFutureGoal, setHasFutureGoal] = useState(false);

  useEffect(() => {
    if (!enabled || !hasLongGoalTemplate(category.goal_def)) {
      setHasFutureGoal(false);
      return;
    }

    let isDisposed = false;
    const values: Record<string, { goal?: number; longGoal?: number }> = {};

    const update = () => {
      if (!isDisposed) {
        setHasFutureGoal(
          Object.values(values).some(
            value => value.longGoal === 1 && Number(value.goal) > 0,
          ),
        );
      }
    };

    const unbinds = Array.from(
      { length: FUTURE_GOAL_HORIZON_MONTHS },
      (_, index) => {
        const futureMonth = monthUtils.addMonths(month, index + 1);
        const sheetName = monthUtils.sheetForMonth(futureMonth);
        values[sheetName] = {};

        const unbindGoal = spreadsheet.bind(
          sheetName,
          { name: `goal-${category.id}` },
          node => {
            values[sheetName].goal = Number(node.value);
            update();
          },
        );
        const unbindLongGoal = spreadsheet.bind(
          sheetName,
          { name: `long-goal-${category.id}` },
          node => {
            values[sheetName].longGoal = Number(node.value);
            update();
          },
        );

        return () => {
          unbindGoal();
          unbindLongGoal();
        };
      },
    );

    return () => {
      isDisposed = true;
      unbinds.forEach(unbind => unbind());
    };
  }, [category.goal_def, category.id, enabled, month, spreadsheet]);

  return hasFutureGoal;
}

function LongGoalColumnMonthBar({
  category,
  month,
  isFirst = false,
}: {
  category: CategoryEntity;
  month: string;
  isFirst?: boolean;
}) {
  const bindings = useBudgetBindings();
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
  const goalState = getLongGoalState({
    balance,
    goal,
    isLongGoal,
  });
  const hasFutureGoal = useHasFutureLongGoal({
    category,
    month,
    enabled: balance > 0 && !goalState,
  });

  return (
    <LongGoalProgressGraph
      goalState={goalState}
      showMutedLeftover={balance > 0 && hasFutureGoal}
      style={{
        flexBasis: 0,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        height: '100%',
        ...(isFirst && {
          borderTopLeftRadius: 4,
          borderBottomLeftRadius: 4,
        }),
      }}
    />
  );
}

function LongGoalHistoryBar({
  category,
  month,
}: {
  category: CategoryEntity;
  month: string;
}) {
  const bindings = useBudgetBindings();
  const format = useFormat();
  const locale = useLocale();
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
  const budgeted = Number(
    useSheetValue(
      bindings.catBudgeted(category.id) as Binding<'envelope-budget', 'budget'>,
    ),
  );
  const spent = Number(
    useSheetValue(
      bindings.catSumAmount(category.id) as Binding<
        'envelope-budget',
        'sum-amount'
      >,
    ),
  );
  const monthlyLeftover = budgeted + spent;
  const goalState = getLongGoalState({
    balance,
    goal,
    isLongGoal,
  });
  const goalStatusColor = goalState?.isFunded
    ? theme.templateNumberFunded
    : theme.templateNumberUnderFunded;
  const hasFutureGoal = useHasFutureLongGoal({
    category,
    month,
    enabled: balance > 0 && !goalState,
  });

  return (
    <View
      style={{
        width: 64,
        height: '100%',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <PrivacyFilter>
        <Text
          style={{
            color: goalState ? goalStatusColor : theme.tableHeaderText,
            fontSize: 9,
            lineHeight: '10px',
            whiteSpace: 'nowrap',
          }}
        >
          {format(balance, 'financial')}
        </Text>
      </PrivacyFilter>
      <LongGoalProgressGraph
        goalState={goalState}
        showMutedLeftover={balance > 0 && hasFutureGoal}
        style={{ width: 8, flex: 1 }}
      />
      <Text
        style={{
          color: theme.tableHeaderText,
          fontSize: 9,
          lineHeight: '10px',
        }}
      >
        {monthUtils.format(month, 'MMM', locale)}
      </Text>
      <PrivacyFilter>
        <Text
          style={{
            color:
              monthlyLeftover < 0
                ? theme.budgetNumberNegative
                : theme.tableHeaderText,
            fontSize: 9,
            lineHeight: '10px',
            whiteSpace: 'nowrap',
          }}
        >
          {format(monthlyLeftover, 'financial')}
        </Text>
      </PrivacyFilter>
    </View>
  );
}
