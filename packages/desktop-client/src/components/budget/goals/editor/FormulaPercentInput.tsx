import { lazy, Suspense } from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { PercentInput } from '#components/util/PercentInput';

const FormulaEditor = lazy(() =>
  import('#components/formula/FormulaEditor').then(module => ({
    default: module.FormulaEditor,
  })),
);

type FormulaPercentInputProps = {
  id: string;
  percent: number;
  formula?: string;
  categoryBadges?: Record<string, string>;
  onPercentUpdate: (percent: number) => void;
  onFormulaUpdate: (formula: string | undefined) => void;
};

export function FormulaPercentInput({
  id,
  percent,
  formula,
  categoryBadges,
  onPercentUpdate,
  onFormulaUpdate,
}: FormulaPercentInputProps) {
  if (formula !== undefined) {
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
    <PercentInput
      id={id}
      key="percent-input"
      value={percent}
      onUpdatePercent={onPercentUpdate}
    />
  );
}
