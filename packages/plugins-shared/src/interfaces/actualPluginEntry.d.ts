import React from 'react';

import { ActualPlugin } from './actualPlugin';
import { ActualPluginToolkit } from './toolkit';

export type ActualPluginEntry = (bridge: {
    React: typeof React,
    toolKit: ActualPluginToolkit
}) => ActualPlugin;
