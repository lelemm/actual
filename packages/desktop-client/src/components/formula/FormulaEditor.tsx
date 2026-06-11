import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { styles } from '@actual-app/components/styles';
import { theme } from '@actual-app/components/theme';
import { EditorView } from '@codemirror/view';
import CodeMirror, { EditorState } from '@uiw/react-codemirror';
import type { ReactCodeMirrorProps } from '@uiw/react-codemirror';

import { autocompleteTabAcceptHighest } from '#components/codemirror/autocompleteTabAccept';
import { DateSelect } from '#components/select/DateSelect';
import { useDateFormat } from '#hooks/useDateFormat';
import { useTheme } from '#style/theme';

import {
  excelFormulaExtension,
  formatMonthYear,
} from './codeMirror-excelLanguage';
import type {
  FormulaMonthBadgeClick,
  FormulaReferenceBadgeClick,
  MonthYearFormat,
} from './codeMirror-excelLanguage';

type FormulaMode = 'transaction' | 'query' | 'budget';

type FormulaEditorProps = {
  value: string;
  onChange: (value: string) => void;
  mode: FormulaMode;
  height?: string;
  disabled?: boolean;
  queries?: Record<string, unknown>;
  variables?: Record<string, number | string>;
  categoryBadges?: Record<string, string>;
  singleLine?: boolean;
  showLineNumbers?: boolean;
};

type MonthPickerState = {
  view: FormulaMonthBadgeClick['view'];
  anchorRect: DOMRect;
  from: number;
  to: number;
  month: string;
  format: MonthYearFormat;
};

type ReferencePickerState = {
  view: FormulaReferenceBadgeClick['view'];
  anchorRect: DOMRect;
  from: number;
  to: number;
  referenceKey: string;
};

