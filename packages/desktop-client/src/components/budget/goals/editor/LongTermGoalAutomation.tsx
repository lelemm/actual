import { useTranslation } from 'react-i18next';

import { SpaceBetween } from '@actual-app/components/space-between';
import { View } from '@actual-app/components/view';
import { amountToInteger, integerToAmount } from '@actual-app/core/shared/util';
import type { GoalTemplate } from '@actual-app/core/types/models/templates';

import { updateTemplate } from '#components/budget/goals/actions';
import type { Action } from '#components/budget/goals/actions';
import { FormField, FormLabel } from '#components/forms';
import { useFormat } from '#hooks/useFormat';

import { FormulaAmountInput, FormulaModeButton } from './FormulaAmountInput';

type LongTermGoalAutomationProps = {
  template: GoalTemplate;
  categoryBadges?: Record<string, string>;
  dispatch: (action: Action) => void;
};

export function LongTermGoalAutomation({
  template,
  categoryBadges,
  dispatch,
}: LongTermGoalAutomationProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const amount = amountToInteger(
    template.amount,
    format.currency.decimalPlaces,
  );

  return (
    <View style={{ position: 'relative', paddingTop: 20 }}>
      <FormulaModeButton
        formula={template.amountFormula}
        onFormulaUpdate={amountFormula =>
          dispatch(updateTemplate({ type: 'goal', amountFormula }))
        }
      />
      <SpaceBetween align="center" gap={10} style={{ marginTop: 10 }}>
        <FormField style={{ flex: 1 }}>
          <FormLabel title={t('Target amount')} htmlFor="goal-amount-field" />
          <FormulaAmountInput
            id="goal-amount-field"
            amount={amount}
            formula={template.amountFormula}
            categoryBadges={categoryBadges}
            onAmountUpdate={(value: number) =>
              dispatch(
                updateTemplate({
                  type: 'goal',
                  amount: integerToAmount(value, format.currency.decimalPlaces),
                }),
              )
            }
            onFormulaUpdate={amountFormula =>
              dispatch(updateTemplate({ type: 'goal', amountFormula }))
            }
          />
        </FormField>
      </SpaceBetween>
    </View>
  );
}
