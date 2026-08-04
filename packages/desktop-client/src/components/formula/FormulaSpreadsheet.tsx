import { useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';

import { Button } from '@actual-app/components/button';
import { SvgAdd } from '@actual-app/components/icons/v1';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import type { FormulaWidget } from '@actual-app/core/types/models';
import { css } from '@emotion/css';
import rehypeExternalLinks from 'rehype-external-links';
import remarkGfm from 'remark-gfm';

import { PrivacyFilter } from '#components/PrivacyFilter';
import {
  addItems,
  closeContextMenu,
  setContextMenuPosition,
} from '#contextmenu/contextMenuSlice';
import type { ContextMenuItem } from '#contextmenu/types';
import {
  removeSpreadsheetColumns,
  removeSpreadsheetRows,
} from '#hooks/useFormulaExecution';
import type { FormulaCellValue } from '#hooks/useFormulaExecution';
import { useDispatch } from '#redux';
import {
  markdownBaseStyles,
  remarkBreaks,
  sequentialNewlinesPlugin,
} from '#util/markdown';

export type FormulaSpreadsheetMeta = NonNullable<
  NonNullable<FormulaWidget['meta']>['spreadsheet']
>;

export type FormulaSpreadsheetCell = {
  row: number;
  col: number;
};

export type FormulaSpreadsheetSelection = {
  start: FormulaSpreadsheetCell;
  end: FormulaSpreadsheetCell;
};

type FormulaSpreadsheetMerge = NonNullable<
  FormulaSpreadsheetMeta['merges']
>[number];
type FormulaSpreadsheetTextAlignment = NonNullable<
  FormulaSpreadsheetMeta['cellAlignments']
>[string];

type FormulaSpreadsheetProps = {
  spreadsheet: FormulaSpreadsheetMeta;
  values?: FormulaCellValue[][];
  errors?: (string | null)[][];
  cellColors?: Record<string, string>;
  cellBackgroundColors?: Record<string, string>;
  selectedCell?: FormulaSpreadsheetCell;
  selection?: FormulaSpreadsheetSelection;
  readonly?: boolean;
  onSpreadsheetChange?: (spreadsheet: FormulaSpreadsheetMeta) => void;
  onSelectedCellChange?: (cell: FormulaSpreadsheetCell) => void;
  onSelectionChange?: (selection: FormulaSpreadsheetSelection) => void;
};

const DEFAULT_COLUMN_COUNT = 4;
const DEFAULT_ROW_COUNT = 4;
const DEFAULT_COLUMN_WIDTH = 120;
const DEFAULT_ROW_HEIGHT = 40;
const HEADER_SIZE = 32;
const MIN_COLUMN_WIDTH = 60;
const MIN_ROW_HEIGHT = 28;
const DEFAULT_CELL_ALIGNMENT: FormulaSpreadsheetTextAlignment = 'center';

const remarkPlugins = [sequentialNewlinesPlugin, remarkGfm, remarkBreaks];

const markdownCellStyles = css(markdownBaseStyles, {
  width: '100%',
  '& table': {
    display: 'inline-table',
  },
});

export function getFormulaSpreadsheetCellKey({
  row,
  col,
}: FormulaSpreadsheetCell) {
  return `${row}:${col}`;
}

function parseFormulaSpreadsheetCellKey(key: string): FormulaSpreadsheetCell {
  const [row, col] = key.split(':').map(Number);
  return { row, col };
}

function getColumnName(index: number): string {
  let name = '';
  let remaining = index;

  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);

  return name;
}

function getCellDimensions(cells: string[][]) {
  return {
    rows: Math.max(cells.length, 1),
    cols: Math.max(...cells.map(row => row.length), 1),
  };
}

function normalizeCells(cells: string[][]): string[][] {
  const { rows, cols } = getCellDimensions(cells.length > 0 ? cells : [['']]);
  return Array.from({ length: rows }, (_, rowIndex) =>
    Array.from(
      { length: cols },
      (_, colIndex) => cells[rowIndex]?.[colIndex] ?? '',
    ),
  );
}

function createBlankCells(rows: number, cols: number): string[][] {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ''),
  );
}

function normalizeSizedArray(
  values: number[] | undefined,
  size: number,
  defaultValue: number,
): number[] {
  return Array.from(
    { length: size },
    (_, index) => values?.[index] ?? defaultValue,
  );
}

function selectionToRect(selection: FormulaSpreadsheetSelection) {
  return {
    rowStart: Math.min(selection.start.row, selection.end.row),
    rowEnd: Math.max(selection.start.row, selection.end.row),
    colStart: Math.min(selection.start.col, selection.end.col),
    colEnd: Math.max(selection.start.col, selection.end.col),
  };
}

