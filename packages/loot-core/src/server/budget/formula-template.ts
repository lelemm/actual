import {
  CellError,
  ErrorType,
  FunctionArgumentType,
  FunctionPlugin,
  HyperFormula,
} from 'hyperformula';
import enUS from 'hyperformula/i18n/languages/enUS';
import type { InterpreterState } from 'hyperformula/typings/interpreter/InterpreterState';
import type { ProcedureAst } from 'hyperformula/typings/parser';

import { logger } from '#platform/server/log';
import {
  CustomFunctionsPlugin,
  customFunctionsTranslations,
} from '#server/rules/customFunctions';
import type { FormulaQueryContext } from '#server/rules/customFunctions';
import * as sheet from '#server/sheet';
import * as monthUtils from '#shared/months';
import { amountToInteger, integerToAmount, safeNumber } from '#shared/util';
import type { CategoryEntity, CategoryGroupEntity } from '#types/models';

type BudgetFormulaDimension = 'budgeted' | 'spent' | 'balance' | 'goal';

type BudgetFormulaCustomContext = {
  budgetFormula?: BudgetFormulaContext;
};

if (!HyperFormula.getRegisteredLanguagesCodes().includes('enUS')) {
  HyperFormula.registerLanguage('enUS', enUS);
}

class BudgetFormulaFunctionsPlugin extends FunctionPlugin {
  private getBudgetFormulaContext(): BudgetFormulaContext | undefined {
    return (this.config.context as BudgetFormulaCustomContext | undefined)
      ?.budgetFormula;
  }

  private budgetValueFor(
    dimension: BudgetFormulaDimension,
    monthOrOffset?: string | number,
    categoryKey?: string,
  ): number | CellError {
    const context = this.getBudgetFormulaContext();
    if (!context) {
      return new CellError(ErrorType.VALUE, 'Missing budget formula context');
    }

    try {
      return integerToAmount(
        getBudgetValue({
          context,
          dimension,
          monthOrOffset,
          categoryKey,
        }),
        context.decimalPlaces,
      );
    } catch (err) {
      return new CellError(
        ErrorType.VALUE,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  budgetValue(ast: ProcedureAst, state: InterpreterState) {
    return this.runFunction(
      ast.args,
      state,
      this.metadata('BUDGET_VALUE'),
      (
        dimension: string,
        monthOrOffset?: string | number,
        categoryKey?: string,
      ) => {
        const normalizedDimension = normalizeDimension(dimension);
        if (!normalizedDimension) {
          return new CellError(
            ErrorType.VALUE,
            `Unknown budget value: ${dimension}`,
          );
        }
        return this.budgetValueFor(
          normalizedDimension,
          monthOrOffset,
          categoryKey,
        );
      },
    );
  }

  budgetedAt(ast: ProcedureAst, state: InterpreterState) {
    return this.runBudgetDimensionFunction(ast, state, 'budgeted');
  }

  spentAt(ast: ProcedureAst, state: InterpreterState) {
    return this.runBudgetDimensionFunction(ast, state, 'spent');
  }

  balanceAt(ast: ProcedureAst, state: InterpreterState) {
    return this.runBudgetDimensionFunction(ast, state, 'balance');
  }

  goalAt(ast: ProcedureAst, state: InterpreterState) {
    return this.runBudgetDimensionFunction(ast, state, 'goal');
  }

  private runBudgetDimensionFunction(
    ast: ProcedureAst,
    state: InterpreterState,
    dimension: BudgetFormulaDimension,
  ) {
    return this.runFunction(
      ast.args,
      state,
      this.metadata(`${dimension.toUpperCase()}_AT`),
      (monthOrOffset?: string | number, categoryKey?: string) =>
        this.budgetValueFor(dimension, monthOrOffset, categoryKey),
    );
  }
}

BudgetFormulaFunctionsPlugin.implementedFunctions = {
  BUDGET_VALUE: {
    method: 'budgetValue',
    parameters: [
      { argumentType: FunctionArgumentType.STRING },
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.STRING, optionalArg: true },
    ],
  },
  BUDGETED_AT: {
    method: 'budgetedAt',
    parameters: [
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.STRING, optionalArg: true },
    ],
  },
  SPENT_AT: {
    method: 'spentAt',
    parameters: [
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.STRING, optionalArg: true },
    ],
  },
  BALANCE_AT: {
    method: 'balanceAt',
    parameters: [
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.STRING, optionalArg: true },
    ],
  },
  GOAL_AT: {
    method: 'goalAt',
    parameters: [
      { argumentType: FunctionArgumentType.SCALAR, optionalArg: true },
      { argumentType: FunctionArgumentType.STRING, optionalArg: true },
    ],
  },
};

