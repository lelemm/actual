import { describe, expect, it } from 'vitest';

import {
  getLongGoalState,
  getSpendingBarState,
  hasLongGoalTemplate,
  SPENDING_FULL_WIDTH,
} from './BudgetProgressHelpers';
import { getVisibleMonths } from './ModernBudgetPage';

describe('getVisibleMonths', () => {
  const bounds = { start: '2026-01', end: '2026-06' };

  it('returns the requested month range inside budget bounds', () => {
    expect(getVisibleMonths('2026-02', 3, bounds)).toEqual([
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
  });

  it('shifts the range earlier when the request would pass the end bound', () => {
    expect(getVisibleMonths('2026-05', 3, bounds)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  it('caps the range to the available budget bounds', () => {
    expect(
      getVisibleMonths('2026-01', 6, { start: '2026-03', end: '2026-04' }),
    ).toEqual(['2026-03', '2026-04']);
  });

  it('caps the range to six visible months', () => {
    expect(
      getVisibleMonths('2026-01', 12, { start: '2026-01', end: '2026-12' }),
    ).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });
});

describe('hasLongGoalTemplate', () => {
  it('detects a long-term goal template', () => {
    expect(
      hasLongGoalTemplate(
        JSON.stringify([{ directive: 'goal', type: 'goal', amount: 1000 }]),
      ),
    ).toBe(true);
  });

  it('ignores non-goal and invalid template data', () => {
    expect(
      hasLongGoalTemplate(
        JSON.stringify([
          { directive: 'template', type: 'simple', monthly: 100 },
        ]),
      ),
    ).toBe(false);
    expect(hasLongGoalTemplate('nope')).toBe(false);
    expect(hasLongGoalTemplate(null)).toBe(false);
  });
});

describe('getSpendingBarState', () => {
  it('renders no fill when there is no budget and no spending', () => {
    expect(getSpendingBarState(0, 0)).toEqual({
      greenWidth: 0,
      redWidth: 0,
    });
  });

  it('renders red overflow when spending exists without a budget', () => {
    expect(getSpendingBarState(0, -25)).toEqual({
      greenWidth: 0,
      redWidth: 100,
    });
  });

  it('maps under-budget spending into the normal green range', () => {
    expect(getSpendingBarState(100, -50)).toEqual({
      greenWidth: 35,
      redWidth: 0,
    });
  });

  it('maps exact budget spending to the reserved full-budget width', () => {
    expect(getSpendingBarState(100, -100)).toEqual({
      greenWidth: SPENDING_FULL_WIDTH,
      redWidth: 0,
    });
  });

  it('extends overspending from the reserved full-budget width', () => {
    expect(getSpendingBarState(100, -125)).toEqual({
      greenWidth: SPENDING_FULL_WIDTH,
      redWidth: 17.5,
    });
  });

  it('scales heavy overflow to fit the full bar', () => {
    expect(getSpendingBarState(10, -100)).toEqual({
      greenWidth: 10,
      redWidth: 90,
    });
  });

  it('keeps modest overflow proportional to the reserved full-budget width', () => {
    const result = getSpendingBarState(400, -437.42);

    expect(result.greenWidth).toBe(SPENDING_FULL_WIDTH);
    expect(result.redWidth).toBeCloseTo(6.55);
  });

  it('scales both budget and overflow proportionally', () => {
    const result = getSpendingBarState(100, -150);

    expect(result.greenWidth).toBeCloseTo(66.67);
    expect(result.redWidth).toBeCloseTo(33.33);
  });
});

describe('getLongGoalState', () => {
  it('ignores missing long-term goals', () => {
    expect(
      getLongGoalState({ balance: 50, goal: 100, isLongGoal: false }),
    ).toBeNull();
  });

  it('ignores zero goals', () => {
    expect(
      getLongGoalState({ balance: 50, goal: 0, isLongGoal: true }),
    ).toBeNull();
  });

  it('calculates partial progress', () => {
    expect(
      getLongGoalState({ balance: 55, goal: 100, isLongGoal: true }),
    ).toEqual({
      percent: 55,
      cappedPercent: 55,
      isFunded: false,
    });
  });

  it('caps visual progress at 100 percent', () => {
    expect(
      getLongGoalState({ balance: 125, goal: 100, isLongGoal: true }),
    ).toEqual({
      percent: 125,
      cappedPercent: 100,
      isFunded: true,
    });
  });

  it('does not show negative progress for negative balances', () => {
    expect(
      getLongGoalState({ balance: -10, goal: 100, isLongGoal: true }),
    ).toEqual({
      percent: 0,
      cappedPercent: 0,
      isFunded: false,
    });
  });
});
