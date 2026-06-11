import { Trans } from 'react-i18next';

import type { FormulaTemplate } from '@actual-app/core/types/models/templates';

type FormulaAutomationReadOnlyProps = {
  template: FormulaTemplate;
};

export function FormulaAutomationReadOnly({
  template,
}: FormulaAutomationReadOnlyProps) {
  return (
    <Trans>
      Formula: <strong>{template.formula}</strong>
    </Trans>
  );
}