const budgetFormulaFunctionTranslations = {
  enUS: {
    BUDGET_VALUE: 'BUDGET_VALUE',
    BUDGETED_AT: 'BUDGETED_AT',
    SPENT_AT: 'SPENT_AT',
    BALANCE_AT: 'BALANCE_AT',
    GOAL_AT: 'GOAL_AT',
  },
};

HyperFormula.registerFunctionPlugin(
  CustomFunctionsPlugin,
  customFunctionsTranslations,
);
HyperFormula.registerFunctionPlugin(
  BudgetFormulaFunctionsPlugin,
  budgetFormulaFunctionTranslations,
);

export type BudgetFormulaContext = {
  month: string;
  category: CategoryEntity;
  budgeted: number;
  balance: number;
  carryover: boolean;
  availableFunds: number;
  toBudgetStart: number;
  decimalPlaces: number;
  categories: CategoryEntity[];
  categoryGroups: CategoryGroupEntity[];
};

function normalizeDimension(dimension: string): BudgetFormulaDimension | null {
  const normalized = dimension.toLowerCase().replaceAll(/[-_\s]/g, '');
  switch (normalized) {
    case 'budget':
    case 'budgeted':
      return 'budgeted';
    case 'spent':
    case 'activity':
      return 'spent';
    case 'balance':
    case 'leftover':
      return 'balance';
    case 'goal':
      return 'goal';
    default:
      return null;
  }
}

function resolveMonth(currentMonth: string, monthOrOffset?: string | number) {
  if (monthOrOffset === undefined || monthOrOffset === '') {
    return currentMonth;
  }
  if (typeof monthOrOffset === 'number') {
    return monthUtils.addMonths(currentMonth, Math.trunc(monthOrOffset));
  }

  const trimmed = monthOrOffset.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return monthUtils.addMonths(currentMonth, Number(trimmed));
  }
  if (monthUtils.isValidYearMonth(trimmed)) {
    return trimmed;
  }

  const monthYear = trimmed.match(/^(\d{1,2})-(\d{4})$/);
  if (monthYear) {
    const month = Number(monthYear[1]);
    if (month >= 1 && month <= 12) {
      return `${monthYear[2]}-${String(month).padStart(2, '0')}`;
    }
  }

  throw new Error(`Invalid budget formula month: ${monthOrOffset}`);
}

type BudgetFormulaReference =
  | { type: 'category'; id: string }
  | { type: 'category-group'; id: string };

function resolveBudgetReference(
  context: BudgetFormulaContext,
  categoryKey?: string,
): BudgetFormulaReference {
  if (!categoryKey || categoryKey.trim() === '') {
    return { type: 'category', id: context.category.id };
  }

  const trimmed = categoryKey.trim();
  if (trimmed.startsWith('category:')) {
    const categoryId = trimmed.slice('category:'.length);
    const category = context.categories.find(
      category => category.id === categoryId,
    );
    if (!category) {
      throw new Error(`Unknown budget formula category: ${categoryId}`);
    }
    return { type: 'category', id: category.id };
  }

  if (trimmed.startsWith('category-group:')) {
    const groupId = trimmed.slice('category-group:'.length);
    const group = context.categoryGroups.find(group => group.id === groupId);
    if (!group) {
      throw new Error(`Unknown budget formula category group: ${groupId}`);
    }
    return { type: 'category-group', id: group.id };
  }

  throw new Error(
    `Unknown budget formula reference: ${categoryKey}. Use category:<id> or category-group:<id>.`,
  );
}

function getBudgetValueForReference({
  month,
  dimension,
  reference,
}: {
  month: string;
  dimension: BudgetFormulaDimension;
  reference: BudgetFormulaReference;
}) {
  const field =
    reference.type === 'category'
      ? getCategoryField(reference.id, dimension)
      : getCategoryGroupField(reference.id, dimension);

  const value = sheet.getCell(monthUtils.sheetForMonth(month), field).value;
  return safeNumber(typeof value === 'number' ? value : 0);
}

function getCategoryField(
  categoryId: string,
  dimension: BudgetFormulaDimension,
) {
  switch (dimension) {
    case 'budgeted':
      return `budget-${categoryId}`;
    case 'spent':
      return `sum-amount-${categoryId}`;
    case 'balance':
      return `leftover-${categoryId}`;
    case 'goal':
      return `goal-${categoryId}`;
    default:
      throw new Error('Unknown budget formula value');
  }
}

function getCategoryGroupField(
  groupId: string,
  dimension: BudgetFormulaDimension,
) {
  switch (dimension) {
    case 'budgeted':
      return `group-budget-${groupId}`;
    case 'spent':
      return `group-sum-amount-${groupId}`;
    case 'balance':
      return `group-leftover-${groupId}`;
    case 'goal':
      throw new Error(
        'Budget formula category groups do not support goal values',
      );
    default:
      throw new Error('Unknown budget formula value');
  }
}

