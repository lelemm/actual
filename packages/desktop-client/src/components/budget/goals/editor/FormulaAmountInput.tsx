import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { Trans } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { AmountInput } from '#components/util/AmountInput';
import { useFeatureFlag } from '#hooks/useFeatureFlag';

const FormulaEditor = lazy(() =>
  import('#components/formula/FormulaEditor').then(module => ({
    default: module.FormulaEditor,
  })),
);

type FormulaAmountInputProps = {
  id: string;
  amount: number;
  formula?: string;
  categoryBadges?: Record<string, string>;
  onAmountUpdate: (amount: number) => void;
  onFormulaUpdate: (formula: string | undefined) => void;
};

export function FormulaAmountInput({
  id,
  amount,
  formula,
  categoryBadges,
  onAmountUpdate,
  onFormulaUpdate,
}: FormulaAmountInputProps) {
  const hasFormula = formula !== undefined;

  if (hasFormula) {
    return (
      <View
        style={{
          border: `1px solid ${theme.formInputBorder}`,
          borderRadius: 4,
          overflow: 'visible',
          backgroundColor: theme.tableBackground,
        }}
      >
        <Suspense fallback={<div style={{ height: 96 }} />}>
          <FormulaEditor
            value={formula}
            onChange={onFormulaUpdate}
            mode="budget"
            height="96px"
            categoryBadges={categoryBadges}
          />
        </Suspense>
      </View>
    );
  }

  return (
    <AmountInput
      id={id}
      value={amount}
      zeroSign="+"
      onUpdate={onAmountUpdate}
    />
  );
}

type FormulaModeButtonProps = {
  formula?: string;
  formulaLabel?: ReactNode;
  valueLabel?: ReactNode;
  onFormulaUpdate: (formula: string | undefined) => void;
};

export function FormulaModeButton({
  formula,
  formulaLabel = <Trans>Use formula</Trans>,
  valueLabel = <Trans>Use amount</Trans>,
  onFormulaUpdate,
}: FormulaModeButtonProps) {
  const formulaMode = useFeatureFlag('formulaMode');
  const hasFormula = formula !== undefined;
  const canUseFormula = formulaMode || hasFormula;

  if (!canUseFormula) {
    return null;
  }

  return (
    <Button
      variant="bare"
      onPress={() => onFormulaUpdate(hasFormula ? undefined : '=0')}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        padding: 0,
        fontSize: 12,
        zIndex: 1,
      }}
    >
      {hasFormula ? valueLabel : formulaLabel}
    </Button>
  );
}
