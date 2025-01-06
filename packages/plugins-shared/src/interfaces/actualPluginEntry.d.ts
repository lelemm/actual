import React from 'react';

import { ActualPlugin } from './actualPlugin';
import { ActualPluginToolkit } from './toolkit';
import { ActualPluginInitalized } from '../middleware';

export type ActualPluginEntry = (bridge: {
    toolKit: ActualPluginToolkit
}) => ActualPluginInitalized;