function isSingleCellSelection(selection: FormulaSpreadsheetSelection) {
  const rect = selectionToRect(selection);
  return rect.rowStart === rect.rowEnd && rect.colStart === rect.colEnd;
}

function mergeToRect(merge: FormulaSpreadsheetMerge) {
  return {
    rowStart: merge.row,
    rowEnd: merge.row + merge.rowSpan - 1,
    colStart: merge.col,
    colEnd: merge.col + merge.colSpan - 1,
  };
}

function rectsOverlap(
  first: ReturnType<typeof selectionToRect>,
  second: ReturnType<typeof selectionToRect>,
) {
  return (
    first.rowStart <= second.rowEnd &&
    first.rowEnd >= second.rowStart &&
    first.colStart <= second.colEnd &&
    first.colEnd >= second.colStart
  );
}

function normalizeMerges(
  merges: FormulaSpreadsheetMeta['merges'] | undefined,
  rows: number,
  cols: number,
): FormulaSpreadsheetMerge[] {
  const normalized: FormulaSpreadsheetMerge[] = [];

  for (const merge of merges ?? []) {
    if (
      merge.row < 0 ||
      merge.col < 0 ||
      merge.rowSpan < 1 ||
      merge.colSpan < 1 ||
      merge.row + merge.rowSpan > rows ||
      merge.col + merge.colSpan > cols
    ) {
      continue;
    }

    const mergeRect = mergeToRect(merge);
    if (
      normalized.some(existing =>
        rectsOverlap(mergeRect, mergeToRect(existing)),
      )
    ) {
      continue;
    }

    normalized.push(merge);
  }

  return normalized;
}

export function createDefaultFormulaSpreadsheet({
  formula,
  colorFormula,
}: {
  formula: string;
  colorFormula: string;
}): FormulaSpreadsheetMeta {
  const cells = createBlankCells(DEFAULT_ROW_COUNT, DEFAULT_COLUMN_COUNT);
  cells[0][0] = formula;

  return {
    cells,
    columnWidths: normalizeSizedArray(
      undefined,
      DEFAULT_COLUMN_COUNT,
      DEFAULT_COLUMN_WIDTH,
    ),
    rowHeights: normalizeSizedArray(
      undefined,
      DEFAULT_ROW_COUNT,
      DEFAULT_ROW_HEIGHT,
    ),
    cellColorFormulas: colorFormula ? { '0:0': colorFormula } : {},
    cellBackgroundColorFormulas: {},
    cellAlignments: {},
    merges: [],
  };
}

export function normalizeFormulaSpreadsheet(
  spreadsheet: FormulaSpreadsheetMeta | undefined,
): FormulaSpreadsheetMeta {
  const cells = normalizeCells(spreadsheet?.cells ?? createBlankCells(1, 1));
  const { rows, cols } = getCellDimensions(cells);

  return {
    cells,
    columnWidths: normalizeSizedArray(
      spreadsheet?.columnWidths,
      cols,
      DEFAULT_COLUMN_WIDTH,
    ),
    rowHeights: normalizeSizedArray(
      spreadsheet?.rowHeights,
      rows,
      DEFAULT_ROW_HEIGHT,
    ),
    cellColorFormulas: spreadsheet?.cellColorFormulas ?? {},
    cellBackgroundColorFormulas: spreadsheet?.cellBackgroundColorFormulas ?? {},
    cellAlignments: spreadsheet?.cellAlignments ?? {},
    merges: normalizeMerges(spreadsheet?.merges, rows, cols),
  };
}

export function setFormulaSpreadsheetCell(
  spreadsheet: FormulaSpreadsheetMeta,
  cell: FormulaSpreadsheetCell,
  value: string,
): FormulaSpreadsheetMeta {
  const next = normalizeFormulaSpreadsheet(spreadsheet);
  next.cells = next.cells.map((row, rowIndex) =>
    row.map((cellValue, colIndex) =>
      rowIndex === cell.row && colIndex === cell.col ? value : cellValue,
    ),
  );
  return next;
}

export function setFormulaSpreadsheetCellColorFormula(
  spreadsheet: FormulaSpreadsheetMeta,
  cell: FormulaSpreadsheetCell,
  value: string,
): FormulaSpreadsheetMeta {
  const next = normalizeFormulaSpreadsheet(spreadsheet);
  const key = getFormulaSpreadsheetCellKey(cell);

  if (value) {
    next.cellColorFormulas = {
      ...next.cellColorFormulas,
      [key]: value,
    };
  } else {
    const { [key]: _, ...cellColorFormulas } = next.cellColorFormulas ?? {};
    next.cellColorFormulas = cellColorFormulas;
  }

  return next;
}

