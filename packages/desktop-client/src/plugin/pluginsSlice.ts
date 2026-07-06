import { send } from '@actual-app/core/platform/client/connection';
import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

import { resetApp } from '#app/appSlice';
import { createAppAsyncThunk } from '#redux';

const sliceName = 'plugins';

export const getPluginFiles = createAppAsyncThunk(
  `${sliceName}/getPluginFiles`,
  async (args: { pluginUrl: string }) => {
    const result = await send('plugin-files', args);
    return result;
  },
);

type PluginFile = {
  name: string;
  content: string;
  type: 'file' | 'directory';
  path: string;
};

type PluginsState = {
  files: Record<string, PluginFile[]>;
  loading: {
    files: Record<string, boolean>;
  };
  errors: {
    files: Record<string, string | null>;
  };
};

const initialState: PluginsState = {
  files: {},
  loading: {
    files: {},
  },
  errors: {
    files: {},
  },
};

const pluginsSlice = createSlice({
  name: sliceName,
  initialState,
  reducers: {
    clearPluginFiles(state, action: PayloadAction<{ pluginUrl: string }>) {
      const { pluginUrl } = action.payload;
      delete state.files[pluginUrl];
      delete state.loading.files[pluginUrl];
      delete state.errors.files[pluginUrl];
    },
  },
  extraReducers: builder => {
    builder
      .addCase(resetApp, () => initialState)
      // Plugin files
      .addCase(getPluginFiles.pending, (state, action) => {
        const pluginUrl = action.meta.arg.pluginUrl;
        state.loading.files[pluginUrl] = true;
        state.errors.files[pluginUrl] = null;
      })
      .addCase(getPluginFiles.fulfilled, (state, action) => {
        const pluginUrl = action.meta.arg.pluginUrl;
        state.loading.files[pluginUrl] = false;
        state.files[pluginUrl] = action.payload as PluginFile[];
      })
      .addCase(getPluginFiles.rejected, (state, action) => {
        const pluginUrl = action.meta.arg.pluginUrl;
        state.loading.files[pluginUrl] = false;
        state.errors.files[pluginUrl] =
          action.error.message || 'Failed to load plugin files';
      });
  },
});

export const { name, reducer, getInitialState } = pluginsSlice;

export const actions = {
  ...pluginsSlice.actions,
  getPluginFiles,
};

export const { clearPluginFiles } = actions;
