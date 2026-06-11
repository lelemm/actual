import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { FormulaTemplate } from '@actual-app/core/types/models/templates';

import { updateTemplate } from '#components/budget/goals/actions';
import type { Action } from '#components/budget/goals/actions';
import { FormField, FormLabel } from '#components/forms';

const FormulaEditor = lazy(() =>
  import('#components/formula/FormulaEditor').then(module => ({
    default: module.FormulaEditor,
  })),
);

type FormulaAutomationProps = {
  template: FormulaTemplate;
  categoryBadges?: Record<string, string>;
  dispatch: (action: Action) => void;
};

export function FormulaAutomation({
  template,
  categoryBadges,
  dispatch,
}: FormulaAutomationProps) {
  const { t } = useTranslation();

  return (
    <FormField style={{ marginTop: 10 }}>
      <FormLabel title={t('Formula')} htmlFor="formula-field" />
      <View
        id="formula-field"
        style={{
          border: `1px solid ${theme.formInputBorder}`,
          borderRadius: 4,
          overflow: 'visible',
          backgroundColor: theme.tableBackground,
        }}
      >
        <Suspense fallback={<div style={{ height: 32 }} />}>
          <FormulaEditor
            value={template.formula}
            onChange={formula =>
              dispatch(
                updateTemplate({
                  type: 'formula',
                  formula,
                }),
              )
            }
            mode="budget"
            height="120px"
            categoryBadges={categoryBadges}
          />
        </Suspense>
      </View>
    </FormField>
  );
}