export function setFormulaSpreadsheetCellBackgroundColorFormula(
  spreadsheet: FormulaSpreadsheetMeta,
  cell: FormulaSpreadsheetCell,
  value: string,
): FormulaSpreadsheetMeta {
  const next = normalizeFormulaSpreadsheet(spreadsheet);
  const key = getFormulaSpreadsheetCellKey(cell);

  if (value) {
    next.cellBackgroundColorFormulas = {
      ...next.cellBackgroundColorFormulas,
      [key]: value,
    };
  } else {
    const { [key]: _, ...cellBackgroundColorFormulas } =
      next.cellBackgroundColorFormulas ?? {};
    next.cellBackgroundColorFormulas = cellBackgroundColorFormulas;
  }

  return next;
}

function setFormulaSpreadsheetCellAlignment(
  spreadsheet: FormulaSpreadsheetMeta,
  cell: FormulaSpreadsheetCell,
  alignment: FormulaSpreadsheetTextAlignment,
): FormulaSpreadsheetMeta {
  const next = normalizeFormulaSpreadsheet(spreadsheet);
  const key = getFormulaSpreadsheetCellKey(cell);

  if (alignment === DEFAULT_CELL_ALIGNMENT) {
    const { [key]: _, ...cellAlignments } = next.cellAlignments ?? {};
    next.cellAlignments = cellAlignments;
  } else {
    next.cellAlignments = {
      ...next.cellAlignments,
      [key]: alignment,
    };
  }

  return next;
}

function findMergeAt(
  merges: FormulaSpreadsheetMerge[],
  cell: FormulaSpreadsheetCell,
) {
  return merges.find(merge => {
    const rect = mergeToRect(merge);
    return (
      cell.row >= rect.rowStart &&
      cell.row <= rect.rowEnd &&
      cell.col >= rect.colStart &&
      cell.col <= rect.colEnd
    );
  });
}

function isCoveredByMerge(
  merges: FormulaSpreadsheetMerge[],
  cell: FormulaSpreadsheetCell,
) {
  const merge = findMergeAt(merges, cell);
  return Boolean(merge && (merge.row !== cell.row || merge.col !== cell.col));
}

function shiftCellRecordAfterRowDelete<T>(
  values: Record<string, T>,
  deletedRow: number,
) {
  const next: Record<string, T> = {};

  for (const [key, value] of Object.entries(values)) {
    const cell = parseFormulaSpreadsheetCellKey(key);
    if (cell.row === deletedRow) {
      continue;
    }
    next[
      getFormulaSpreadsheetCellKey({
        row: cell.row > deletedRow ? cell.row - 1 : cell.row,
        col: cell.col,
      })
    ] = value;
  }

  return next;
}

function shiftCellRecordAfterColumnDelete<T>(
  values: Record<string, T>,
  deletedCol: number,
) {
  const next: Record<string, T> = {};

  for (const [key, value] of Object.entries(values)) {
    const cell = parseFormulaSpreadsheetCellKey(key);
    if (cell.col === deletedCol) {
      continue;
    }
    next[
      getFormulaSpreadsheetCellKey({
        row: cell.row,
        col: cell.col > deletedCol ? cell.col - 1 : cell.col,
      })
    ] = value;
  }

  return next;
}

function shiftMergesAfterRowDelete(
  merges: FormulaSpreadsheetMerge[],
  deletedRow: number,
) {
  return merges.flatMap(merge => {
    const rect = mergeToRect(merge);
    if (deletedRow < rect.rowStart) {
      return [{ ...merge, row: merge.row - 1 }];
    }
    if (deletedRow > rect.rowEnd) {
      return [merge];
    }
    if (merge.rowSpan === 1) {
      return [];
    }
    return [
      {
        ...merge,
        rowSpan: merge.rowSpan - 1,
      },
    ];
  });
}

function shiftMergesAfterColumnDelete(
  merges: FormulaSpreadsheetMerge[],
  deletedCol: number,
) {
  return merges.flatMap(merge => {
    const rect = mergeToRect(merge);
    if (deletedCol < rect.colStart) {
      return [{ ...merge, col: merge.col - 1 }];
    }
    if (deletedCol > rect.colEnd) {
      return [merge];
    }
    if (merge.colSpan === 1) {
      return [];
    }
    return [
      {
        ...merge,
        colSpan: merge.colSpan - 1,
      },
    ];
  });
}