function getBudgetValue({
  context,
  dimension,
  monthOrOffset,
  categoryKey,
}: {
  context: BudgetFormulaContext;
  dimension: BudgetFormulaDimension;
  monthOrOffset?: string | number;
  categoryKey?: string;
}) {
  const month = resolveMonth(context.month, monthOrOffset);
  return getBudgetValueForReference({
    month,
    dimension,
    reference: resolveBudgetReference(context, categoryKey),
  });
}

export function evaluateBudgetFormulaValue(
  formula: string,
  context: BudgetFormulaContext,
): number {
  let hfInstance: ReturnType<typeof HyperFormula.buildEmpty> | null = null;

  if (!formula || !formula.startsWith('=')) {
    throw new Error('Formula must start with =');
  }

  try {
    const formulaQueryContext: Required<FormulaQueryContext> = {
      queryNames: new Set(),
      queryCountNames: new Set(),
      queryExtractCategoryNames: new Set(),
      queryExtractTimeframeStartNames: new Set(),
      queryExtractTimeframeEndNames: new Set(),
      budgetQueryRequests: new Map(),
      querySumPrefetch: new Map(),
      queryCountPrefetch: new Map(),
      queryExtractCategoriesPrefetch: new Map(),
      queryExtractTimeframeStartPrefetch: new Map(),
      queryExtractTimeframeEndPrefetch: new Map(),
      budgetQueryPrefetch: new Map(),
      budgetQueryErrors: new Map(),
    };

    hfInstance = HyperFormula.buildEmpty({
      licenseKey: 'gpl-v3',
      language: 'enUS',
      dateFormats: ['DD/MM/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD'],
      context: {
        formulaQuery: formulaQueryContext,
        budgetFormula: context,
      },
    });

    const sheetName = hfInstance.addSheet('Sheet1');
    const sheetId = hfInstance.getSheetId(sheetName);

    if (sheetId === undefined) {
      throw new Error('Failed to create sheet');
    }

    const namedExpressions: Record<string, number | string | boolean> = {
      MONTH: context.month,
      CATEGORY_ID: `category:${context.category.id}`,
      CATEGORY_NAME: context.category.name,
      BUDGETED: integerToAmount(context.budgeted, context.decimalPlaces),
      BALANCE: integerToAmount(context.balance, context.decimalPlaces),
      CARRYOVER: context.carryover,
      AVAILABLE_FUNDS: integerToAmount(
        context.availableFunds,
        context.decimalPlaces,
      ),
      TO_BUDGET_START: integerToAmount(
        context.toBudgetStart,
        context.decimalPlaces,
      ),
    };

    for (const [name, value] of Object.entries(namedExpressions)) {
      hfInstance.addNamedExpression(name, value);
    }

    hfInstance.setCellContents({ sheet: sheetId, col: 0, row: 0 }, [[formula]]);

    const cellValue = hfInstance.getCellValue({
      sheet: sheetId,
      col: 0,
      row: 0,
    });

    if (
      formulaQueryContext.queryNames.size > 0 ||
      formulaQueryContext.queryCountNames.size > 0 ||
      formulaQueryContext.queryExtractCategoryNames.size > 0 ||
      formulaQueryContext.queryExtractTimeframeStartNames.size > 0 ||
      formulaQueryContext.queryExtractTimeframeEndNames.size > 0 ||
      formulaQueryContext.budgetQueryRequests.size > 0
    ) {
      throw new Error(
        'Budget automation formulas do not support query functions yet',
      );
    }

    if (cellValue && typeof cellValue === 'object' && 'type' in cellValue) {
      const message =
        'message' in cellValue && typeof cellValue.message === 'string'
          ? cellValue.message
          : String(cellValue.type);
      throw new Error(`Formula error: ${message}`);
    }

    const numericValue =
      typeof cellValue === 'number'
        ? cellValue
        : Number.parseFloat(String(cellValue));

    if (Number.isNaN(numericValue)) {
      throw new Error(
        `Formula must produce a numeric value. Got: ${JSON.stringify(cellValue)}`,
      );
    }

    return numericValue;
  } catch (err) {
    logger.error('Budget formula execution error:', err);
    throw err;
  } finally {
    try {
      hfInstance?.destroy();
    } catch (err) {
      logger.error('Error destroying HyperFormula instance:', err);
    }
  }
}

export function evaluateBudgetFormula(
  formula: string,
  context: BudgetFormulaContext,
): number {
  return amountToInteger(
    evaluateBudgetFormulaValue(formula, context),
    context.decimalPlaces,
  );
}
