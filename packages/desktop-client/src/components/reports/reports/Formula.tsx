import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ChangeEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { Button } from '@actual-app/components/button';
import { useResponsive } from '@actual-app/components/hooks/useResponsive';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { Toggle } from '@actual-app/components/toggle';
import { View } from '@actual-app/components/view';
import type { FormulaWidget } from '@actual-app/core/types/models';

import { EditablePageHeaderTitle } from '#components/EditablePageHeaderTitle';
import {
  createDefaultFormulaSpreadsheet,
  FormulaSpreadsheet,
  getFormulaSpreadsheetCellKey,
  normalizeFormulaSpreadsheet,
  setFormulaSpreadsheetCell,
  setFormulaSpreadsheetCellBackgroundColorFormula,
  setFormulaSpreadsheetCellColorFormula,
} from '#components/formula/FormulaSpreadsheet';
import type {
  FormulaSpreadsheetCell,
  FormulaSpreadsheetSelection,
} from '#components/formula/FormulaSpreadsheet';
import { QueryManager } from '#components/formula/QueryManager';
import { MobileBackButton } from '#components/mobile/MobileBackButton';
import { MobilePageHeader, Page, PageHeader } from '#components/Page';
import { FormulaResult } from '#components/reports/FormulaResult';
import { LoadingIndicator } from '#components/reports/LoadingIndicator';
import { useDashboardWidget } from '#hooks/useDashboardWidget';
import {
  useFormulaExecution,
  useFormulaSpreadsheetExecution,
  useFormulaSpreadsheetStyleExecution,
} from '#hooks/useFormulaExecution';
import { useNavigate } from '#hooks/useNavigate';
import { useThemeColors } from '#hooks/useThemeColors';
import { addNotification } from '#notifications/notificationsSlice';
import { useDispatch } from '#redux';
import { useUpdateDashboardWidgetMutation } from '#reports/mutations';

const FormulaEditor = lazy(() =>
  import('#components/formula/FormulaEditor').then(module => ({
    default: module.FormulaEditor,
  })),
);

export function Formula() {
  const params = useParams();
  const { data: widget, isPending } = useDashboardWidget<FormulaWidget>({
    id: params.id,
    type: 'formula-card',
  });

  if (isPending) {
    return <LoadingIndicator />;
  }

  return <FormulaInner widget={widget} />;
}

type FormulaInnerProps = {
  widget?: FormulaWidget;
};

