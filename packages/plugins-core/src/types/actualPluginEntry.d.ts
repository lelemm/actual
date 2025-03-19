import React from 'react';

import { ActualPlugin, ActualPluginInitalized } from './actualPlugin';
import { ActualPluginToolkit } from './toolkit';

export type ActualPluginEntry = (bridge: {
  toolKit: ActualPluginToolkit;
}) => ActualPluginInitalized;
