export const GOAL_COLUMN_WIDTH = 36;
export const SPENDING_FULL_WIDTH = 70;

type SpendingBarState = {
  greenWidth: number;
  redWidth: number;
};

type GoalState = {
  percent: number;
  cappedPercent: number;
  isFunded: boolean;
};

export function hasLongGoalTemplate(goalDef: string | null | undefined) {
  if (!goalDef) {
    return false;
  }

  try {
    const templates = JSON.parse(goalDef);
    return (
      Array.isArray(templates) &&
      templates.some(
        template => template?.directive === 'goal' && template?.type === 'goal',
      )
    );
  } catch {
    return false;
  }
}

export function getSpendingBarState(
  budgeted: number,
  spent: number,
): SpendingBarState {
  const spentAmount = Math.max(0, -spent);

  if (budgeted <= 0) {
    return {
      greenWidth: 0,
      redWidth: spentAmount > 0 ? 100 : 0,
    };
  }

  const spentRatio = spentAmount / budgeted;

  if (spentRatio <= 1) {
    return {
      greenWidth: spentRatio * SPENDING_FULL_WIDTH,
      redWidth: 0,
    };
  }

  const greenWidth = SPENDING_FULL_WIDTH;
  const redWidth = (spentRatio - 1) * SPENDING_FULL_WIDTH;
  const totalWidth = greenWidth + redWidth;

  if (totalWidth <= 100) {
    return { greenWidth, redWidth };
  }

  const scale = 100 / totalWidth;

  return {
    greenWidth: greenWidth * scale,
    redWidth: redWidth * scale,
  };
}

export function getLongGoalState({
  balance,
  goal,
  isLongGoal,
}: {
  balance: number;
  goal: number;
  isLongGoal: boolean;
}): GoalState | null {
  if (!isLongGoal || !Number.isFinite(goal) || goal <= 0) {
    return null;
  }

  const percent = Math.max(0, Math.round((balance / goal) * 100));
  return {
    percent,
    cappedPercent: Math.min(percent, 100),
    isFunded: balance >= goal,
  };
}
