import React from 'react';

import { ActualPlugin } from './actualPlugin';
import { useDispatch } from 'react-redux';
import { pushModal } from 'loot-core/src/client/actions';
import { Button } from '../../../src/components/common/Button2'

export type ActualPluginEntry = (bridge: {
    React: typeof React,
    toolKit: { useDispatch: typeof useDispatch, pushModal: typeof pushModal }
}) => ActualPlugin;
