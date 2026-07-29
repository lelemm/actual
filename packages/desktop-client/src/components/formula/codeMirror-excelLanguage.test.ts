import { theme } from '@actual-app/components/theme';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import {
  excelFormulaExtension,
  getFormulaStringCompletionEdit,
} from './codeMirror-excelLanguage';

describe('getFormulaStringCompletionEdit', () => {
  it('completes formula string values with or without existing quotes', () => {
    expect(
      getFormulaStringCompletionEdit({
        value: 'spent',
        hasOpeningQuote: false,
        hasClosingQuote: false,
      }),
    ).toEqual({ text: '"spent"', offsetClosingQuote: 0 });

    expect(
      getFormulaStringCompletionEdit({
        value: 'spent',
        hasOpeningQuote: true,
        hasClosingQuote: false,
      }),
    ).toEqual({ text: 'spent"', offsetClosingQuote: 0 });

    expect(
      getFormulaStringCompletionEdit({
        value: 'spent',
        hasOpeningQuote: true,
        hasClosingQuote: true,
      }),
    ).toEqual({ text: 'spent"', offsetClosingQuote: 1 });
  });

  it('renders and edits a quoted REGEXREPLACE pattern as regex syntax', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onBadgeClick = vi.fn();
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: '=REGEXREPLACE("replace_me", "/me/g")',
        extensions: [
          keymap.of([{ key: 'ArrowRight', run: () => true }]),
          excelFormulaExtension(
            'transaction',
            undefined,
            undefined,
            undefined,
            onBadgeClick,
          ),
        ],
      }),
    });

    try {
      const patternInput = container.querySelector(
        '[aria-label="Regular expression pattern"]',
      );
      const flagsButton = container.querySelector(
        '[aria-label="Regular expression flags"]',
      );
      const widget = container.querySelector('.cm-regex-widget');
      if (
        !(patternInput instanceof HTMLInputElement) ||
        !(flagsButton instanceof HTMLButtonElement) ||
        !(widget instanceof HTMLElement)
      ) {
        throw new Error('Expected regex widget');
      }

      expect(patternInput).toHaveValue('me');
      expect(flagsButton).toHaveTextContent('g');
      expect(widget.style.color).toBe(theme.formInputBorderSelected);
      expect(widget.style.marginRight).toBe('6px');
      expect(patternInput.style.outline).toBe('none');
      expect(patternInput.style.textAlign).toBe('center');
      expect(flagsButton.style.padding).toBe('0px 3px');
      expect(patternInput.style.width).toBe('calc(2ch + 10px)');
      expect(flagsButton.style.width).toBe('calc(1ch + 10px)');

      flagsButton.click();
      expect(onBadgeClick).toHaveBeenCalledWith(
        expect.objectContaining({ label: '/me/g', variant: 'regex' }),
      );

      const firstArgument = '"replace_me"';
      const firstArgumentFrom = view.state.doc
        .toString()
        .indexOf(firstArgument);
      view.dispatch({
        changes: {
          from: firstArgumentFrom,
          to: firstArgumentFrom + firstArgument.length,
          insert: 'notes',
        },
      });

      patternInput.value = 'you';
      patternInput.dispatchEvent(new Event('input', { bubbles: true }));
      expect(view.state.doc.toString()).toBe('=REGEXREPLACE(notes, "/you/g")');
      expect(patternInput.style.width).toBe('calc(3ch + 10px)');

      const regexText = '"/you/g"';
      const regexFrom = view.state.doc.toString().indexOf(regexText);
      const regexTo = regexFrom + regexText.length;
      view.dispatch({ selection: { anchor: regexFrom } });
      view.focus();
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(patternInput).toHaveFocus();
      expect(patternInput.selectionStart).toBe(0);

      patternInput.setSelectionRange(
        patternInput.value.length,
        patternInput.value.length,
      );
      patternInput.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(flagsButton).toHaveFocus();

      flagsButton.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(view.hasFocus).toBe(true);
      expect(view.state.selection.main.head).toBe(regexTo);

      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(flagsButton).toHaveFocus();

      view.dispatch({
        changes: { from: regexFrom, to: regexTo, insert: '""' },
        selection: { anchor: regexFrom + 1 },
      });
      expect(view.state.doc.toString()).toBe('=REGEXREPLACE(notes, "//g")');
      expect(
        container.querySelector('[aria-label="Regular expression pattern"]'),
      ).toBeInstanceOf(HTMLInputElement);
    } finally {
      view.destroy();
      container.remove();
    }
  });
});