function remapCellRecord<T>(
  values: Record<string, T>,
  mapCell: (cell: FormulaSpreadsheetCell) => FormulaSpreadsheetCell,
) {
  const next: Record<string, T> = {};

  for (const [key, value] of Object.entries(values)) {
    next[
      getFormulaSpreadsheetCellKey(mapCell(parseFormulaSpreadsheetCellKey(key)))
    ] = value;
  }

  return next;
}

function remapMerge(
  merge: FormulaSpreadsheetMerge,
  mapCell: (cell: FormulaSpreadsheetCell) => FormulaSpreadsheetCell,
) {
  const cells: FormulaSpreadsheetCell[] = [];

  for (let row = merge.row; row < merge.row + merge.rowSpan; row++) {
    for (let col = merge.col; col < merge.col + merge.colSpan; col++) {
      cells.push(mapCell({ row, col }));
    }
  }

  const rows = cells.map(cell => cell.row);
  const cols = cells.map(cell => cell.col);
  const row = Math.min(...rows);
  const col = Math.min(...cols);
  const rowSpan = Math.max(...rows) - row + 1;
  const colSpan = Math.max(...cols) - col + 1;

  return rowSpan * colSpan === cells.length
    ? { row, col, rowSpan, colSpan }
    : null;
}

function remapMerges(
  merges: FormulaSpreadsheetMerge[],
  mapCell: (cell: FormulaSpreadsheetCell) => FormulaSpreadsheetCell,
) {
  return merges.flatMap(merge => {
    const nextMerge = remapMerge(merge, mapCell);
    return nextMerge ? [nextMerge] : [];
  });
}

function isCellInSelection(
  cell: FormulaSpreadsheetCell,
  selection: FormulaSpreadsheetSelection | undefined,
) {
  if (!selection) {
    return false;
  }
  const rect = selectionToRect(selection);
  return (
    cell.row >= rect.rowStart &&
    cell.row <= rect.rowEnd &&
    cell.col >= rect.colStart &&
    cell.col <= rect.colEnd
  );
}

function getDisplayedCellValue(value: FormulaCellValue | undefined) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function FormulaSpreadsheetCellValue({
  value,
  error,
}: {
  value: FormulaCellValue | undefined;
  error?: string | null;
}) {
  if (error) {
    return <PrivacyFilter>{error}</PrivacyFilter>;
  }

  if (typeof value === 'string') {
    return (
      <PrivacyFilter>
        <View className={markdownCellStyles}>
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={[
              [
                rehypeExternalLinks,
                { target: '_blank', rel: ['noopener', 'noreferrer'] },
              ],
            ]}
          >
            {value}
          </ReactMarkdown>
        </View>
      </PrivacyFilter>
    );
  }

  return <PrivacyFilter>{getDisplayedCellValue(value)}</PrivacyFilter>;
}

