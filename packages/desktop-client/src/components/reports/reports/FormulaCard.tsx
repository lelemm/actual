import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { View } from '@actual-app/components/view';
import type { FormulaWidget } from '@actual-app/core/types/models';

import {
  FormulaSpreadsheet,
  normalizeFormulaSpreadsheet,
} from '#components/formula/FormulaSpreadsheet';
import { FormulaResult } from '#components/reports/FormulaResult';
import { ReportCard } from '#components/reports/ReportCard';
import { ReportCardName } from '#components/reports/ReportCardName';
import {
  useFormulaExecution,
  useFormulaSpreadsheetExecution,
  useFormulaSpreadsheetStyleExecution,
} from '#hooks/useFormulaExecution';
import { useResizeObserver } from '#hooks/useResizeObserver';
import { useThemeColors } from '#hooks/useThemeColors';

type FormulaCardProps = {
  widgetId: string;
  isEditing?: boolean;
  meta?: FormulaWidget['meta'];
  onMetaChange: (newMeta: FormulaWidget['meta']) => void;
};

const SPREADSHEET_CARD_PADDING = 4;

export function FormulaCard({
  widgetId,
  isEditing,
  meta = {},
  onMetaChange,
}: FormulaCardProps) {
  const { t } = useTranslation();
  const [nameMenuOpen, setNameMenuOpen] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const themeColors = useThemeColors();
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useResizeObserver<HTMLDivElement>(rect => {
    const nextSize = {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    setContainerSize(current =>
      current.width === nextSize.width && current.height === nextSize.height
        ? current
        : nextSize,
    );
  });
  const handleContainerRef = useCallback(
    (element: HTMLDivElement | null) => {
      containerRef.current = element;
      if (element) {
        resizeRef(element);
      }
    },
    [resizeRef],
  );

  const formula = meta?.formula || '=SUM(1, 2, 3)';
  const fontSize = meta?.fontSize;
  const fontSizeMode = meta?.fontSizeMode || 'dynamic';
  const staticFontSize = meta?.staticFontSize || 32;
  const showTitle = meta?.showTitle ?? true;
  const colorFormula = meta?.colorFormula || '';
  const spreadsheetMode = meta?.spreadsheetMode ?? false;
  const spreadsheet = useMemo(
    () => normalizeFormulaSpreadsheet(meta?.spreadsheet),
    [meta?.spreadsheet],
  );
  const spreadsheetSize = useMemo(
    () => ({
      width:
        (spreadsheet.columnWidths ?? []).reduce(
          (total, width) => total + width,
          0,
        ) + 2,
      height:
        (spreadsheet.rowHeights ?? []).reduce(
          (total, height) => total + height,
          0,
        ) + 2,
    }),
    [spreadsheet.columnWidths, spreadsheet.rowHeights],
  );
  const spreadsheetScale = useMemo(() => {
    if (
      containerSize.width === 0 ||
      containerSize.height === 0 ||
      spreadsheetSize.width === 0 ||
      spreadsheetSize.height === 0
    ) {
      return 1;
    }

    const availableWidth = Math.max(
      containerSize.width - SPREADSHEET_CARD_PADDING * 2,
      0,
    );
    const availableHeight = Math.max(
      containerSize.height - SPREADSHEET_CARD_PADDING * 2,
      0,
    );

    return Math.min(
      availableWidth / spreadsheetSize.width,
      availableHeight / spreadsheetSize.height,
    );
  }, [containerSize, spreadsheetSize]);

  const { result, isLoading, error } = useFormulaExecution(
    formula,
    meta?.queries || {},
    meta?.queriesVersion,
  );

  const themeVariables = useMemo(
    () =>
      Object.entries(themeColors).reduce(
        (acc, [key, value]) => {
          acc[`theme_${key}`] = value;
          return acc;
        },
        {} as Record<string, string>,
      ),
    [themeColors],
  );
  const colorVariables = useMemo(
    () => ({
      RESULT: typeof result === 'boolean' ? String(result) : (result ?? 0),
      ...themeVariables,
    }),
    [result, themeVariables],
  );
  const { result: colorResult, error: colorError } = useFormulaExecution(
    colorFormula,
    meta?.queries || {},
    meta?.queriesVersion,
    colorVariables,
  );

  const customColor =
    colorFormula && !colorError && colorResult ? String(colorResult) : null;
  const { result: spreadsheetResult } = useFormulaSpreadsheetExecution(
    spreadsheet.cells,
    meta?.queries || {},
    meta?.queriesVersion,
    spreadsheetMode,
  );
  const cellColors = useFormulaSpreadsheetStyleExecution({
    values: spreadsheetResult.values,
    colorFormulas: spreadsheet.cellColorFormulas ?? {},
    queries: meta?.queries || {},
    queriesVersion: meta?.queriesVersion,
    themeVariables,
    enabled: spreadsheetMode,
  });
  const cellBackgroundColors = useFormulaSpreadsheetStyleExecution({
    values: spreadsheetResult.values,
    colorFormulas: spreadsheet.cellBackgroundColorFormulas ?? {},
    queries: meta?.queries || {},
    queriesVersion: meta?.queriesVersion,
    themeVariables,
    enabled: spreadsheetMode,
  });

  return (
    <ReportCard
      widgetId={widgetId}
      isEditing={isEditing}
      disableClick={nameMenuOpen}
      to={`/reports/formula/${widgetId}`}
      onRename={() => setNameMenuOpen(true)}
      style={
        spreadsheetMode && !showTitle
          ? {
              backgroundColor: 'transparent',
              boxShadow: 'none',
              transition: 'none',
              ':hover': {
                boxShadow: 'none',
              },
            }
          : undefined
      }
    >
      <View style={{ flex: 1, overflow: 'hidden' }}>
        {showTitle && (
          <View style={{ flexGrow: 0, flexShrink: 0, padding: 20 }}>
            <ReportCardName
              name={meta?.name || t('Formula')}
              isEditing={nameMenuOpen}
              onChange={newName => {
                onMetaChange({
                  ...meta,
                  name: newName,
                });
                setNameMenuOpen(false);
              }}
              onClose={() => setNameMenuOpen(false)}
            />
          </View>
        )}
        <View
          ref={handleContainerRef}
          style={{
            justifyContent: spreadsheetMode ? 'flex-start' : 'center',
            alignItems: 'center',
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
        >
          {spreadsheetMode ? (
            <View
              style={{
                display: 'block',
                width:
                  spreadsheetSize.width * spreadsheetScale +
                  SPREADSHEET_CARD_PADDING * 2,
                height:
                  spreadsheetSize.height * spreadsheetScale +
                  SPREADSHEET_CARD_PADDING * 2,
                padding: SPREADSHEET_CARD_PADDING,
                overflow: 'visible',
              }}
            >
              <View
                style={{
                  display: 'block',
                  width: spreadsheetSize.width,
                  height: spreadsheetSize.height,
                  transform: `scale(${spreadsheetScale})`,
                  transformOrigin: 'top left',
                }}
              >
                <FormulaSpreadsheet
                  spreadsheet={spreadsheet}
                  values={spreadsheetResult.values}
                  errors={spreadsheetResult.errors}
                  cellColors={cellColors}
                  cellBackgroundColors={cellBackgroundColors}
                  readonly
                />
              </View>
            </View>
          ) : (
            <FormulaResult
              value={result}
              error={error}
              loading={isLoading}
              initialFontSize={fontSize}
              fontSizeChanged={newSize => {
                onMetaChange({
                  ...meta,
                  fontSize: newSize,
                });
              }}
              fontSizeMode={fontSizeMode}
              staticFontSize={staticFontSize}
              customColor={customColor}
              animate={isEditing ?? false}
              containerRef={containerRef}
            />
          )}
        </View>
      </View>
    </ReportCard>
  );
}
