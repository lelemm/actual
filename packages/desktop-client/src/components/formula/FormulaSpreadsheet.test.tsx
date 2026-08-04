import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ContextMenuItem } from '#contextmenu/types';
import { createTestAppStore, TestProviders } from '#mocks';

import {
  FormulaSpreadsheet,
  normalizeFormulaSpreadsheet,
} from './FormulaSpreadsheet';

describe('FormulaSpreadsheet', () => {
  it('selects cells in editable mode', async () => {
    const user = userEvent.setup();
    const onSelectedCellChange = vi.fn();

    render(
      <TestProviders>
        <FormulaSpreadsheet
          spreadsheet={normalizeFormulaSpreadsheet({
            cells: [
              ['1', '2'],
              ['3', '4'],
            ],
          })}
          values={[
            [1, 2],
            [3, 4],
          ]}
          selectedCell={{ row: 0, col: 0 }}
          onSelectedCellChange={onSelectedCellChange}
        />
      </TestProviders>,
    );

    await user.click(screen.getAllByRole('gridcell')[1]);

    expect(onSelectedCellChange).toHaveBeenCalledWith({ row: 0, col: 1 });
  });

  it('adds rows and columns in editable mode', async () => {
    const user = userEvent.setup();
    const onSpreadsheetChange = vi.fn();

    render(
      <TestProviders>
        <FormulaSpreadsheet
          spreadsheet={normalizeFormulaSpreadsheet({
            cells: [['1']],
          })}
          values={[[1]]}
          onSpreadsheetChange={onSpreadsheetChange}
        />
      </TestProviders>,
    );

    await user.click(screen.getByRole('button', { name: 'Add column' }));
    expect(onSpreadsheetChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cells: [['1', '']],
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Add row' }));
    expect(onSpreadsheetChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cells: [['1'], ['']],
      }),
    );
  });

  it('renders text outputs as Markdown in readonly mode', () => {
    render(
      <TestProviders>
        <FormulaSpreadsheet
          spreadsheet={normalizeFormulaSpreadsheet({
            cells: [['="**Hello**"']],
          })}
          values={[['**Hello**']]}
          readonly
        />
      </TestProviders>,
    );

    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByRole('gridcell')).not.toHaveStyle(
      'outline-style: solid',
    );
  });

  it('persists cell text alignment from the context menu', () => {
    const store = createTestAppStore();
    const onSpreadsheetChange = vi.fn();

    render(
      <TestProviders store={store}>
        <FormulaSpreadsheet
          spreadsheet={normalizeFormulaSpreadsheet({
            cells: [['1']],
          })}
          values={[[1]]}
          onSpreadsheetChange={onSpreadsheetChange}
        />
      </TestProviders>,
    );

    fireEvent.contextMenu(screen.getByRole('gridcell'));

    const alignRightItem = store
      .getState()
      .contextMenu.items.find(
        (item): item is Extract<ContextMenuItem, { name: string }> =>
          typeof item === 'object' && item.name === 'align-right',
      );

    alignRightItem?.onClick?.();

    expect(onSpreadsheetChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cellAlignments: { '0:0': 'right' },
      }),
    );
  });

  it('renders conditional cell background colors', () => {
    render(
      <TestProviders>
        <FormulaSpreadsheet
          spreadsheet={normalizeFormulaSpreadsheet({
            cells: [['1']],
          })}
          values={[[1]]}
          cellBackgroundColors={{ '0:0': '#123456' }}
          readonly
        />
      </TestProviders>,
    );

    screen.getByRole('gridcell');
    const styleText = Array.from(document.querySelectorAll('style'))
      .map(style => style.textContent)
      .join('\n');
    expect(styleText).toContain('background-color:#123456');
  });
});
