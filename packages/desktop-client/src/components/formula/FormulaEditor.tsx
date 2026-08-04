import { useMemo } from 'react';

import { EditorView } from '@codemirror/view';
import CodeMirror, { EditorState } from '@uiw/react-codemirror';
import type { ReactCodeMirrorProps } from '@uiw/react-codemirror';

import { autocompleteTabAcceptHighest } from '#components/codemirror/autocompleteTabAccept';
import { useTheme } from '#style/theme';

import { excelFormulaExtension } from './codeMirror-excelLanguage';

type FormulaMode = 'transaction' | 'query';

type FormulaEditorProps = {
  value: string;
  onChange: (value: string) => void;
  mode: FormulaMode;
  height?: string;
  minHeight?: string;
  disabled?: boolean;
  queries?: Record<string, unknown>;
  variables?: Record<string, number | string>;
  singleLine?: boolean;
  showLineNumbers?: boolean;
};

export function FormulaEditor({
  value,
  onChange,
  mode,
  height = '100%',
  minHeight,
  disabled = false,
  queries,
  variables,
  singleLine = false,
  showLineNumbers = true,
}: FormulaEditorProps) {
  const [activeTheme] = useTheme();

  const isDarkTheme = useMemo(() => {
    if (activeTheme === 'dark' || activeTheme === 'midnight') {
      return true;
    }
    if (activeTheme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  }, [activeTheme]);

  const extensions = useMemo(
    () => [
      ...(singleLine
        ? [
            EditorView.theme({
              '&': {
                height: '32px',
              },
              '.cm-scroller': {
                scrollbarWidth: 'none',
              },
              '.cm-scroller::-webkit-scrollbar': {
                display: 'none',
              },
            }),
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
        : [EditorView.lineWrapping]),
      ...excelFormulaExtension(mode, queries, isDarkTheme, variables),
      EditorView.editable.of(!disabled),
      // Must come late + highest precedence so Tab accepts completion when the popup is open
      autocompleteTabAcceptHighest,
    ],
    [mode, queries, isDarkTheme, disabled, singleLine, variables],
  );

  const codeMirrorTheme: ReactCodeMirrorProps['theme'] = isDarkTheme
    ? 'dark'
    : 'light';

  return (
    <CodeMirror
      value={value}
      height={singleLine ? '32px' : height}
      minHeight={minHeight}
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
  );
}
