import React from 'react';

import { ActualPluginInitalized } from '../middleware';

import { ActualPlugin } from './actualPlugin';
import { ActualPluginToolkit } from './toolkit';

export type ActualPluginEntry = (bridge: {
  toolKit: ActualPluginToolkit;
}) => ActualPluginInitalized;