export function FormulaEditor({
  value,
  onChange,
  mode,
  height = '100%',
  disabled = false,
  queries,
  variables,
  categoryBadges,
  singleLine = false,
  showLineNumbers = true,
}: FormulaEditorProps) {
  const [activeTheme] = useTheme();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const [monthPicker, setMonthPicker] = useState<MonthPickerState | null>(null);
  const [referencePicker, setReferencePicker] =
    useState<ReferencePickerState | null>(null);
  const suppressBadgePickerUntilRef = useRef(0);

  const isDarkTheme = useMemo(() => {
    if (activeTheme === 'dark' || activeTheme === 'midnight') {
      return true;
    }
    if (activeTheme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  }, [activeTheme]);

  const openMonthPicker = useCallback((details: FormulaMonthBadgeClick) => {
    if (Date.now() < suppressBadgePickerUntilRef.current) {
      return;
    }
    setReferencePicker(null);
    setMonthPicker(details);
  }, []);

  const openReferencePicker = useCallback(
    (details: FormulaReferenceBadgeClick) => {
      if (Date.now() < suppressBadgePickerUntilRef.current) {
        return;
      }
      setMonthPicker(null);
      setReferencePicker(details);
    },
    [],
  );

  const closeMonthPicker = useCallback(() => {
    setMonthPicker(null);
  }, []);

  const closeReferencePicker = useCallback(() => {
    setReferencePicker(null);
  }, []);

  const applyMonthPickerValue = useCallback(
    (selectedDate: string) => {
      if (!monthPicker) return;
      const month = selectedDate.slice(0, 7);
      const replacement = `"${formatMonthYear(month, monthPicker.format)}"`;
      monthPicker.view.dispatch({
        changes: {
          from: monthPicker.from,
          to: monthPicker.to,
          insert: replacement,
        },
        selection: { anchor: monthPicker.from + replacement.length },
      });
      suppressBadgePickerUntilRef.current = Date.now() + 300;
      monthPicker.view.focus();
      setMonthPicker(null);
    },
    [monthPicker],
  );

  const applyReferencePickerValue = useCallback(
    (referenceKey: string) => {
      if (!referencePicker) return;
      const replacement = `"${referenceKey}"`;
      referencePicker.view.dispatch({
        changes: {
          from: referencePicker.from,
          to: referencePicker.to,
          insert: replacement,
        },
        selection: { anchor: referencePicker.from + replacement.length },
      });
      suppressBadgePickerUntilRef.current = Date.now() + 300;
      referencePicker.view.focus();
      setReferencePicker(null);
    },
    [referencePicker],
  );

  useEffect(() => {
    if (!monthPicker && !referencePicker) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMonthPicker();
        closeReferencePicker();
        (monthPicker ?? referencePicker)?.view.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeMonthPicker, closeReferencePicker, monthPicker, referencePicker]);

  const extensions = useMemo(
    () => [
      ...(singleLine
        ? [
            EditorState.transactionFilter.of(tr =>
              tr.newDoc.lines > 1
                ? [
                    tr,
                    {
                      changes: {
                        from: 0,
                        to: tr.newDoc.length,
                        insert: tr.newDoc.sliceString(0, undefined, ' '),
                      },
                      sequential: true,
                    },
                  ]
                : [tr],
            ),
          ]
        : []),
      ...excelFormulaExtension(
        mode,
        queries,
        isDarkTheme,
        variables,
        categoryBadges,
        openMonthPicker,
        openReferencePicker,
      ),
      EditorView.lineWrapping,
      EditorView.editable.of(!disabled),
      // Must come late + highest precedence so Tab accepts completion when the popup is open
      autocompleteTabAcceptHighest,
    ],
    [
      mode,
      queries,
      isDarkTheme,
      disabled,
      singleLine,
      variables,
      categoryBadges,
      openMonthPicker,
      openReferencePicker,
    ],
  );

  const codeMirrorTheme: ReactCodeMirrorProps['theme'] = isDarkTheme
    ? 'dark'
    : 'light';

  return (
    <>
      <CodeMirror
        value={value}
        height={height}
        theme={codeMirrorTheme}
        extensions={extensions}
        onChange={onChange}
        editable={!disabled}
        basicSetup={{
          lineNumbers: showLineNumbers,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: false,
        }}
        style={{
          fontSize: '14px',
          border: 'none',
        }}
      />
      {monthPicker && (
        <div
          style={{
            ...styles.popover,
            position: 'fixed',
            zIndex: 10000,
            top: monthPicker.anchorRect.bottom + 4,
            left: Math.min(
              monthPicker.anchorRect.left,
              window.innerWidth - 260,
            ),
            minWidth: 225,
          }}
          onMouseDown={event => {
            event.stopPropagation();
          }}
          onClick={event => event.stopPropagation()}
        >
          <DateSelect
            value={`${monthPicker.month}-01`}
            dateFormat={dateFormat}
            embedded
            isOpen
            onSelect={applyMonthPickerValue}
          />
        </div>
      )}
      {referencePicker && categoryBadges && (
        <div
          style={{
            ...styles.popover,
            position: 'fixed',
            zIndex: 10000,
            top: referencePicker.anchorRect.bottom + 4,
            left: Math.min(
              referencePicker.anchorRect.left,
              window.innerWidth - 280,
            ),
            minWidth: 240,
            maxWidth: 320,
            maxHeight: 260,
            overflowY: 'auto',
            padding: 4,
          }}
          onMouseDown={event => {
            event.stopPropagation();
          }}
          onClick={event => event.stopPropagation()}
        >
          {Object.entries(categoryBadges).map(([referenceKey, label]) => (
            <button
              key={referenceKey}
              type="button"
              onClick={() => applyReferencePickerValue(referenceKey)}
              style={{
                display: 'block',
                width: '100%',
                border: 0,
                borderRadius: 4,
                padding: '7px 8px',
                background:
                  referenceKey === referencePicker.referenceKey
                    ? theme.menuItemBackgroundHover
                    : 'transparent',
                color: theme.pageText,
                textAlign: 'left',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
