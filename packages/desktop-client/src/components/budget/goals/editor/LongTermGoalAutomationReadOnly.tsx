import { Trans } from 'react-i18next';

import { amountToInteger } from '@actual-app/core/shared/util';
import type { GoalTemplate } from '@actual-app/core/types/models/templates';
import type { TransObjectLiteral } from '@actual-app/core/types/util';

import { FinancialText } from '#components/FinancialText';
import { useFormat } from '#hooks/useFormat';

type LongTermGoalAutomationReadOnlyProps = {
  template: GoalTemplate;
};

export function LongTermGoalAutomationReadOnly({
  template,
}: LongTermGoalAutomationReadOnlyProps) {
  const format = useFormat();
  const amount = format(
    amountToInteger(template.amount, format.currency.decimalPlaces),
    'financial',
  );
  const displayAmount = template.amountFormula ?? amount;

  return (
    <Trans>
      Long-term goal of{' '}
      <FinancialText>
        {{ amount: displayAmount } as TransObjectLiteral}
      </FinancialText>
    </Trans>
  );
}
