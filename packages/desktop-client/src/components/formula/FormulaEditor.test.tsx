import { useState } from 'react';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';

import { TestProviders } from '#mocks';

import { FormulaEditor } from './FormulaEditor';

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

function RegexFormulaEditor() {
  const [value, setValue] = useState('=REGEXREPLACE("replace_me", "/me/g")');

  return (
    <>
      <FormulaEditor
        value={value}
        onChange={setValue}
        mode="transaction"
        showLineNumbers={false}
      />
      <output data-testid="formula-value">{value}</output>
    </>
  );
}

describe('FormulaEditor', () => {
  it('selects regex flag combinations from the decorator dropdown', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    );
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [],
    });
    render(<RegexFormulaEditor />, { wrapper: TestProviders });

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Regular expression flags',
      }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /i.*Ignore letter case/ }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByTestId('formula-value')).toHaveTextContent(
      '=REGEXREPLACE("replace_me", "/me/gi")',
    );
  });
});
