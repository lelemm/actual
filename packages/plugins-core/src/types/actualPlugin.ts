import type { ReactElement } from 'react';

import type { i18n } from 'i18next';

import type { BasicModalProps } from './modalProps';

export type BankSyncProviderSetupCallProvider = (args: {
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
}) => Promise<unknown>;

export type BankSyncProviderSetupSetSecret = (args: {
  key: string;
  value: string | null;
}) => Promise<unknown>;

export type BankSyncProviderSetupRenderProps = {
  providerSlug: string;
  providerDisplayName: string;
  fileId: string;
  callProvider: BankSyncProviderSetupCallProvider;
  setSecret: BankSyncProviderSetupSetSecret;
  onSuccess: () => void;
  onError: (error: unknown) => void;
  close: () => void;
};

export type BankSyncProviderSetupRenderer = (
  props: BankSyncProviderSetupRenderProps,
) => ReactElement;

export type BankSyncProviderExternalAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  [key: string]: unknown;
};

export type BankSyncProviderLinkRenderProps = {
  providerSlug: string;
  providerDisplayName: string;
  fileId: string;
  upgradingAccountId?: string;
  callProvider: BankSyncProviderSetupCallProvider;
  openExternalUrl: (url: string) => void;
  selectExternalAccounts: (args: {
    externalAccounts: BankSyncProviderExternalAccount[];
    bankId?: string;
  }) => void;
  onSuccess: () => void;
  onError: (error: unknown) => void;
  close: () => void;
};

export type BankSyncProviderLinkRenderer = (
  props: BankSyncProviderLinkRenderProps,
) => ReactElement;

export type HostContext = {
  registerBankSyncProviderSetup: (
    providerSlug: string,
    renderSetup: (
      props: BankSyncProviderSetupRenderProps,
      container: HTMLDivElement,
    ) => void | (() => void),
    modalProps?: BasicModalProps,
  ) => () => void;
  registerBankSyncProviderLink: (
    providerSlug: string,
    renderLink: (
      props: BankSyncProviderLinkRenderProps,
      container: HTMLDivElement,
    ) => void | (() => void),
    modalProps?: BasicModalProps,
  ) => () => void;
  i18nInstance: i18n;
};

export type PluginContext = Pick<HostContext, 'i18nInstance'> & {
  registerBankSyncProviderSetup: (
    providerSlug: string,
    renderSetup: BankSyncProviderSetupRenderer,
    modalProps?: BasicModalProps,
  ) => () => void;
  registerBankSyncProviderLink: (
    providerSlug: string,
    renderLink: BankSyncProviderLinkRenderer,
    modalProps?: BasicModalProps,
  ) => () => void;
};

export type ActualPlugin = {
  name: string;
  version: string;
  activate: (context: PluginContext) => void;
  deactivate?: (context: PluginContext) => void;
  install?: (
    oldVersion: string,
    newVersion: string,
    context: PluginContext,
  ) => void;
  uninstall?: (context: PluginContext) => void;
};

export type ActualPluginInitialized = Omit<ActualPlugin, 'activate'> & {
  initialized: true;
  activate: (context: HostContext) => void;
};
