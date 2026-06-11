import type {
  AverageTemplate,
  ByTemplate,
  CopyTemplate,
  FormulaTemplate,
  GoalTemplate,
  LimitTemplate,
  PercentageTemplate,
  PeriodicTemplate,
  RefillTemplate,
  RemainderTemplate,
  ScheduleTemplate,
  SpendTemplate,
} from '@actual-app/core/types/models/templates';

export const displayTemplateTypes = [
  'fixed',
  'schedule',
  'by',
  'percentage',
  'historical',
  'formula',
  'limit',
  'refill',
  'remainder',
  'goal',
] as const;

export type DisplayTemplateType = (typeof displayTemplateTypes)[number];

export type ReducerState =
  | {
      template: LimitTemplate;
      displayType: 'limit';
    }
  | {
      template: RefillTemplate;
      displayType: 'refill';
    }
  | {
      template: PeriodicTemplate;
      displayType: 'fixed';
    }
  | {
      template: ScheduleTemplate;
      displayType: 'schedule';
    }
  | {
      template: PercentageTemplate;
      displayType: 'percentage';
    }
  | {
      template: CopyTemplate | AverageTemplate;
      displayType: 'historical';
    }
  | {
      template: ByTemplate | SpendTemplate;
      displayType: 'by';
    }
  | {
      template: FormulaTemplate;
      displayType: 'formula';
    }
  | {
      template: RemainderTemplate;
      displayType: 'remainder';
    }
  | {
      template: GoalTemplate;
      displayType: 'goal';
    };