export function FormulaSpreadsheet({
  spreadsheet,
  values,
  errors,
  cellColors = {},
  cellBackgroundColors = {},
  selectedCell = { row: 0, col: 0 },
  selection,
  readonly = false,
  onSpreadsheetChange,
  onSelectedCellChange,
  onSelectionChange,
}: FormulaSpreadsheetProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const [isSelecting, setIsSelecting] = useState(false);
  const selectionAnchorRef = useRef<FormulaSpreadsheetCell>(selectedCell);
  const normalizedSpreadsheet = useMemo(
    () => normalizeFormulaSpreadsheet(spreadsheet),
    [spreadsheet],
  );
  const {
    cells,
    columnWidths,
    rowHeights,
    merges = [],
  } = normalizedSpreadsheet;
  const { rows, cols } = getCellDimensions(cells);
  const activeSelection = selection ?? {
    start: selectedCell,
    end: selectedCell,
  };

  function updateSpreadsheet(nextSpreadsheet: FormulaSpreadsheetMeta) {
    onSpreadsheetChange?.(normalizeFormulaSpreadsheet(nextSpreadsheet));
  }

  function openContextMenu(event: MouseEvent, items: ContextMenuItem[]) {
    event.preventDefault();
    dispatch(closeContextMenu());
    dispatch(addItems(items));
    dispatch(setContextMenuPosition({ x: event.clientX, y: event.clientY }));
  }

  function setSelection(nextSelection: FormulaSpreadsheetSelection) {
    onSelectionChange?.(nextSelection);
  }

  function selectCell(cell: FormulaSpreadsheetCell, extendSelection: boolean) {
    if (readonly) {
      return;
    }

    const nextSelection = extendSelection
      ? { start: selectionAnchorRef.current, end: cell }
      : { start: cell, end: cell };

    if (!extendSelection) {
      selectionAnchorRef.current = cell;
      onSelectedCellChange?.(cell);
    }

    setSelection(nextSelection);
  }

  function addColumn() {
    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: cells.map(row => [...row, '']),
      columnWidths: [...(columnWidths ?? []), DEFAULT_COLUMN_WIDTH],
    });
  }

  function addRow() {
    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: [...cells, Array.from({ length: cols }, () => '')],
      rowHeights: [...(rowHeights ?? []), DEFAULT_ROW_HEIGHT],
    });
  }

  function deleteRow(rowIndex: number) {
    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: removeSpreadsheetRows(cells, rowIndex),
      rowHeights: rowHeights?.filter((_, index) => index !== rowIndex),
      cellColorFormulas: shiftCellRecordAfterRowDelete(
        normalizedSpreadsheet.cellColorFormulas ?? {},
        rowIndex,
      ),
      cellBackgroundColorFormulas: shiftCellRecordAfterRowDelete(
        normalizedSpreadsheet.cellBackgroundColorFormulas ?? {},
        rowIndex,
      ),
      cellAlignments: shiftCellRecordAfterRowDelete(
        normalizedSpreadsheet.cellAlignments ?? {},
        rowIndex,
      ),
      merges: shiftMergesAfterRowDelete(merges, rowIndex),
    });
    onSelectedCellChange?.({ row: Math.max(rowIndex - 1, 0), col: 0 });
  }

  function deleteColumn(colIndex: number) {
    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: removeSpreadsheetColumns(cells, colIndex),
      columnWidths: columnWidths?.filter((_, index) => index !== colIndex),
      cellColorFormulas: shiftCellRecordAfterColumnDelete(
        normalizedSpreadsheet.cellColorFormulas ?? {},
        colIndex,
      ),
      cellBackgroundColorFormulas: shiftCellRecordAfterColumnDelete(
        normalizedSpreadsheet.cellBackgroundColorFormulas ?? {},
        colIndex,
      ),
      cellAlignments: shiftCellRecordAfterColumnDelete(
        normalizedSpreadsheet.cellAlignments ?? {},
        colIndex,
      ),
      merges: shiftMergesAfterColumnDelete(merges, colIndex),
    });
    onSelectedCellChange?.({ row: 0, col: Math.max(colIndex - 1, 0) });
  }

  function swapRows(sourceRow: number, targetRow: number) {
    if (sourceRow === targetRow) {
      return;
    }

    const mapCell = (cell: FormulaSpreadsheetCell) => ({
      row:
        cell.row === sourceRow
          ? targetRow
          : cell.row === targetRow
            ? sourceRow
            : cell.row,
      col: cell.col,
    });
    const nextCells = cells.map(row => [...row]);
    [nextCells[sourceRow], nextCells[targetRow]] = [
      nextCells[targetRow],
      nextCells[sourceRow],
    ];
    const nextRowHeights = [...(rowHeights ?? [])];
    [nextRowHeights[sourceRow], nextRowHeights[targetRow]] = [
      nextRowHeights[targetRow],
      nextRowHeights[sourceRow],
    ];

    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: nextCells,
      rowHeights: nextRowHeights,
      cellColorFormulas: remapCellRecord(
        normalizedSpreadsheet.cellColorFormulas ?? {},
        mapCell,
      ),
      cellBackgroundColorFormulas: remapCellRecord(
        normalizedSpreadsheet.cellBackgroundColorFormulas ?? {},
        mapCell,
      ),
      cellAlignments: remapCellRecord(
        normalizedSpreadsheet.cellAlignments ?? {},
        mapCell,
      ),
      merges: remapMerges(merges, mapCell),
    });
  }

  function swapColumns(sourceCol: number, targetCol: number) {
    if (sourceCol === targetCol) {
      return;
    }

    const mapCell = (cell: FormulaSpreadsheetCell) => ({
      row: cell.row,
      col:
        cell.col === sourceCol
          ? targetCol
          : cell.col === targetCol
            ? sourceCol
            : cell.col,
    });
    const nextCells = cells.map(row => {
      const nextRow = [...row];
      [nextRow[sourceCol], nextRow[targetCol]] = [
        nextRow[targetCol],
        nextRow[sourceCol],
      ];
      return nextRow;
    });
    const nextColumnWidths = [...(columnWidths ?? [])];
    [nextColumnWidths[sourceCol], nextColumnWidths[targetCol]] = [
      nextColumnWidths[targetCol],
      nextColumnWidths[sourceCol],
    ];

    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: nextCells,
      columnWidths: nextColumnWidths,
      cellColorFormulas: remapCellRecord(
        normalizedSpreadsheet.cellColorFormulas ?? {},
        mapCell,
      ),
      cellBackgroundColorFormulas: remapCellRecord(
        normalizedSpreadsheet.cellBackgroundColorFormulas ?? {},
        mapCell,
      ),
      cellAlignments: remapCellRecord(
        normalizedSpreadsheet.cellAlignments ?? {},
        mapCell,
      ),
      merges: remapMerges(merges, mapCell),
    });
  }

  function resizeColumn(colIndex: number, event: PointerEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startWidth = columnWidths?.[colIndex] ?? DEFAULT_COLUMN_WIDTH;

    function onPointerMove(pointerEvent: globalThis.PointerEvent) {
      const nextWidths = [...(columnWidths ?? [])];
      nextWidths[colIndex] = Math.max(
        MIN_COLUMN_WIDTH,
        startWidth + pointerEvent.clientX - startX,
      );
      updateSpreadsheet({ ...normalizedSpreadsheet, columnWidths: nextWidths });
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  function resizeRow(rowIndex: number, event: PointerEvent<HTMLDivElement>) {
    const startY = event.clientY;
    const startHeight = rowHeights?.[rowIndex] ?? DEFAULT_ROW_HEIGHT;

    function onPointerMove(pointerEvent: globalThis.PointerEvent) {
      const nextHeights = [...(rowHeights ?? [])];
      nextHeights[rowIndex] = Math.max(
        MIN_ROW_HEIGHT,
        startHeight + pointerEvent.clientY - startY,
      );
      updateSpreadsheet({ ...normalizedSpreadsheet, rowHeights: nextHeights });
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  function mergeSelection(selectionToMerge: FormulaSpreadsheetSelection) {
    const rect = selectionToRect(selectionToMerge);
    const nextCells = cells.map(row => [...row]);
    const nextCellColorFormulas = {
      ...(normalizedSpreadsheet.cellColorFormulas ?? {}),
    };
    const nextCellBackgroundColorFormulas = {
      ...(normalizedSpreadsheet.cellBackgroundColorFormulas ?? {}),
    };
    const nextCellAlignments = {
      ...(normalizedSpreadsheet.cellAlignments ?? {}),
    };

    for (let row = rect.rowStart; row <= rect.rowEnd; row++) {
      for (let col = rect.colStart; col <= rect.colEnd; col++) {
        if (row === rect.rowStart && col === rect.colStart) {
          continue;
        }
        nextCells[row][col] = '';
        delete nextCellColorFormulas[
          getFormulaSpreadsheetCellKey({ row, col })
        ];
        delete nextCellBackgroundColorFormulas[
          getFormulaSpreadsheetCellKey({ row, col })
        ];
        delete nextCellAlignments[getFormulaSpreadsheetCellKey({ row, col })];
      }
    }

    updateSpreadsheet({
      ...normalizedSpreadsheet,
      cells: nextCells,
      cellColorFormulas: nextCellColorFormulas,
      cellBackgroundColorFormulas: nextCellBackgroundColorFormulas,
      cellAlignments: nextCellAlignments,
      merges: [
        ...merges,
        {
          row: rect.rowStart,
          col: rect.colStart,
          rowSpan: rect.rowEnd - rect.rowStart + 1,
          colSpan: rect.colEnd - rect.colStart + 1,
        },
      ],
    });
    onSelectedCellChange?.({ row: rect.rowStart, col: rect.colStart });
    setSelection({
      start: { row: rect.rowStart, col: rect.colStart },
      end: { row: rect.rowStart, col: rect.colStart },
    });
  }

  function unmergeCell(merge: FormulaSpreadsheetMerge) {
    updateSpreadsheet({
      ...normalizedSpreadsheet,
      merges: merges.filter(existing => existing !== merge),
    });
  }

  function canMerge(selectionToMerge: FormulaSpreadsheetSelection) {
    if (isSingleCellSelection(selectionToMerge)) {
      return false;
    }

    const rect = selectionToRect(selectionToMerge);
    return !merges.some(merge => rectsOverlap(rect, mergeToRect(merge)));
  }

  function onCellContextMenu(event: MouseEvent, cell: FormulaSpreadsheetCell) {
    if (readonly) {
      return;
    }

    const clickedSelection = isCellInSelection(cell, activeSelection)
      ? activeSelection
      : { start: cell, end: cell };
    const merge = findMergeAt(merges, cell);
    const items: ContextMenuItem[] = [
      {
        name: 'align-left',
        text: t('Align left'),
        onClick: () =>
          updateSpreadsheet(
            setFormulaSpreadsheetCellAlignment(
              normalizedSpreadsheet,
              cell,
              'left',
            ),
          ),
      },
      {
        name: 'align-center',
        text: t('Align center'),
        onClick: () =>
          updateSpreadsheet(
            setFormulaSpreadsheetCellAlignment(
              normalizedSpreadsheet,
              cell,
              'center',
            ),
          ),
      },
      {
        name: 'align-right',
        text: t('Align right'),
        onClick: () =>
          updateSpreadsheet(
            setFormulaSpreadsheetCellAlignment(
              normalizedSpreadsheet,
              cell,
              'right',
            ),
          ),
      },
    ];

    if (merge) {
      items.push({
        name: 'unmerge',
        text: t('Unmerge'),
        onClick: () => unmergeCell(merge),
      });
    } else if (canMerge(clickedSelection)) {
      items.push({
        name: 'merge',
        text: t('Merge'),
        onClick: () => mergeSelection(clickedSelection),
      });
    }

    setSelection(clickedSelection);
    openContextMenu(event, items);
  }

  const gridTemplateColumns = readonly
    ? columnWidths?.map(width => `${width}px`).join(' ')
    : `${HEADER_SIZE}px ${columnWidths?.map(width => `${width}px`).join(' ')} ${HEADER_SIZE}px`;
  const gridTemplateRows = readonly
    ? rowHeights?.map(height => `${height}px`).join(' ')
    : `${HEADER_SIZE}px ${rowHeights?.map(height => `${height}px`).join(' ')} ${HEADER_SIZE}px`;

  return (
    <View
      style={{
        backgroundColor: theme.tableBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 4,
        width: 'max-content',
      }}
      onPointerUp={() => setIsSelecting(false)}
    >
      <View
        role="grid"
        style={{
          display: 'grid',
          gridTemplateColumns,
          gridTemplateRows,
          minWidth: 'max-content',
          padding: 4,
        }}
      >
        {!readonly && (
          <View
            style={{
              gridColumn: 1,
              gridRow: 1,
              backgroundColor: theme.tableHeaderBackground,
              borderRight: `1px solid ${theme.tableBorder}`,
              borderBottom: `1px solid ${theme.tableBorder}`,
            }}
          />
        )}

        {!readonly &&
          Array.from({ length: cols }, (_, colIndex) => (
            <View
              key={`col-${colIndex}`}
              draggable
              onDragStart={event => {
                event.dataTransfer.setData('formula-column', String(colIndex));
              }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                const sourceCol = Number(
                  event.dataTransfer.getData('formula-column'),
                );
                if (Number.isFinite(sourceCol)) {
                  swapColumns(sourceCol, colIndex);
                }
              }}
              onContextMenu={event =>
                openContextMenu(event, [
                  {
                    name: 'delete-column',
                    text: t('Delete column'),
                    onClick: () => deleteColumn(colIndex),
                    hidden: cols <= 1,
                  },
                ])
              }
              style={{
                gridColumn: colIndex + 2,
                gridRow: 1,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.tableHeaderBackground,
                color: theme.tableHeaderText,
                borderRight: `1px solid ${theme.tableBorder}`,
                borderBottom: `1px solid ${theme.tableBorder}`,
                cursor: 'grab',
                userSelect: 'none',
                fontSize: 12,
              }}
            >
              {getColumnName(colIndex)}
              <View
                role="separator"
                aria-label={t('Resize column')}
                onPointerDown={event => {
                  event.preventDefault();
                  resizeColumn(colIndex, event);
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  width: 6,
                  cursor: 'col-resize',
                }}
              />
            </View>
          ))}

        {!readonly &&
          Array.from({ length: rows }, (_, rowIndex) => (
            <View
              key={`row-${rowIndex}`}
              draggable
              onDragStart={event => {
                event.dataTransfer.setData('formula-row', String(rowIndex));
              }}
              onDragOver={event => event.preventDefault()}
              onDrop={event => {
                const sourceRow = Number(
                  event.dataTransfer.getData('formula-row'),
                );
                if (Number.isFinite(sourceRow)) {
                  swapRows(sourceRow, rowIndex);
                }
              }}
              onContextMenu={event =>
                openContextMenu(event, [
                  {
                    name: 'delete-row',
                    text: t('Delete row'),
                    onClick: () => deleteRow(rowIndex),
                    hidden: rows <= 1,
                  },
                ])
              }
              style={{
                gridColumn: 1,
                gridRow: rowIndex + 2,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.tableRowHeaderBackground,
                color: theme.tableRowHeaderText,
                borderRight: `1px solid ${theme.tableBorder}`,
                borderBottom: `1px solid ${theme.tableBorder}`,
                cursor: 'grab',
                userSelect: 'none',
                fontSize: 12,
              }}
            >
              {rowIndex + 1}
              <View
                role="separator"
                aria-label={t('Resize row')}
                onPointerDown={event => {
                  event.preventDefault();
                  resizeRow(rowIndex, event);
                }}
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 6,
                  cursor: 'row-resize',
                }}
              />
            </View>
          ))}

        {cells.flatMap((row, rowIndex) =>
          row.map((_, colIndex) => {
            const cell = { row: rowIndex, col: colIndex };
            if (isCoveredByMerge(merges, cell)) {
              return null;
            }

            const merge = findMergeAt(merges, cell);
            const isSelected =
              !readonly &&
              selectedCell.row === rowIndex &&
              selectedCell.col === colIndex;
            const isInSelection =
              !readonly && isCellInSelection(cell, activeSelection);
            const cellError = errors?.[rowIndex]?.[colIndex];
            const cellKey = getFormulaSpreadsheetCellKey(cell);
            const color = cellColors[cellKey];
            const backgroundColor = cellBackgroundColors[cellKey];
            const textAlign =
              normalizedSpreadsheet.cellAlignments?.[cellKey] ??
              DEFAULT_CELL_ALIGNMENT;

            return (
              <View
                key={`${rowIndex}:${colIndex}`}
                role="gridcell"
                onPointerDown={event => {
                  if (event.button !== 0) {
                    return;
                  }
                  selectCell(cell, event.shiftKey);
                  setIsSelecting(true);
                  document.addEventListener(
                    'pointerup',
                    () => setIsSelecting(false),
                    { once: true },
                  );
                }}
                onPointerEnter={() => {
                  if (isSelecting) {
                    setSelection({
                      start: selectionAnchorRef.current,
                      end: cell,
                    });
                  }
                }}
                onContextMenu={event => onCellContextMenu(event, cell)}
                style={{
                  gridColumn: `${colIndex + (readonly ? 1 : 2)} / span ${
                    merge?.colSpan ?? 1
                  }`,
                  gridRow: `${rowIndex + (readonly ? 1 : 2)} / span ${
                    merge?.rowSpan ?? 1
                  }`,
                  overflow: 'hidden',
                  padding: '6px 8px',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isSelected
                    ? theme.formInputBackgroundSelected
                    : isInSelection
                      ? theme.tableRowBackgroundHighlight
                      : (backgroundColor ?? theme.tableBackground),
                  color: cellError
                    ? theme.errorText
                    : (color ?? theme.tableText),
                  borderRight: `1px solid ${theme.tableBorder}`,
                  borderBottom: `1px solid ${theme.tableBorder}`,
                  outline: isSelected
                    ? `2px solid ${theme.formInputBorderSelected}`
                    : undefined,
                  outlineOffset: -2,
                  cursor: readonly ? 'default' : 'cell',
                  fontSize: 13,
                  lineHeight: 1.3,
                  textAlign,
                }}
              >
                <FormulaSpreadsheetCellValue
                  value={values?.[rowIndex]?.[colIndex]}
                  error={cellError}
                />
              </View>
            );
          }),
        )}

        {!readonly && (
          <Button
            variant="bare"
            aria-label={t('Add column')}
            onPress={addColumn}
            style={{
              gridColumn: cols + 2,
              gridRow: `1 / span ${rows + 1}`,
              borderRadius: 0,
              borderRight: `1px solid ${theme.tableBorder}`,
              borderBottom: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableHeaderBackground,
            }}
          >
            <SvgAdd width={10} height={10} />
          </Button>
        )}

        {!readonly && (
          <Button
            variant="bare"
            aria-label={t('Add row')}
            onPress={addRow}
            style={{
              gridColumn: `1 / span ${cols + 1}`,
              gridRow: rows + 2,
              borderRadius: 0,
              borderRight: `1px solid ${theme.tableBorder}`,
              borderBottom: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableRowHeaderBackground,
            }}
          >
            <SvgAdd width={10} height={10} />
          </Button>
        )}
      </View>
    </View>
  );
}