function FormulaInner({ widget }: FormulaInnerProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { isNarrowWidth } = useResponsive();
  const themeColors = useThemeColors();

  const queriesRef = useRef(widget?.meta?.queries || {});
  const [queriesVersion, setQueriesVersion] = useState(0);

  const [formula, setFormula] = useState(
    widget?.meta?.formula || '=SUM(1, 2, 3)',
  );

  const [fontSizeMode, setFontSizeMode] = useState<'dynamic' | 'static'>(
    widget?.meta?.fontSizeMode || 'dynamic',
  );
  const [staticFontSize, setStaticFontSize] = useState<number>(
    widget?.meta?.staticFontSize || 32,
  );
  const [showTitle, setShowTitle] = useState(widget?.meta?.showTitle ?? true);
  const [colorFormula, setColorFormula] = useState(
    widget?.meta?.colorFormula || '',
  );
  const [spreadsheetMode, setSpreadsheetMode] = useState(
    widget?.meta?.spreadsheetMode ?? false,
  );
  const [spreadsheet, setSpreadsheet] = useState(() =>
    normalizeFormulaSpreadsheet(
      widget?.meta?.spreadsheet ??
        createDefaultFormulaSpreadsheet({
          formula: widget?.meta?.formula || '=SUM(1, 2, 3)',
          colorFormula: widget?.meta?.colorFormula || '',
        }),
    ),
  );
  const [selectedCell, setSelectedCell] = useState<FormulaSpreadsheetCell>({
    row: 0,
    col: 0,
  });
  const [spreadsheetSelection, setSpreadsheetSelection] =
    useState<FormulaSpreadsheetSelection>({
      start: { row: 0, col: 0 },
      end: { row: 0, col: 0 },
    });

  const title = widget?.meta?.name || t('Formula');
  const normalizedSpreadsheet = useMemo(
    () => normalizeFormulaSpreadsheet(spreadsheet),
    [spreadsheet],
  );
  const selectedCellKey = getFormulaSpreadsheetCellKey(selectedCell);

  const {
    result,
    isLoading: isExecuting,
    error,
  } = useFormulaExecution(formula, queriesRef.current, queriesVersion);
  const { result: spreadsheetResult } = useFormulaSpreadsheetExecution(
    normalizedSpreadsheet.cells,
    queriesRef.current,
    queriesVersion,
    spreadsheetMode,
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
  const selectedCellResult =
    spreadsheetResult.values[selectedCell.row]?.[selectedCell.col] ?? null;
  const cellColors = useFormulaSpreadsheetStyleExecution({
    values: spreadsheetResult.values,
    colorFormulas: normalizedSpreadsheet.cellColorFormulas ?? {},
    queries: queriesRef.current,
    queriesVersion,
    themeVariables,
    enabled: spreadsheetMode,
  });
  const cellBackgroundColors = useFormulaSpreadsheetStyleExecution({
    values: spreadsheetResult.values,
    colorFormulas: normalizedSpreadsheet.cellBackgroundColorFormulas ?? {},
    queries: queriesRef.current,
    queriesVersion,
    themeVariables,
    enabled: spreadsheetMode,
  });

  const colorVariables = useMemo(
    () => ({
      RESULT: typeof result === 'boolean' ? String(result) : (result ?? 0),
      ...themeVariables,
    }),
    [result, themeVariables],
  );
  const { result: colorResult, error: colorError } = useFormulaExecution(
    colorFormula,
    queriesRef.current,
    queriesVersion,
    colorVariables,
  );

  useEffect(() => {
    const rowCount = normalizedSpreadsheet.cells.length;
    const colCount = normalizedSpreadsheet.cells[0]?.length ?? 1;

    if (selectedCell.row >= rowCount || selectedCell.col >= colCount) {
      const nextSelectedCell = {
        row: Math.min(selectedCell.row, rowCount - 1),
        col: Math.min(selectedCell.col, colCount - 1),
      };
      setSelectedCell(nextSelectedCell);
      setSpreadsheetSelection({
        start: nextSelectedCell,
        end: nextSelectedCell,
      });
    }
  }, [normalizedSpreadsheet.cells, selectedCell]);

  const handleQueriesChange = useCallback(
    (newQueries: typeof queriesRef.current) => {
      queriesRef.current = newQueries;
      setQueriesVersion(v => v + 1);
    },
    [],
  );

  const updateDashboardWidgetMutation = useUpdateDashboardWidgetMutation();

  const onSaveWidgetName = async (newName: string) => {
    if (!widget) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            message: t('Cannot save: No widget available.'),
          },
        }),
      );
      return;
    }

    const name = newName || t('Formula');
    updateDashboardWidgetMutation.mutate({
      widget: {
        id: widget.id,
        meta: {
          ...(widget.meta ?? {}),
          name,
          formula,
          queries: queriesRef.current,
          fontSizeMode,
          staticFontSize,
          showTitle,
          colorFormula,
          spreadsheetMode,
          spreadsheet: normalizedSpreadsheet,
        },
      },
    });
  };

  async function onSaveWidget() {
    if (!widget) {
      dispatch(
        addNotification({
          notification: {
            type: 'error',
            message: t('Cannot save: No widget available.'),
          },
        }),
      );
      return;
    }

    updateDashboardWidgetMutation.mutate(
      {
        widget: {
          id: widget.id,
          meta: {
            ...(widget.meta ?? {}),
            formula,
            queries: queriesRef.current,
            fontSizeMode,
            staticFontSize,
            showTitle,
            colorFormula,
            spreadsheetMode,
            spreadsheet: normalizedSpreadsheet,
          },
        },
      },
      {
        onSuccess: () => {
          dispatch(
            addNotification({
              notification: {
                type: 'message',
                message: t('Dashboard widget successfully saved.'),
              },
            }),
          );
        },
      },
    );
  }

  const customColor =
    colorFormula && !colorError && colorResult ? String(colorResult) : null;
  const editorValue = spreadsheetMode
    ? normalizedSpreadsheet.cells[selectedCell.row]?.[selectedCell.col] || ''
    : formula;
  const styleFormulaValue = spreadsheetMode
    ? normalizedSpreadsheet.cellColorFormulas?.[selectedCellKey] || ''
    : colorFormula;
  const backgroundStyleFormulaValue =
    normalizedSpreadsheet.cellBackgroundColorFormulas?.[selectedCellKey] || '';
  const styleVariables = spreadsheetMode
    ? {
        RESULT:
          typeof selectedCellResult === 'boolean'
            ? String(selectedCellResult)
            : (selectedCellResult ?? 0),
        ...themeVariables,
      }
    : colorVariables;

  function handleSpreadsheetModeToggle(isOn: boolean) {
    if (isOn && !spreadsheetMode && !widget?.meta?.spreadsheet) {
      setSpreadsheet(
        createDefaultFormulaSpreadsheet({
          formula,
          colorFormula,
        }),
      );
      setSelectedCell({ row: 0, col: 0 });
      setSpreadsheetSelection({
        start: { row: 0, col: 0 },
        end: { row: 0, col: 0 },
      });
    }

    setSpreadsheetMode(isOn);
  }

  function handleEditorChange(value: string) {
    if (spreadsheetMode) {
      setSpreadsheet(current =>
        setFormulaSpreadsheetCell(current, selectedCell, value),
      );
    } else {
      setFormula(value);
    }
  }

  function handleStyleFormulaChange(value: string) {
    if (spreadsheetMode) {
      setSpreadsheet(current =>
        setFormulaSpreadsheetCellColorFormula(current, selectedCell, value),
      );
    } else {
      setColorFormula(value);
    }
  }

  function handleBackgroundStyleFormulaChange(value: string) {
    setSpreadsheet(current =>
      setFormulaSpreadsheetCellBackgroundColorFormula(
        current,
        selectedCell,
        value,
      ),
    );
  }

  return (
    <Page
      header={
        isNarrowWidth ? (
          <MobilePageHeader
            title={title}
            leftContent={
              <MobileBackButton onPress={() => navigate('/reports')} />
            }
          />
        ) : (
          <PageHeader
            title={
              widget ? (
                <EditablePageHeaderTitle
                  title={title}
                  onSave={onSaveWidgetName}
                />
              ) : (
                title
              )
            }
          />
        )
      }
      padding={0}
      style={{
        overflowY: 'auto',
      }}
    >
      {widget && (
        <View
          style={{
            padding: 20,
            display: 'flex',
            justifyContent: 'flex-end',
            flexDirection: 'row',
            background: theme.pageBackground,
          }}
        >
          <Button
            variant="primary"
            onPress={onSaveWidget}
            style={{ width: 100 }}
          >
            <Trans>Save widget</Trans>
          </Button>
        </View>
      )}
      <View
        style={{
          width: '100%',
          minHeight: '100%',
          background: theme.pageBackground,
          display: 'flex',
          flexDirection: 'row',
        }}
      >
        <View
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}
        >
          <View
            style={{
              padding: 20,
              paddingBottom: 0,
              flexDirection: 'row',
              gap: 30,
              alignItems: 'flex-start',
            }}
          >
            <View>
              <View
                style={{
                  fontSize: 13,
                  color: theme.pageTextSubdued,
                  marginBottom: 5,
                }}
              >
                <label htmlFor="formula-show-title">
                  <Trans>Show title:</Trans>
                </label>
              </View>
              <Toggle
                id="formula-show-title"
                isOn={showTitle}
                onToggle={setShowTitle}
              />
            </View>
            <View>
              <View
                style={{
                  fontSize: 13,
                  color: theme.pageTextSubdued,
                  marginBottom: 5,
                }}
              >
                <label htmlFor="formula-spreadsheet-mode">
                  <Trans>Spreadsheet mode:</Trans>
                </label>
              </View>
              <Toggle
                id="formula-spreadsheet-mode"
                isOn={spreadsheetMode}
                onToggle={handleSpreadsheetModeToggle}
              />
            </View>
          </View>
          {spreadsheetMode && (
            <View
              style={{
                padding: 20,
                paddingBottom: 0,
                maxWidth: '100%',
                overflowX: 'auto',
                ...styles.horizontalScrollbar,
              }}
            >
              <FormulaSpreadsheet
                spreadsheet={normalizedSpreadsheet}
                values={spreadsheetResult.values}
                errors={spreadsheetResult.errors}
                cellColors={cellColors}
                cellBackgroundColors={cellBackgroundColors}
                selectedCell={selectedCell}
                selection={spreadsheetSelection}
                onSpreadsheetChange={setSpreadsheet}
                onSelectedCellChange={cell => {
                  setSelectedCell(cell);
                  setSpreadsheetSelection({ start: cell, end: cell });
                }}
                onSelectionChange={setSpreadsheetSelection}
              />
            </View>
          )}
          {!spreadsheetMode && (
            <View
              style={{
                padding: 20,
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: 10,
                minHeight: 120,
              }}
            >
              <View
                style={{
                  fontSize: 14,
                  color: theme.pageTextSubdued,
                }}
              >
                <Trans>Result:</Trans>
              </View>
              <View
                style={{
                  height: 120,
                  width: '100%',
                  overflow: 'auto',
                  backgroundColor: theme.cardBackground,
                  borderRadius: 6,
                  ...styles.horizontalScrollbar,
                  '::-webkit-scrollbar': {
                    height: '8px',
                  },
                }}
              >
                <FormulaResult
                  value={result}
                  error={error}
                  loading={isExecuting}
                  fontSizeMode={fontSizeMode}
                  staticFontSize={staticFontSize}
                  customColor={customColor}
                />
              </View>
            </View>
          )}
          <View
            style={{
              minHeight: 110,
              margin: 20,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                fontSize: 13,
                color: theme.pageTextSubdued,
                marginBottom: 5,
              }}
            >
              <Trans>Formula:</Trans>
            </View>
            <Suspense
              fallback={<View style={{ padding: 10 }}>Loading...</View>}
            >
              <FormulaEditor
                value={editorValue}
                onChange={handleEditorChange}
                mode="query"
                queries={queriesRef.current}
                singleLine={false}
                showLineNumbers
                minHeight="110px"
              />
            </Suspense>
          </View>
          <View
            style={{
              padding: '0 20px 20px 20px',
              display: 'flex',
              flexDirection: 'row',
              gap: 20,
              alignItems: 'flex-end',
            }}
          >
            <View>
              <View
                style={{
                  fontSize: 13,
                  color: theme.pageTextSubdued,
                  marginBottom: 5,
                }}
              >
                <Trans>Font size:</Trans>
              </View>
              <Select
                value={fontSizeMode}
                onChange={(value: 'dynamic' | 'static') =>
                  setFontSizeMode(value)
                }
                options={[
                  ['dynamic', t('Dynamic')],
                  ['static', t('Static')],
                ]}
              />
            </View>

            {fontSizeMode === 'static' && (
              <View>
                <View
                  style={{
                    fontSize: 13,
                    color: theme.pageTextSubdued,
                    marginBottom: 5,
                  }}
                >
                  <Trans>Font size (px):</Trans>
                </View>
                <Input
                  type="number"
                  value={String(staticFontSize)}
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    setStaticFontSize(Number(e.target.value))
                  }
                />
              </View>
            )}
          </View>
          <View
            style={{
              padding: 20,
              marginBottom: 20,
            }}
          >
            <View
              style={{
                fontSize: 13,
                color: theme.pageTextSubdued,
                marginBottom: 5,
              }}
            >
              <Trans>Conditional color (optional):</Trans>
            </View>
            <View
              style={{
                border: `1px solid ${theme.formInputBorder}`,
                borderRadius: 4,
                overflow: 'hidden',
                backgroundColor: theme.tableBackground,
              }}
            >
              <Suspense fallback={<View style={{ height: 32 }} />}>
                <FormulaEditor
                  value={styleFormulaValue}
                  variables={styleVariables}
                  onChange={handleStyleFormulaChange}
                  mode="query"
                  queries={queriesRef.current}
                  singleLine
                  showLineNumbers={false}
                />
              </Suspense>
            </View>
            {spreadsheetMode && (
              <>
                <View
                  style={{
                    fontSize: 13,
                    color: theme.pageTextSubdued,
                    marginBottom: 5,
                    marginTop: 12,
                  }}
                >
                  <Trans>Conditional background color (optional):</Trans>
                </View>
                <View
                  style={{
                    border: `1px solid ${theme.formInputBorder}`,
                    borderRadius: 4,
                    overflow: 'hidden',
                    backgroundColor: theme.tableBackground,
                  }}
                >
                  <Suspense fallback={<View style={{ height: 32 }} />}>
                    <FormulaEditor
                      value={backgroundStyleFormulaValue}
                      variables={styleVariables}
                      onChange={handleBackgroundStyleFormulaChange}
                      mode="query"
                      queries={queriesRef.current}
                      singleLine
                      showLineNumbers={false}
                    />
                  </Suspense>
                </View>
              </>
            )}
            <View
              style={{
                fontSize: 11,
                color: theme.pageTextSubdued,
                marginTop: 5,
              }}
            >
              <Trans>
                Formula that returns a color (e.g., &ldquo;red&rdquo;,
                &ldquo;#ff0000&rdquo;). Leave blank for default. Use RESULT
                variable to access the main formula result.
              </Trans>
            </View>
          </View>
        </View>

        <View
          style={{
            flexShrink: 0,
            overflowY: 'auto',
          }}
        >
          <QueryManager
            queries={queriesRef.current}
            onQueriesChange={handleQueriesChange}
          />
        </View>
      </View>
    </Page>
  );
}
