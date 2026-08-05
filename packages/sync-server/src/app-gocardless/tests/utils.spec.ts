import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeRegExp } from '#app-gocardless/banks/util/escape-regexp';
import {
  amountToInteger,
  printIban,
  sortByBookingDateOrValueDate,
} from '#app-gocardless/utils';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    join(
      packageRoot,
      '..',
      '..',
      '..',
      'contract',
      'fixtures',
      'gocardless-utils-golden.json',
    ),
    'utf8',
  ),
);

describe('GoCardless utility golden fixture', () => {
  for (const { id, transactions, expectedIds } of fixture.sortCases) {
    it(id, () => {
      expect(
        sortByBookingDateOrValueDate(transactions).map(transaction =>
          String(Reflect.get(transaction, 'id')),
        ),
      ).toEqual(expectedIds);
    });
  }

  for (const { id, account, expected } of fixture.ibanCases) {
    it(id, () => {
      expect(printIban(account)).toBe(expected);
    });
  }

  for (const { id, input, expected } of fixture.amountCases) {
    it(id, () => {
      const amount = amountToInteger(input);
      expect(Object.is(amount, -0) ? 0 : amount).toBe(expected);
    });
  }

  for (const { id, input, typescriptEscaped } of fixture.escapeCases) {
    it(id, () => {
      expect(escapeRegExp(input)).toBe(typescriptEscaped);
    });
  }
});
