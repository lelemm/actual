import { readFileSync } from 'node:fs';

import { BankFactory, banks } from '#app-gocardless/bank-factory';
import type { IBank } from '#app-gocardless/banks/bank.interface';
import IntegrationBank from '#app-gocardless/banks/integration-bank';

const bankModuleFixture: unknown = JSON.parse(
  readFileSync(
    new URL('./fixtures/gocardless-bank-modules.json', import.meta.url),
    'utf8',
  ),
);

const bankModules = import.meta.glob<{ default: IBank }>(
  '../banks/*_*.{ts,js}',
  {
    eager: true,
  },
);
const bankModulePairs = Object.entries(bankModules).flatMap(
  ([path, module]) => {
    const moduleName = path.match(/\/([^/]+)\.(?:ts|js)$/)?.[1];
    return module.default.institutionIds.map(institutionId => [
      institutionId,
      moduleName,
    ]);
  },
);

describe('BankFactory', () => {
  beforeAll(() => {
    expect(bankModulePairs).toHaveLength(79);
    expect(
      new Set(bankModulePairs.map(([institutionId]) => institutionId)).size,
    ).toBe(79);
    expect(Object.fromEntries(bankModulePairs)).toEqual(bankModuleFixture);
  });

  it.each(banks.flatMap(bank => bank.institutionIds))(
    `should return same institutionId`,
    institutionId => {
      const result = BankFactory(institutionId);

      expect(result.institutionIds).toContain(institutionId);
    },
  );

  it('should return IntegrationBank when institutionId is not found', () => {
    const institutionId = IntegrationBank.institutionIds[0];
    const result = BankFactory('fake-id-not-found');

    expect(result.institutionIds).toContain(institutionId);
  });
});
