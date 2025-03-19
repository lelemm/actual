import React from 'react';

import { ActualPluginToolkit } from './toolkit';
import { ActualPluginInitialized } from './actualPlugin';

export type ActualPluginEntry = (bridge: {
  toolKit: ActualPluginToolkit;
}) => ActualPluginInitialized;
